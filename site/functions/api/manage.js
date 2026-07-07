import {
  isDev,
  generateToken,
  sha256Hex,
  isValidEmail,
  verifyTurnstile,
  jsonResponse
} from '../../lib/api-utils.js';

// Anti-enumeration: every outcome of the request-link flow that depends on
// whether an email is registered must return this exact response.
const UNIFORM_MESSAGE = "If your email is registered, we have sent a link to your inbox.";

async function sendEmail(resendApiKey, message) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Resend API error: ${errorText}`);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  const dev = isDev(env);

  if (!db) {
    console.error("manage: DB binding missing");
    return jsonResponse({ error: "Service temporarily unavailable." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  const { email, token, keywords, turnstile_token } = body;

  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "A valid email address is required." }, 400);
  }

  const emailLower = email.trim().toLowerCase();

  // ─── 1. Passwordless request flow (email only) ───────────────────────────
  if (token === undefined && keywords === undefined) {
    // Fail closed: in production these must be configured. Missing secrets
    // must never silently downgrade into dev behavior.
    const turnstileSecret = env.TURNSTILE_SECRET_KEY;
    const resendApiKey = env.RESEND_API_KEY;
    if (!dev && (!turnstileSecret || !resendApiKey)) {
      console.error("manage: TURNSTILE_SECRET_KEY or RESEND_API_KEY not configured");
      return jsonResponse({ error: "Service temporarily unavailable." }, 500);
    }

    // Validate Turnstile (always in production; in dev only when configured)
    if (turnstileSecret) {
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const valid = await verifyTurnstile(turnstile_token || '', turnstileSecret, ip);
      if (!valid) {
        return jsonResponse({ error: "Bot verification failed. Please try again." }, 400);
      }
    }

    const uniformSuccess = () => jsonResponse({ success: true, message: UNIFORM_MESSAGE }, 200);

    const sub = await db.prepare(
      'SELECT id, verified FROM subscriptions WHERE email = ?'
    ).bind(emailLower).first();

    if (!sub) {
      return uniformSuccess();
    }

    // Enforce per-email rate limit (3 emails per 24h)
    const recentCount = await db.prepare(
      `SELECT COUNT(*) as count FROM email_rate_limits
       WHERE email = ? AND sent_at > datetime('now', '-24 hours')`
    ).bind(emailLower).first();

    if (recentCount && recentCount.count >= 3) {
      return uniformSuccess();
    }

    const url = new URL(request.url);

    if (sub.verified === 0) {
      // Resend verification. Stored tokens are hashes, so rotate: issue a new
      // raw token for the email and store its hash.
      const verifyToken = generateToken(32);
      const verifyTokenHash = await sha256Hex(verifyToken);
      const verifyUrl = `${url.origin}/api/verify?token=${verifyToken}`;

      try {
        await db.batch([
          db.prepare(
            'UPDATE subscriptions SET verification_token = ?, updated_at = (datetime(\'now\')) WHERE id = ?'
          ).bind(verifyTokenHash, sub.id),
          db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower),
          db.prepare(`DELETE FROM email_rate_limits WHERE sent_at < datetime('now', '-24 hours')`)
        ]);
      } catch (err) {
        console.error(`manage: verification token rotation failed: ${err.message}`);
        return jsonResponse({ error: "Something went wrong. Please try again later." }, 500);
      }

      if (resendApiKey) {
        try {
          await sendEmail(resendApiKey, {
            from: "Tampa Monitor <notifications@tampamonitor.com>",
            to: emailLower,
            subject: "Verify your keyword notifications subscription",
            html: `
              <p>You requested a link for your Tampa Monitor meeting agenda alerts subscription.</p>
              <p>Your email address is not verified yet. Please click the link below to verify it and activate your subscription:</p>
              <p><a href="${verifyUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Verify Email Address</a></p>
              <p><a href="${verifyUrl}">${verifyUrl}</a></p>
            `,
            text: `Verify your email: ${verifyUrl}`
          });
        } catch (err) {
          console.error(`manage: verification resend failed: ${err.message}`);
        }
      } else {
        console.log(`\n=== [LOCAL RESEND VERIFICATION] ===\nTo: ${emailLower}\nLink: ${verifyUrl}\n===================================\n`);
      }

      // Uniform response: same body whether the email was unknown, verified,
      // or unverified. The state-specific detail lives in the email.
      const responsePayload = { success: true, message: UNIFORM_MESSAGE };
      if (!resendApiKey && dev) {
        responsePayload.devVerifyUrl = verifyUrl;
      }
      return jsonResponse(responsePayload, 200);
    } else {
      // Generate a short-lived session token (15-minute expiry). Only the
      // SHA-256 hash is stored; the raw token goes into the emailed link.
      const sessionToken = generateToken(32);
      const sessionTokenHash = await sha256Hex(sessionToken);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      try {
        await db.batch([
          db.prepare(
            'INSERT INTO session_tokens (token, subscription_id, expires_at) VALUES (?, ?, ?)'
          ).bind(sessionTokenHash, sub.id, expiresAt),
          db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower),
          // Opportunistic pruning keeps both housekeeping tables bounded
          db.prepare(`DELETE FROM session_tokens WHERE expires_at < datetime('now')`),
          db.prepare(`DELETE FROM email_rate_limits WHERE sent_at < datetime('now', '-24 hours')`)
        ]);
      } catch (err) {
        console.error(`manage: session token creation failed: ${err.message}`);
        return jsonResponse({ error: "Something went wrong. Please try again later." }, 500);
      }

      const manageUrl = `${url.origin}/notifications/?email=${encodeURIComponent(emailLower)}&token=${sessionToken}`;

      if (resendApiKey) {
        try {
          await sendEmail(resendApiKey, {
            from: "Tampa Monitor <notifications@tampamonitor.com>",
            to: emailLower,
            subject: "Manage your Tampa Monitor keyword notifications",
            html: `
              <p>Use the link below to manage your keywords. This link expires in 15 minutes.</p>
              <p><a href="${manageUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Manage Keywords</a></p>
              <p><a href="${manageUrl}">${manageUrl}</a></p>
              <br>
              <p><small>This link expires in 15 minutes. Please do not forward this email.</small></p>
            `,
            text: `Manage your subscription (expires in 15 minutes): ${manageUrl}`
          });
        } catch (err) {
          console.error(`manage: management link send failed: ${err.message}`);
        }
      } else {
        console.log(`\n=== [LOCAL SEND MANAGEMENT LINK] ===\nTo: ${emailLower}\nLink: ${manageUrl}\n===================================\n`);
      }

      const responsePayload = { success: true, message: UNIFORM_MESSAGE };
      if (!resendApiKey && dev) {
        responsePayload.devManageUrl = manageUrl;
      }
      return jsonResponse(responsePayload, 200);
    }
  }

  // ─── 2. Authenticated flow (session token provided) ──────────────────────
  if (!token) {
    return jsonResponse({ error: "Authorization token is required." }, 401);
  }

  // Look up session token (stored hashed) joined with subscription
  const tokenHash = await sha256Hex(token);
  const sessionRow = await db.prepare(
    `SELECT st.expires_at, s.id AS sub_id, s.verified, s.unsubscribe_token
     FROM session_tokens st
     JOIN subscriptions s ON s.id = st.subscription_id
     WHERE s.email = ? AND st.token = ?`
  ).bind(emailLower, tokenHash).first();

  if (!sessionRow) {
    return jsonResponse({ error: "Invalid or expired authorization token. Please request a new management link." }, 401);
  }

  if (new Date(sessionRow.expires_at) <= new Date()) {
    return jsonResponse({ error: "Your management link has expired. Please request a new one." }, 401);
  }

  const subId = sessionRow.sub_id;
  const subVerified = sessionRow.verified;
  const unsubscribeToken = sessionRow.unsubscribe_token;

  if (subVerified === 0) {
    return jsonResponse({ error: "Please verify your email address before managing keywords." }, 403);
  }

  // Determine user's tier and limit
  const supporter = await db.prepare(
    'SELECT stripe_customer_id, active_until, tier FROM supporters WHERE email = ?'
  ).bind(emailLower).first();

  const isSupporter = supporter && (
    supporter.active_until === null ||
    new Date(supporter.active_until) > new Date()
  );

  let isAllowed = false;
  let keywordLimit = 3;

  if (isSupporter) {
    isAllowed = true;
    keywordLimit = 15;
  }

  const regMode = env.REGISTRATION_MODE || 'SUPPORTERS_ONLY';

  if (!isAllowed) {
    if (regMode === 'PUBLIC') {
      isAllowed = true;
      keywordLimit = 3;
    } else if (regMode === 'BETA_AND_SUPPORTERS') {
      const betaTester = await db.prepare(
        'SELECT 1 FROM beta_testers WHERE email = ?'
      ).bind(emailLower).first();

      if (betaTester) {
        isAllowed = true;
        keywordLimit = 15;
      }
    }
  }

  if (!isAllowed) {
    return jsonResponse({
      error: "Your subscription is paused. Management is restricted to active supporters during the private beta."
    }, 403);
  }

  // Read keywords flow
  if (keywords === undefined) {
    try {
      const keywordsRows = await db.prepare(
        'SELECT keyword FROM keywords WHERE subscription_id = ?'
      ).bind(subId).all();

      return jsonResponse({
        success: true,
        email: emailLower,
        keywords: keywordsRows.results.map(r => r.keyword),
        keywordLimit,
        unsubscribeToken
      }, 200);
    } catch (err) {
      console.error(`manage: keywords read failed: ${err.message}`);
      return jsonResponse({ error: "Something went wrong. Please try again later." }, 500);
    }
  }

  // Update keywords flow
  if (!Array.isArray(keywords)) {
    return jsonResponse({ error: "Keywords list must be an array." }, 400);
  }

  const cleanKeywords = [...new Set(
    keywords
      .map(k => String(k).trim().toLowerCase())
      .filter(k => k.length >= 2 && k.length <= 50)
  )];

  if (cleanKeywords.length > keywordLimit) {
    return jsonResponse({
      error: `Your account tier allows a maximum of ${keywordLimit} keywords. You submitted ${cleanKeywords.length}.`
    }, 400);
  }

  try {
    const statements = [
      db.prepare('DELETE FROM keywords WHERE subscription_id = ?').bind(subId)
    ];

    for (const keyword of cleanKeywords) {
      const matchType = /^[A-Z]{2,4}\d{2,4}-\d+$/i.test(keyword) ? 'file_number' : 'contains';
      statements.push(db.prepare(
        'INSERT INTO keywords (subscription_id, keyword, match_type) VALUES (?, ?, ?)'
      ).bind(subId, keyword, matchType));
    }

    statements.push(db.prepare(
      'UPDATE subscriptions SET updated_at = (datetime(\'now\')) WHERE id = ?'
    ).bind(subId));

    await db.batch(statements);
  } catch (err) {
    console.error(`manage: keywords update failed: ${err.message}`);
    return jsonResponse({ error: "Something went wrong. Please try again later." }, 500);
  }

  return jsonResponse({
    success: true,
    message: "Keywords updated successfully.",
    keywords: cleanKeywords
  }, 200);
}
