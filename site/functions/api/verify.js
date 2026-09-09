// Verification is a two-step flow, like unsubscribe: GET shows a confirmation
// page and the actual verification happens on POST. Mail-gateway link
// scanners (Outlook SafeLinks, corporate gateways) follow GET links in
// emails, so a GET that verified would let anyone enrol a third party and
// have the victim's own mail gateway confirm it. Tokens also expire: a link
// older than VERIFY_TOKEN_MAX_AGE_HOURS (measured from subscriptions.updated_at,
// which every token issue/rotation sets) is refused.

import { sha256Hex, generateToken } from '../../lib/api-utils.js';

export const VERIFY_TOKEN_MAX_AGE_HOURS = 72;

// Best-effort admin ping so Michael can gauge signup volume without any
// subscriber PII in the email — just a count-by-inbox signal, not a report.
async function pingAdmin(resendApiKey, adminEmail) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Tampa Monitor <notifications@tampamonitor.com>",
      to: adminEmail,
      subject: "New keyword-notifications signup verified",
      text: "A new subscriber just verified their email for Tampa Monitor keyword notifications."
    })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Resend API error: ${errorText}`);
  }
}

/** Look up the subscription for a raw token. Returns { sub, status } where status is 'ok' | 'not_found' | 'expired'. */
async function findByToken(db, token) {
  const tokenHash = await sha256Hex(token);
  const sub = await db.prepare(
    `SELECT id, email, verified, updated_at,
            (julianday('now') - julianday(updated_at)) * 24 AS age_hours
     FROM subscriptions WHERE verification_token = ?`
  ).bind(tokenHash).first();
  if (!sub) return { sub: null, status: 'not_found' };
  if (sub.verified !== 1 && sub.age_hours !== null && sub.age_hours > VERIFY_TOKEN_MAX_AGE_HOURS) {
    return { sub, status: 'expired' };
  }
  return { sub, status: 'ok' };
}

function redirect(origin, status) {
  return Response.redirect(`${origin}/notifications/?status=${status}`, 302);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    console.error("verify: DB binding missing");
    return new Response("Service temporarily unavailable.", { status: 500 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Verification token is missing.", { status: 400 });
  }

  const { sub, status } = await findByToken(db, token);
  if (status === 'not_found') return redirect(url.origin, 'verify_failed');
  if (status === 'expired') return redirect(url.origin, 'verify_expired');
  if (sub.verified === 1) return redirect(url.origin, 'already_verified');

  // Token is echoed into a hidden form field; it arrived via this URL, so it
  // is not newly exposed. Tokens are hex-only but escape defensively anyway.
  const safeToken = token.replace(/[^a-zA-Z0-9]/g, '');

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Confirm your subscription — Tampa Monitor</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #1f2937;">
  <h1 style="font-size: 20px;">Confirm your keyword alerts</h1>
  <p>One more click activates Tampa City Council agenda alerts for this email address.</p>
  <form method="POST" action="/api/verify">
    <input type="hidden" name="token" value="${safeToken}">
    <button type="submit" style="background-color: #1d4ed8; color: white; border: 0; padding: 10px 16px; border-radius: 4px; font-size: 15px; cursor: pointer;">Yes, activate my alerts</button>
  </form>
  <p style="margin-top: 24px; font-size: 14px; color: #6b7280;">Didn't sign up? Ignore this page and nothing happens.</p>
</body>
</html>`;

  return new Response(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const db = env.DB;

  if (!db) {
    console.error("verify: DB binding missing");
    return new Response("Service temporarily unavailable.", { status: 500 });
  }

  const url = new URL(request.url);

  let token = null;
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      token = (await request.formData()).get("token");
    } catch (e) {
      // fall through
    }
  }
  if (!token) {
    return new Response("Verification token is missing.", { status: 400 });
  }

  const { sub, status } = await findByToken(db, token);
  if (status === 'not_found') return redirect(url.origin, 'verify_failed');
  if (status === 'expired') return redirect(url.origin, 'verify_expired');
  if (sub.verified === 1) return redirect(url.origin, 'already_verified');

  // Update D1: mark as verified and clear the verification token
  try {
    await db.prepare(
      'UPDATE subscriptions SET verified = 1, verification_token = NULL, updated_at = (datetime(\'now\')) WHERE id = ?'
    ).bind(sub.id).run();
  } catch (err) {
    console.error(`verify: database update failed: ${err.message}`);
    return new Response("Something went wrong. Please try the link again later.", { status: 500 });
  }

  // Fire-and-forget admin ping — never blocks or fails the user's redirect.
  if (env.RESEND_API_KEY && env.ADMIN_NOTIFY_EMAIL) {
    waitUntil(
      pingAdmin(env.RESEND_API_KEY, env.ADMIN_NOTIFY_EMAIL).catch(err =>
        console.error(`verify: admin ping failed: ${err.message}`)
      )
    );
  }

  // Mint a short-lived management session (1 hour, matching manage.js) so the
  // user lands on their keyword list instead of an empty subscribe form. Same
  // pattern as the manage.js magic link (raw token in the URL, only the hash
  // stored); the page JS scrubs the query string from history after it loads.
  // 303 so the browser follows with a GET.
  try {
    const sessionToken = generateToken(32);
    const sessionTokenHash = await sha256Hex(sessionToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await db.batch([
      db.prepare(
        'INSERT INTO session_tokens (token, subscription_id, expires_at) VALUES (?, ?, ?)'
      ).bind(sessionTokenHash, sub.id, expiresAt),
      db.prepare(`DELETE FROM session_tokens WHERE expires_at < datetime('now')`)
    ]);

    return new Response(null, {
      status: 303,
      headers: { Location: `${url.origin}/notifications/?status=verified&email=${encodeURIComponent(sub.email)}&token=${sessionToken}` }
    });
  } catch (err) {
    // Verification itself already committed — degrade to the plain confirmation
    console.error(`verify: session token creation failed: ${err.message}`);
  }

  return new Response(null, { status: 303, headers: { Location: `${url.origin}/notifications/?status=verified` } });
}
