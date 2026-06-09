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

  for (const [email, digest] of Object.entries(subscriberDigests)) {
    const { subInfo, meetings } = digest;
    const manageUrl = `${origin}/notifications/?email=${encodeURIComponent(email)}&token=${subInfo.unsubscribeToken}`;
    const unsubscribeUrl = `${origin}/api/unsubscribe?token=${subInfo.unsubscribeToken}`;

    let html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
        <header style="border-bottom: 2px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 24px;">
          <h2 style="color: #1d4ed8; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.025em;">Tampa Monitor</h2>
          <p style="margin: 4px 0 0 0; color: #6b7280; font-size: 14px;">Tampa City Council Agenda Alerts</p>
        </header>
        
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 20px;">We found new agenda items matching your tracked keywords on Tampa City Council meetings.</p>
    `;

    let text = `Tampa Monitor — Tampa City Council Agenda Alerts\n\nWe found new agenda items matching your tracked keywords.\n\n`;

    for (const meet of Object.values(meetings)) {
      html += `
        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin-top: 0; margin-bottom: 12px; color: #111827; font-size: 18px; font-weight: 700; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
            ${meet.meetingTitle}
          </h3>
      `;
      text += `=== ${meet.meetingTitle} ===\n\n`;

      for (const item of Object.values(meet.items)) {
        const itemUrl = `${origin}/meetings/${meet.meetingId}/#item-${item.agendaItemId}`;
        const kwList = Array.from(item.matchedKeywords).join(', ');

        html += `
          <div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px dashed #e5e7eb;">
            <div style="font-weight: 600; color: #374151; font-size: 15px;">
              Item ${item.itemNumber} ${item.fileNumber ? `(${item.fileNumber})` : ''}
            </div>
            <p style="margin: 6px 0; font-size: 15px; line-height: 1.4; color: #111827;">${item.title}</p>
            <div style="margin-top: 8px;">
              <span style="background-color: #dbeafe; color: #1e40af; font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 9999px; display: inline-block;">
                Matched: ${kwList}
              </span>
              <a href="${itemUrl}" style="color: #1d4ed8; font-size: 14px; font-weight: 500; text-decoration: none; margin-left: 12px; display: inline-block;">
                View on website &rarr;
              </a>
            </div>
          </div>
        `;

        text += `Item ${item.itemNumber} ${item.fileNumber ? `(${item.fileNumber})` : ''}\n`;
        text += `Title: ${item.title}\n`;
        text += `Matched: ${kwList}\n`;
        text += `Link: ${itemUrl}\n\n`;
      }

      // Remove trailing dashed border for last item
      html = html.replace(/border-bottom: 1px dashed #e5e7eb;(?=[^]*?<\/div>\s*<\/div>\s*$)/, '');
      html += `</div>`;
    }

    html += `
        <footer style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #9ca3af; line-height: 1.5;">
          <p style="margin: 0 0 8px 0;">You are receiving this because you subscribed to keyword notifications on Tampa Monitor.</p>
          <p style="margin: 0;">
            <a href="${manageUrl}" style="color: #1d4ed8; text-decoration: underline;">Manage your keywords</a>
            &nbsp;&middot;&nbsp;
            <a href="${unsubscribeUrl}" style="color: #1d4ed8; text-decoration: underline;">Unsubscribe</a>
          </p>
        </footer>
      </div>
    `;

    text += `To manage your keywords, visit: ${manageUrl}\n`;
    text += `To unsubscribe, visit: ${unsubscribeUrl}\n`;

    emailsToSend.push({
      from: "Tampa Monitor <notifications@tampamonitor.com>",
      to: email,
      subject: `Tampa Monitor: Tracked keyword matches found`,
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
