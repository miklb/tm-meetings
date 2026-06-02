function generateToken(length = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  const { email, keywords } = body;

  if (!email || !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "A valid email address is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Parse and clean keywords
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return new Response(JSON.stringify({ error: "At least one keyword is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const cleanKeywords = [...new Set(
    keywords
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length >= 2 && k.length <= 50)
  )];

  if (cleanKeywords.length === 0) {
    return new Response(JSON.stringify({ error: "Keywords must be between 2 and 50 characters." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
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
      keywordLimit = 3;
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
    return new Response(JSON.stringify({ 
      error: "Keyword notifications are currently in private beta. If you are a supporter, please subscribe using your registered email. Support the project at tampamonitor.com/support to get access." 
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Enforce keyword limit
  if (cleanKeywords.length > keywordLimit) {
    return new Response(JSON.stringify({ 
      error: `Your account tier allows a maximum of ${keywordLimit} keywords. You submitted ${cleanKeywords.length}.` 
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Check if already subscribed and verified
  const existingSub = await db.prepare(
    'SELECT id, verified FROM subscriptions WHERE email = ?'
  ).bind(emailLower).first();

  if (existingSub && existingSub.verified === 1) {
    return new Response(JSON.stringify({ 
      error: "This email is already subscribed. To manage your keywords, please use the link in your emails." 
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Prepare tokens
  const subId = existingSub ? existingSub.id : generateToken(21);
  const verifyToken = generateToken(32);
  const unsubToken = generateToken(32);

  // Write to D1 in batch
  try {
    const statements = [];
    
    if (existingSub) {
      // Update unverified subscription tokens
      statements.push(db.prepare(
        'UPDATE subscriptions SET verification_token = ?, unsubscribe_token = ?, updated_at = (datetime(\'now\')) WHERE id = ?'
      ).bind(verifyToken, unsubToken, subId));
      
      // Delete their draft keywords
      statements.push(db.prepare('DELETE FROM keywords WHERE subscription_id = ?').bind(subId));
    } else {
      // Create new subscription
      statements.push(db.prepare(
        'INSERT INTO subscriptions (id, email, verification_token, unsubscribe_token) VALUES (?, ?, ?, ?)'
      ).bind(subId, emailLower, verifyToken, unsubToken));
    }

    // Insert keywords
    for (const keyword of cleanKeywords) {
      // Check if keyword looks like a file number (e.g. REZ26-0042) to assign proper match_type
      const matchType = /^[A-Z]{2,4}\d{2,4}-\d+$/i.test(keyword) ? 'file_number' : 'contains';
      statements.push(db.prepare(
        'INSERT INTO keywords (subscription_id, keyword, match_type) VALUES (?, ?, ?)'
      ).bind(subId, keyword, matchType));
    }

    await db.batch(statements);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Database write failed: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Construct links
  const url = new URL(request.url);
  const verifyUrl = `${url.origin}/api/verify?token=${verifyToken}`;

  // Check for Resend API Key
  const resendApiKey = env.RESEND_API_KEY;
  if (resendApiKey) {
    // Dispatch actual email
    try {
      const emailBody = {
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
          <p>You submitted these keywords: <strong>${cleanKeywords.join(', ')}</strong></p>
          <p>If you didn't request this, you can ignore this email.</p>
        `,
        text: `Verify your email: ${verifyUrl}\n\nKeywords: ${cleanKeywords.join(', ')}`
      };

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(emailBody)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Resend API error: ${errorText}`);
      }
    } catch (err) {
      // In case Resend fails, don't fail the request, but log it and tell user we registered them
      console.error(`Email dispatch failed: ${err.message}`);
      return new Response(JSON.stringify({ 
        success: true, 
        message: "Subscription recorded, but verification email failed to send. Please contact support." 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  } else {
    // MOCK EMAIL LOGGING (No API key present)
    console.log(`
=========================================
[LOCAL DEV - EMAIL MOCK]
To: ${emailLower}
Subject: Verify your keyword notifications subscription
Verification Link: ${verifyUrl}
Keywords: ${cleanKeywords.join(', ')}
=========================================
    `);
  }

  return new Response(JSON.stringify({ 
    success: true, 
    message: "Verification email sent. Please check your inbox to confirm your subscription." 
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
