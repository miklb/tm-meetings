function generateToken(length = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function verifyTurnstile(token, secretKey, ip) {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token, remoteip: ip })
  });
  const data = await res.json();
  return data.success === true;
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { email, token, keywords, turnstile_token } = body;

  if (!email || !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "A valid email address is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const emailLower = email.trim().toLowerCase();

  // ─── 1. Passwordless request flow (email only) ───────────────────────────
  if (token === undefined && keywords === undefined) {
    // Validate Turnstile when configured
    const turnstileSecret = env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const valid = await verifyTurnstile(turnstile_token || '', turnstileSecret, ip);
      if (!valid) {
        return new Response(JSON.stringify({ error: "Bot verification failed. Please try again." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Uniform response to prevent email enumeration
    const uniformSuccess = new Response(JSON.stringify({
      success: true,
      message: "If your email is registered, we have sent a management link to your inbox."
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const sub = await db.prepare(
      'SELECT id, verified, verification_token, unsubscribe_token FROM subscriptions WHERE email = ?'
    ).bind(emailLower).first();

    if (!sub) {
      return uniformSuccess;
    }

    // Enforce per-email rate limit (3 emails per 24h)
    const recentCount = await db.prepare(
      `SELECT COUNT(*) as count FROM email_rate_limits
       WHERE email = ? AND sent_at > datetime('now', '-24 hours')`
    ).bind(emailLower).first();

    if (recentCount && recentCount.count >= 3) {
      return uniformSuccess;
    }

    const url = new URL(request.url);
    const resendApiKey = env.RESEND_API_KEY;

    if (sub.verified === 0) {
      // Resend verification email
      const verifyUrl = `${url.origin}/api/verify?token=${sub.verification_token}`;

      if (resendApiKey) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "Tampa Monitor <notifications@tampamonitor.com>",
              to: emailLower,
              subject: "Verify your keyword notifications subscription",
              html: `
                <p>You requested a verification link for your Tampa Monitor meeting agenda alerts subscription.</p>
                <p>Please click the link below to verify your email and activate your subscription:</p>
                <p><a href="${verifyUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Verify Email Address</a></p>
                <p><a href="${verifyUrl}">${verifyUrl}</a></p>
              `,
              text: `Verify your email: ${verifyUrl}`
            })
          });
        } catch (err) {
          console.error(`Resend fail: ${err.message}`);
        }
      } else {
        console.log(`\n=== [LOCAL RESEND VERIFICATION] ===\nTo: ${emailLower}\nLink: ${verifyUrl}\n===================================\n`);
      }

      await db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower).run();

      const responsePayload = {
        success: true,
        message: "Your subscription is not verified yet. We have sent a new verification link to your inbox."
      };
      if (!resendApiKey) {
        responsePayload.devVerifyUrl = verifyUrl;
      }
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      // Generate a short-lived session token (15-minute expiry)
      const sessionToken = generateToken(32);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await db.batch([
        db.prepare(
          'INSERT INTO session_tokens (token, subscription_id, expires_at) VALUES (?, ?, ?)'
        ).bind(sessionToken, sub.id, expiresAt),
        db.prepare('INSERT INTO email_rate_limits (email) VALUES (?)').bind(emailLower)
      ]);

      const manageUrl = `${url.origin}/notifications/?email=${encodeURIComponent(emailLower)}&token=${sessionToken}`;

      if (resendApiKey) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "Tampa Monitor <notifications@tampamonitor.com>",
              to: emailLower,
              subject: "Manage your Tampa Monitor keyword notifications",
              html: `
                <p>Use the link below to manage your keywords. This link expires in 15 minutes.</p>
                <p><a href="${manageUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Manage Keywords</a></p>
                <p><a href="${manageUrl}">${manageUrl}</a></p>
                <br>
                <p><small>This link is single-session. Please do not forward this email.</small></p>
              `,
              text: `Manage your subscription (expires in 15 minutes): ${manageUrl}`
            })
          });
        } catch (err) {
          console.error(`Resend fail: ${err.message}`);
        }
      } else {
        console.log(`\n=== [LOCAL SEND MANAGEMENT LINK] ===\nTo: ${emailLower}\nLink: ${manageUrl}\n===================================\n`);
      }

      const responsePayload = {
        success: true,
        message: "We have sent a management link to your inbox. It expires in 15 minutes."
      };
      if (!resendApiKey) {
        responsePayload.devManageUrl = manageUrl;
      }
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ─── 2. Authenticated flow (session token provided) ──────────────────────
  if (!token) {
    return new Response(JSON.stringify({ error: "Authorization token is required." }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Look up session token joined with subscription
  const sessionRow = await db.prepare(
    `SELECT st.expires_at, s.id AS sub_id, s.verified, s.unsubscribe_token
     FROM session_tokens st
     JOIN subscriptions s ON s.id = st.subscription_id
     WHERE s.email = ? AND st.token = ?`
  ).bind(emailLower, token).first();

  if (!sessionRow) {
    return new Response(JSON.stringify({ error: "Invalid or expired authorization token. Please request a new management link." }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (new Date(sessionRow.expires_at) <= new Date()) {
    return new Response(JSON.stringify({ error: "Your management link has expired. Please request a new one." }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const subId = sessionRow.sub_id;
  const subVerified = sessionRow.verified;
  const unsubscribeToken = sessionRow.unsubscribe_token;

  if (subVerified === 0) {
    return new Response(JSON.stringify({ error: "Please verify your email address before managing keywords." }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
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
    return new Response(JSON.stringify({
      error: "Your subscription is paused. Management is restricted to active supporters during the private beta."
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Read keywords flow
  if (keywords === undefined) {
    try {
      const keywordsRows = await db.prepare(
        'SELECT keyword FROM keywords WHERE subscription_id = ?'
      ).bind(subId).all();

      return new Response(JSON.stringify({
        success: true,
        email: emailLower,
        keywords: keywordsRows.results.map(r => r.keyword),
        keywordLimit,
        unsubscribeToken
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: `Database read failed: ${err.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // Update keywords flow
  if (!Array.isArray(keywords)) {
    return new Response(JSON.stringify({ error: "Keywords list must be an array." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const cleanKeywords = [...new Set(
    keywords
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length >= 2 && k.length <= 50)
  )];

  if (cleanKeywords.length > keywordLimit) {
    return new Response(JSON.stringify({
      error: `Your account tier allows a maximum of ${keywordLimit} keywords. You submitted ${cleanKeywords.length}.`
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
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
    return new Response(JSON.stringify({ error: `Database update failed: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({
    success: true,
    message: "Keywords updated successfully.",
    keywords: cleanKeywords
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
