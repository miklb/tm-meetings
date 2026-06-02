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

  const { email, token, keywords } = body;

  if (!email || !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "A valid email address is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const emailLower = email.trim().toLowerCase();

  // Find existing subscription
  const sub = await db.prepare(
    'SELECT id, verified, verification_token, unsubscribe_token FROM subscriptions WHERE email = ?'
  ).bind(emailLower).first();

  // 1. Passwordless request flow (only email provided)
  if (token === undefined && keywords === undefined) {
    if (!sub) {
      // Return success to prevent email enumeration
      return new Response(JSON.stringify({ 
        success: true, 
        message: "If your email is registered, we have sent a management link to your inbox." 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const url = new URL(request.url);

    if (sub.verified === 0) {
      // Resend verification email
      const verifyUrl = `${url.origin}/api/verify?token=${sub.verification_token}`;
      const resendApiKey = env.RESEND_API_KEY;

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

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Your subscription is not verified yet. We have sent a new verification link to your inbox." 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      // Send management link
      const manageUrl = `${url.origin}/notifications/?email=${encodeURIComponent(emailLower)}&token=${sub.unsubscribe_token}`;
      const resendApiKey = env.RESEND_API_KEY;

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
                <p>Use the link below to manage your keywords or unsubscribe from Tampa Monitor meeting notifications:</p>
                <p><a href="${manageUrl}" style="background-color: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px; display: inline-block;">Manage Keywords & Subscriptions</a></p>
                <p><a href="${manageUrl}">${manageUrl}</a></p>
                <br>
                <p>For security, please keep this email safe. Anyone with this link can update your keywords.</p>
              `,
              text: `Manage your subscription: ${manageUrl}`
            })
          });
        } catch (err) {
          console.error(`Resend fail: ${err.message}`);
        }
      } else {
        console.log(`\n=== [LOCAL SEND MANAGEMENT LINK] ===\nTo: ${emailLower}\nLink: ${manageUrl}\n===================================\n`);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        message: "We have sent a management link to your inbox." 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 2. Keyword update / read flow (token provided)
  if (!sub || sub.unsubscribe_token !== token) {
    return new Response(JSON.stringify({ error: "Invalid authorization token or email." }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (sub.verified === 0) {
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

  // Edge case: if in a private phase and supporter has lapsed, prevent changes unless beta tester
  if (!isAllowed) {
    return new Response(JSON.stringify({ 
      error: "Your subscription is paused. Management is restricted to active supporters during the private beta." 
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Read keywords flow (if keywords is not sent)
  if (keywords === undefined) {
    try {
      const keywordsRows = await db.prepare(
        'SELECT keyword FROM keywords WHERE subscription_id = ?'
      ).bind(sub.id).all();
      
      return new Response(JSON.stringify({ 
        success: true, 
        email: emailLower,
        keywords: keywordsRows.results.map(r => r.keyword),
        keywordLimit
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

  // Parse and clean keywords
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

  // Update keywords in database
  try {
    const statements = [
      db.prepare('DELETE FROM keywords WHERE subscription_id = ?').bind(sub.id)
    ];

    for (const keyword of cleanKeywords) {
      const matchType = /^[A-Z]{2,4}\d{2,4}-\d+$/i.test(keyword) ? 'file_number' : 'contains';
      statements.push(db.prepare(
        'INSERT INTO keywords (subscription_id, keyword, match_type) VALUES (?, ?, ?)'
      ).bind(sub.id, keyword, matchType));
    }

    statements.push(db.prepare(
      'UPDATE subscriptions SET updated_at = (datetime(\'now\')) WHERE id = ?'
    ).bind(sub.id));

    await db.batch(statements);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Database update failed: ${err.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Also query and return the updated keywords list
  return new Response(JSON.stringify({ 
    success: true, 
    message: "Keywords updated successfully.",
    keywords: cleanKeywords
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
