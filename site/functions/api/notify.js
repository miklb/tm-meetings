function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTitle(type, dateStr) {
  const TYPE_LABELS = {
    regular: 'City Council',
    evening: 'Evening Session',
    cra: 'CRA',
    workshop: 'Workshop',
    special: 'Special Meeting',
  };
  const label = TYPE_LABELS[type] || type;
  if (!dateStr) return label;
  try {
    const d = new Date(dateStr + 'T12:00:00');
    if (!isNaN(d.getTime())) {
      return `${label} — ${d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}`;
    }
  } catch (e) {}
  return `${label} — ${dateStr}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    return new Response(JSON.stringify({ error: "Database binding missing." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 1. Verify Webhook Secret
  const secret = env.WEBHOOK_SECRET;
  const receivedSecret = request.headers.get("X-Webhook-Secret");
  if (secret && receivedSecret !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 2. Parse payload
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!payload || !payload.meetings || !Array.isArray(payload.meetings) || payload.meetings.length === 0) {
    return new Response(JSON.stringify({ success: true, message: "No meetings found in payload to process." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 3. Fetch verified subscribers, supporter status, and beta testers in a single query
  let subscribers;
  try {
    const query = `
      SELECT 
        s.id AS sub_id, 
        s.email, 
        s.unsubscribe_token,
        sup.email AS supporter_email,
        sup.active_until AS supporter_active_until,
        CASE WHEN bt.email IS NOT NULL THEN 1 ELSE 0 END AS is_beta_tester
      FROM subscriptions s
      LEFT JOIN supporters sup ON s.email = sup.email
      LEFT JOIN beta_testers bt ON s.email = bt.email
      WHERE s.verified = 1
    `;
    const { results } = await db.prepare(query).all();
    subscribers = results || [];
  } catch (err) {
    return new Response(JSON.stringify({ error: `Database subscribers read failed: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (subscribers.length === 0) {
    return new Response(JSON.stringify({ success: true, message: "No verified subscribers found." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 4. Apply registration modes & keyword limit filters
  const regMode = env.REGISTRATION_MODE || 'SUPPORTERS_ONLY';
  const now = new Date();
  const allowedSubscribers = [];
  const subscriberMap = new Map();

  for (const row of subscribers) {
    const hasSupporterRow = row.supporter_email !== null;
    const isSupporter = hasSupporterRow && (
      row.supporter_active_until === null || 
      new Date(row.supporter_active_until) > now
    );
    const isBetaTester = row.is_beta_tester === 1;

    let isAllowed = false;
    let keywordLimit = 3;

    if (isSupporter) {
      isAllowed = true;
      keywordLimit = 15;
    }

    if (!isAllowed) {
      if (regMode === 'PUBLIC') {
        isAllowed = true;
        keywordLimit = 3;
      } else if (regMode === 'BETA_AND_SUPPORTERS' || regMode === 'SUPPORTERS_ONLY') {
        if (isBetaTester) {
          isAllowed = true;
          keywordLimit = 15;
        }
      }
    }

    if (isAllowed) {
      const subInfo = {
        subId: row.sub_id,
        email: row.email.trim().toLowerCase(),
        unsubscribeToken: row.unsubscribe_token,
        limit: keywordLimit
      };
      allowedSubscribers.push(subInfo);
      subscriberMap.set(row.sub_id, subInfo);
    }
  }

  if (allowedSubscribers.length === 0) {
    return new Response(JSON.stringify({ success: true, message: "No active subscribers meet registration mode requirements." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 5. Fetch and filter keywords for allowed subscribers
  let keywordRows;
  try {
    const { results } = await db.prepare(
      'SELECT id, subscription_id, keyword, match_type FROM keywords ORDER BY id ASC'
    ).all();
    keywordRows = results || [];
  } catch (err) {
    return new Response(JSON.stringify({ error: `Database keywords read failed: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const keywordsBySubId = {};
  for (const kw of keywordRows) {
    const subId = kw.subscription_id;
    if (!keywordsBySubId[subId]) {
      keywordsBySubId[subId] = [];
    }
    keywordsBySubId[subId].push(kw);
  }

  const activeKeywords = [];
  const keywordToSubscribers = {};

  for (const sub of allowedSubscribers) {
    const subKeywords = keywordsBySubId[sub.subId] || [];
    const limitedKeywords = subKeywords.slice(0, sub.limit);

    for (const kw of limitedKeywords) {
      const normKeyword = kw.keyword.trim().toLowerCase();
      const key = `${kw.match_type}:${normKeyword}`;
      if (!keywordToSubscribers[key]) {
        keywordToSubscribers[key] = new Set();
      }
      keywordToSubscribers[key].add(sub.email);

      activeKeywords.push({
        keyword: normKeyword,
        matchType: kw.match_type
      });
    }
  }

  if (activeKeywords.length === 0) {
    return new Response(JSON.stringify({ success: true, message: "No active keywords found to match." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 6. Compile Regex Engines
  const containsKeywords = [...new Set(
    activeKeywords.filter(k => k.matchType === 'contains').map(k => k.keyword)
  )];
  const exactKeywords = [...new Set(
    activeKeywords.filter(k => k.matchType === 'exact_phrase').map(k => k.keyword)
  )];
  const fileNumKeywords = [...new Set(
    activeKeywords.filter(k => k.matchType === 'file_number').map(k => k.keyword)
  )];

  const containsRegex = containsKeywords.length > 0
    ? new RegExp(containsKeywords.map(escapeRegExp).join('|'), 'gi')
    : null;

  const exactRegex = exactKeywords.length > 0
    ? new RegExp(`\\b(${exactKeywords.map(escapeRegExp).join('|')})\\b`, 'gi')
    : null;

  // 7. Check for duplicate notifications in notification_log
  const itemIds = [];
  for (const meeting of payload.meetings) {
    for (const item of meeting.agendaItems || []) {
      if (item.agendaItemId) {
        itemIds.push(item.agendaItemId);
      }
    }
  }

  const sentSet = new Set();
  if (itemIds.length > 0) {
    try {
      const placeholders = itemIds.map(() => '?').join(',');
      const query = `SELECT subscription_id, agenda_item_id, keyword_matched FROM notification_log WHERE agenda_item_id IN (${placeholders})`;
      const { results } = await db.prepare(query).bind(...itemIds).all();
      for (const log of results || []) {
        sentSet.add(`${log.subscription_id}:${log.agenda_item_id}:${log.keyword_matched}`);
      }
    } catch (err) {
      console.error(`Failed to read notification log: ${err.message}`);
    }
  }

  // 8. Run matching engine
  const subscriberDigests = {};
  const newNotificationLogs = [];

  for (const meeting of payload.meetings) {
    const meetingId = meeting.meetingId;
    const meetingDate = meeting.meetingDate || '';
    const meetingType = meeting.meetingType || 'regular';
    const meetingTitle = meeting.meetingTitle || meeting.title || buildTitle(meetingType, meetingDate);
    const meetingWordpressUrl = meeting.wordpressUrl || null;

    for (const item of meeting.agendaItems || []) {
      const agendaItemId = item.agendaItemId;
      const fileNumber = item.fileNumber || '';
      const itemTitle = item.title || '';
      const background = item.background || '';
      const docTitles = (item.supportingDocuments || []).map(d => d.title || '');

      // Extract and concatenate staff report fields for matching
      const staffReportText = item.staffReport ? [
        item.staffReport.currentZoning || '',
        item.staffReport.requestedZoning || '',
        item.staffReport.futureLandUse || '',
        item.staffReport.overlayDistrict || '',
        ...(item.staffReport.neighborhoodAssociations || []),
        ...(item.staffReport.waivers || []),
        item.staffReport.findings || ''
      ].join(' ') : '';

      const searchableText = [
        itemTitle,
        background,
        fileNumber,
        ...docTitles,
        staffReportText
      ].join(' ').toLowerCase();

      const matchedKeys = new Set();

      // A. Contains match
      if (containsRegex) {
        const matches = searchableText.match(containsRegex) || [];
        for (const m of matches) {
          matchedKeys.add(`contains:${m}`);
        }
      }

      // B. Exact phrase match
      if (exactRegex) {
        const matches = searchableText.match(exactRegex) || [];
        for (const m of matches) {
          matchedKeys.add(`exact_phrase:${m}`);
        }
      }

      // C. File number match (exact, since keywords are stored as complete file numbers)
      if (fileNumber) {
        const fileNumLower = fileNumber.toLowerCase();
        for (const kw of fileNumKeywords) {
          if (fileNumLower === kw) {
            matchedKeys.add(`file_number:${kw}`);
          }
        }
      }

      if (matchedKeys.size > 0) {
        for (const matchKey of matchedKeys) {
          const subscribers = keywordToSubscribers[matchKey];
          if (!subscribers) continue;

          const [matchType, keyword] = matchKey.split(':');

          for (const email of subscribers) {
            const sub = allowedSubscribers.find(s => s.email === email);
            if (!sub) continue;

            const sentKey = `${sub.subId}:${agendaItemId}:${keyword}`;
            if (sentSet.has(sentKey)) {
              continue; // skip duplicate
            }

            newNotificationLogs.push({
              subscriptionId: sub.subId,
              meetingId,
              agendaItemId,
              keyword
            });

            if (!subscriberDigests[email]) {
              subscriberDigests[email] = {
                subInfo: sub,
                meetings: {}
              };
            }

            if (!subscriberDigests[email].meetings[meetingId]) {
              subscriberDigests[email].meetings[meetingId] = {
                meetingId,
                meetingDate,
                meetingType,
                meetingTitle,
                wordpressUrl: meetingWordpressUrl,
                items: {}
              };
            }

            if (!subscriberDigests[email].meetings[meetingId].items[agendaItemId]) {
              subscriberDigests[email].meetings[meetingId].items[agendaItemId] = {
                agendaItemId,
                itemNumber: item.number || '',
                fileNumber,
                title: itemTitle,
                background,
                matchedKeywords: new Set()
              };
            }

            subscriberDigests[email].meetings[meetingId].items[agendaItemId].matchedKeywords.add(keyword);
          }
        }
      }
    }
  }

  // 9. Generate emails
  const emailsToSend = [];
  const url = new URL(request.url);
  const origin = url.origin;

  // Sponsor slot — rendered when both image and link env vars are set
  const sponsorImageUrl = env.SPONSOR_IMAGE_URL || '';
  const sponsorLinkUrl = env.SPONSOR_LINK_URL || '';
  const sponsorAltText = env.SPONSOR_ALT_TEXT || 'Our Sponsor';
  const hasSponsor = sponsorImageUrl && sponsorLinkUrl;

  const sponsorHtml = hasSponsor ? `
    <tr>
      <td style="padding: 0 0 28px 0; text-align: center;">
        <a href="${sponsorLinkUrl}" target="_blank" rel="noopener sponsored" style="display: block;">
          <img src="${sponsorImageUrl}" alt="${sponsorAltText}" width="560" style="display: block; width: 100%; max-width: 560px; height: auto; border: 0; margin: 0 auto;" />
        </a>
      </td>
    </tr>` : '';

  const sponsorText = hasSponsor ? `${sponsorAltText}: ${sponsorLinkUrl}\n\n` : '';

  for (const [email, digest] of Object.entries(subscriberDigests)) {
    const { subInfo, meetings } = digest;
    const unsubscribeUrl = `${origin}/api/unsubscribe?token=${subInfo.unsubscribeToken}`;

    // Use first meeting's date in the subject line
    const firstMeet = Object.values(meetings)[0];
    const subjectDate = firstMeet?.meetingDate || '';
    const subject = subjectDate
      ? `Tampa Monitor: New agenda matches — ${subjectDate}`
      : `Tampa Monitor: New agenda matches`;

    let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin: 0 auto;">

  <tr>
    <td style="border-bottom: 2px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 0;">
      <span style="color: #1d4ed8; font-size: 22px; font-weight: 800; letter-spacing: -0.025em;">Tampa Monitor</span>
      <span style="color: #6b7280; font-size: 13px; display: block; margin-top: 2px;">Tampa City Council Agenda Alerts</span>
    </td>
  </tr>

  ${sponsorHtml}

  <tr>
    <td style="padding: 24px 0 8px 0;">
      <p style="margin: 0; font-size: 15px; line-height: 1.5; color: #374151;">
        New agenda items match your tracked keywords.
      </p>
    </td>
  </tr>
`;

    let text = `Tampa Monitor — Tampa City Council Agenda Alerts\n`;
    if (hasSponsor) text += `\n${sponsorText}`;
    text += `\nNew agenda items match your tracked keywords.\n`;

    for (const meet of Object.values(meetings)) {
      const agendaLink = meet.wordpressUrl || `${origin}/meetings/${meet.meetingId}/`;

      html += `
  <tr>
    <td style="padding: 20px 0 0 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
        <tr>
          <td style="padding: 16px 16px 0 16px;">
            <p style="margin: 0 0 12px 0; font-size: 17px; font-weight: 700; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px;">
              ${meet.meetingTitle}
            </p>
          </td>
        </tr>`;

      text += `\n=== ${meet.meetingTitle} ===\n\n`;

      const itemList = Object.values(meet.items);
      itemList.forEach((item, idx) => {
        const isLast = idx === itemList.length - 1;
        const itemUrl = meet.wordpressUrl
          ? `${meet.wordpressUrl}#item-${item.fileNumber || item.agendaItemId}`
          : `${origin}/meetings/${meet.meetingId}/#item-${item.agendaItemId}`;
        const kwList = Array.from(item.matchedKeywords).join(', ');
        const itemBorder = isLast ? '' : 'border-bottom: 1px dashed #e5e7eb;';

        html += `
        <tr>
          <td style="padding: 12px 16px; ${itemBorder}">
            <p style="margin: 0 0 3px 0; font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">
              Item ${item.itemNumber}${item.fileNumber ? ` &middot; ${item.fileNumber}` : ''}
            </p>
            <p style="margin: 0 0 8px 0; font-size: 15px; line-height: 1.4; color: #111827; font-weight: 500;">${item.title}</p>
            <p style="margin: 0 0 8px 0;">
              <span style="background-color: #dbeafe; color: #1e40af; font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 9999px; display: inline-block;">
                Matched: ${kwList}
              </span>
            </p>
            <a href="${itemUrl}" style="color: #1d4ed8; font-size: 13px; font-weight: 600; text-decoration: none;">View item &rarr;</a>
          </td>
        </tr>`;

        text += `Item ${item.itemNumber}${item.fileNumber ? ` (${item.fileNumber})` : ''}\n`;
        text += `${item.title}\n`;
        text += `Matched: ${kwList}\n`;
        text += `Link: ${itemUrl}\n\n`;
      });

      html += `
        <tr>
          <td style="padding: 12px 16px 14px 16px; border-top: 1px solid #e5e7eb;">
            <a href="${agendaLink}" style="color: #1d4ed8; font-size: 13px; font-weight: 600; text-decoration: none;">View full agenda &rarr;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

      text += `Full agenda: ${agendaLink}\n`;
    }

    html += `
  <tr>
    <td style="padding: 32px 0 0 0; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; line-height: 1.6;">
      <p style="margin: 0 0 6px 0;">You subscribed to keyword alerts on <a href="${origin}" style="color: #9ca3af;">Tampa Monitor</a>.</p>
      <p style="margin: 0 0 6px 0;">Please do not forward this email — the unsubscribe link below is unique to your inbox.</p>
      <p style="margin: 0;">
        <a href="${origin}/notifications/" style="color: #6b7280; text-decoration: underline;">Manage keywords</a>
        &nbsp;&middot;&nbsp;
        <a href="${unsubscribeUrl}" style="color: #6b7280; text-decoration: underline;">Unsubscribe</a>
      </p>
    </td>
  </tr>

</table>
</div>`;

    text += `\n---\nYou subscribed to keyword alerts on Tampa Monitor.\n`;
    text += `Please do not forward this email — the unsubscribe link is unique to your inbox.\n`;
    text += `Manage keywords: ${origin}/notifications/\n`;
    text += `Unsubscribe: ${unsubscribeUrl}\n`;

    emailsToSend.push({
      from: "Tampa Monitor <notifications@tampamonitor.com>",
      to: email,
      subject,
      html,
      text
    });
  }

  // 10. Dispatch emails via Resend API or log them locally
  const resendApiKey = env.RESEND_API_KEY;
  const devEmails = [];

  if (emailsToSend.length > 0) {
    if (resendApiKey) {
      try {
        const batches = [];
        for (let i = 0; i < emailsToSend.length; i += 100) {
          batches.push(emailsToSend.slice(i, i + 100));
        }

        for (const batch of batches) {
          const endpoint = batch.length === 1 
            ? "https://api.resend.com/emails" 
            : "https://api.resend.com/emails/batch";
          const body = batch.length === 1 ? batch[0] : batch;

          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Resend API request failed: ${errText}`);
          }
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: `Email dispatch failed: ${err.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    } else {
      console.log(`\n=== [LOCAL DEV - NOTIFICATIONS EMAIL MOCK] ===`);
      console.log(`No RESEND_API_KEY configured. Mocking ${emailsToSend.length} email(s):\n`);
      for (const email of emailsToSend) {
        console.log(`-----------------------------------------`);
        console.log(`To: ${email.to}`);
        console.log(`Subject: ${email.subject}`);
        console.log(`Body (Text):\n${email.text}`);
        console.log(`-----------------------------------------`);

        devEmails.push({
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html
        });
      }
      console.log(`=============================================\n`);
    }

    // 11. Write to notification_log
    if (newNotificationLogs.length > 0) {
      try {
        const insertStatements = newNotificationLogs.map(log => 
          db.prepare(`
            INSERT INTO notification_log (subscription_id, meeting_id, agenda_item_id, keyword_matched)
            VALUES (?, ?, ?, ?)
          `).bind(log.subscriptionId, log.meetingId, log.agendaItemId, log.keyword)
        );
        await db.batch(insertStatements);
      } catch (err) {
        console.error(`Failed to write notification logs to D1: ${err.message}`);
        // Do not crash the response since emails have been dispatched or mocked
      }
    }
  }

  const responsePayload = {
    success: true,
    sentCount: emailsToSend.length,
    matchesLogged: newNotificationLogs.length
  };

  if (!resendApiKey) {
    responsePayload.devEmails = devEmails;
  }

  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
