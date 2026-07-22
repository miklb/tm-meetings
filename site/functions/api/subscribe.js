import {
  isDev,
  escapeHtml,
  generateToken,
  sha256Hex,
  isValidEmail,
  verifyTurnstile,
  jsonResponse
} from '../../lib/api-utils.js';

// Anti-enumeration: every outcome that depends on whether an email is
// registered/eligible must return this exact response.
const UNIFORM_MESSAGE = "If your email is eligible, a verification link has been sent. Please check your inbox.";

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
    console.error("subscribe: DB binding missing");
    return jsonResponse({ error: "Service temporarily unavailable." }, 500);
  }

  // Fail closed: in production these must be configured. Missing secrets must
  // never silently downgrade into dev behavior.
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  const resendApiKey = env.RESEND_API_KEY;
  if (!dev && (!turnstileSecret || !resendApiKey)) {
    console.error("subscribe: TURNSTILE_SECRET_KEY or RESEND_API_KEY not configured");
    return jsonResponse({ error: "Service temporarily unavailable." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  const { email, keywords, turnstile_token } = body;

  // Validate Turnstile (always in production; in dev only when configured)
  if (turnstileSecret) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const valid = await verifyTurnstile(turnstile_token || '', turnstileSecret, ip);
    if (!valid) {
      return jsonResponse({ error: "Bot verification failed. Please try again." }, 400);
    }
  }

  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "A valid email address is required." }, 400);
  }

  // Parse and clean keywords
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return jsonResponse({ error: "At least one keyword is required." }, 400);
  }

  const cleanKeywords = [...new Set(
    keywords
      .map(k => String(k).trim().toLowerCase())
      .filter(k => k.length >= 2 && k.length <= 50 && !/[<>]/.test(k))
  )];

  if (cleanKeywords.length === 0) {
    return jsonResponse({ error: "Keywords must be between 2 and 50 characters, and cannot contain < or >." }, 400);
  }

  const emailLower = email.trim().toLowerCase();

  // 1. Check supporter status
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

  // 2. Check Beta/Public constraints
  const regMode = env.REGISTRATION_MODE || 'SUPPORTERS_ONLY';

  if (!isAllowed) {
    if (regMode === 'PUBLIC') {
      isAllowed = true;
      keywordLimit = 15;
    } else if (regMode === 'BETA_AND_SUPPORTERS') {
      const betaTester = await db.prepare(
        'SELECT 1 FROM beta_testers WHERE email = ?'
      ).bind(emailLower).first();

      if (betaTester) {
        isAllowed = true;
        keywordLimit = 15; // Beta testers get 15 keywords for testing
      }
    }
  }

  if (!isAllowed) {
    // Uniform response: do not reveal whether this email is on the
    // supporter/beta lists. The page copy explains the beta restriction.
    return jsonResponse({ success: true, message: UNIFORM_MESSAGE }, 200);
  }

  // Enforce keyword limit
  if (cleanKeywords.length > keywordLimit) {
    return jsonResponse({
      error: `Your account tier allows a maximum of ${keywordLimit} keywords. You submitted ${cleanKeywords.length}.`
    }, 400);
  }

  // Enforce per-email verification rate limit (3 emails per 24h)
  const recentEmailCount = await db.prepare(
    `SELECT COUNT(*) as count FROM email_rate_limits
     WHERE email = ? AND sent_at > datetime('now', '-24 hours')`
  ).bind(emailLower).first();

  if (recentEmailCount && recentEmailCount.count >= 3) {
    return jsonResponse({ success: true, message: UNIFORM_MESSAGE }, 200);
  }

  // Check if already subscribed and verified
  const existingSub = await db.prepare(
    'SELECT id, verified FROM subscriptions WHERE email = ?'
  ).bind(emailLower).first();

  if (existingSub && existingSub.verified === 1) {
    // Uniform response; the state-specific detail goes into the email itself.
    try {
      await db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower).run();
      const url = new URL(request.url);
      const manageUrl = `${url.origin}/notifications/`;
      if (resendApiKey) {
        await sendEmail(resendApiKey, {
          from: "Tampa Monitor <notifications@tampamonitor.com>",
          to: emailLower,
          subject: "You're already subscribed to Tampa Monitor alerts",
          html: `
            <p>A subscription request was made for this email address, but you are already subscribed to Tampa Monitor keyword alerts.</p>
            <p>To view or change your keywords, request a management link here:</p>
            <p><a href="${manageUrl}">${manageUrl}</a></p>
            <p>If you didn't request this, you can ignore this email.</p>
          `,
          text: `You are already subscribed to Tampa Monitor keyword alerts.\nManage your keywords: ${manageUrl}\n\nIf you didn't request this, you can ignore this email.`
        });
      } else {
        console.log(`[LOCAL DEV - EMAIL MOCK] Already-subscribed notice to: ${emailLower}`);
      }
    } catch (err) {
      console.error(`subscribe: already-subscribed notice failed: ${err.message}`);
    }
    return jsonResponse({ success: true, message: UNIFORM_MESSAGE }, 200);
  }

  // Prepare tokens. Raw tokens go only into the email; the verification token
  // is stored as a SHA-256 hash so a database leak cannot be used to verify
  // or hijack subscriptions.
  const subId = existingSub ? existingSub.id : generateToken(16);
  const verifyToken = generateToken(32);
  const verifyTokenHash = await sha256Hex(verifyToken);
  const unsubToken = generateToken(32);

  // Write to D1 in batch
  try {
    const statements = [];

    if (existingSub) {
      // Update unverified subscription tokens
      statements.push(db.prepare(
        'UPDATE subscriptions SET verification_token = ?, unsubscribe_token = ?, updated_at = (datetime(\'now\')) WHERE id = ?'
      ).bind(verifyTokenHash, unsubToken, subId));

      // Delete their draft keywords
      statements.push(db.prepare('DELETE FROM keywords WHERE subscription_id = ?').bind(subId));
    } else {
      // Create new subscription
      statements.push(db.prepare(
        'INSERT INTO subscriptions (id, email, verification_token, unsubscribe_token) VALUES (?, ?, ?, ?)'
      ).bind(subId, emailLower, verifyTokenHash, unsubToken));
    }

    // Insert keywords
    for (const keyword of cleanKeywords) {
      // Check if keyword looks like a file number (e.g. REZ26-0042) to assign proper match_type
      const matchType = /^[A-Z]{2,4}\d{2,4}-\d+$/i.test(keyword) ? 'file_number' : 'contains';
      statements.push(db.prepare(
        'INSERT INTO keywords (subscription_id, keyword, match_type) VALUES (?, ?, ?)'
      ).bind(subId, keyword, matchType));
    }

    statements.push(db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower));
    // Opportunistic pruning keeps the rate-limit table bounded
    statements.push(db.prepare(`DELETE FROM email_rate_limits WHERE sent_at < datetime('now', '-24 hours')`));
    await db.batch(statements);
  } catch (err) {
    console.error(`subscribe: database write failed: ${err.message}`);
    return jsonResponse({ error: "Something went wrong saving your subscription. Please try again later." }, 500);
  }

  // Construct links
  const url = new URL(request.url);
  const verifyUrl = `${url.origin}/api/verify?token=${verifyToken}`;

  if (resendApiKey) {
    // Dispatch actual email
    try {
      const safeKeywords = escapeHtml(cleanKeywords.join(', '));
      await sendEmail(resendApiKey, {
        from: "Tampa Monitor <notifications@tampamonitor.com>",
        to: emailLower,
        subject: "Verify your keyword notifications subscription",
        html: `
          <p>Thank you for subscribing to Tampa Monitor meeting agenda alerts!</p>
          <p>Please click the link below to verify your email and activate your keyword matches:</p>
          <p><a href="${verifyUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Verify Email Address</a></p>
          <p>If the button doesn't work, copy and paste this link into your browser:</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <br>
          <p>You submitted these keywords: <strong>${safeKeywords}</strong></p>
          <p>If you didn't request this, you can ignore this email.</p>
        `,
        text: `Verify your email: ${verifyUrl}\n\nKeywords: ${cleanKeywords.join(', ')}`
      });
    } catch (err) {
      // In case Resend fails, don't fail the request, but log it and tell user we registered them
      console.error(`Email dispatch failed: ${err.message}`);
      return jsonResponse({
        success: true,
        message: "Subscription recorded, but verification email failed to send. Please contact support."
      }, 200);
    }
  }

  const responsePayload = { success: true, message: UNIFORM_MESSAGE };

  if (!resendApiKey && dev) {
    // MOCK EMAIL LOGGING (local development only)
    console.log(`
=========================================
[LOCAL DEV - EMAIL MOCK]
To: ${emailLower}
Subject: Verify your keyword notifications subscription
Verification Link: ${verifyUrl}
Keywords: ${cleanKeywords.join(', ')}
=========================================
    `);
    responsePayload.devVerifyUrl = verifyUrl;
  }

  return jsonResponse(responsePayload, 200);
}
