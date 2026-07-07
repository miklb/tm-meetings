// Unsubscribe is a two-step flow: GET shows a confirmation page and the actual
// deletion happens on POST. Mail scanners and link prefetchers (Outlook
// SafeLinks, corporate gateways) follow GET links in emails, so a GET that
// deletes would silently unsubscribe users. The POST handler also accepts
// RFC 8058 one-click unsubscribe requests (List-Unsubscribe-Post header).

async function findSubscription(db, token) {
  return db.prepare(
    'SELECT id FROM subscriptions WHERE unsubscribe_token = ?'
  ).bind(token).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    console.error("unsubscribe: DB binding missing");
    return new Response("Service temporarily unavailable.", { status: 500 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Unsubscribe token is missing.", { status: 400 });
  }

  const sub = await findSubscription(db, token);
  if (!sub) {
    return Response.redirect(`${url.origin}/notifications/?status=unsubscribe_failed`, 302);
  }

  // Token is echoed into a hidden form field; it arrived via this URL, so it is
  // not newly exposed. Tokens are hex-only but escape defensively anyway.
  const safeToken = token.replace(/[^a-zA-Z0-9]/g, '');

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Unsubscribe — Tampa Monitor</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #1f2937;">
  <h1 style="font-size: 20px;">Unsubscribe from keyword alerts?</h1>
  <p>This will permanently delete your subscription and all tracked keywords.</p>
  <form method="POST" action="/api/unsubscribe">
    <input type="hidden" name="token" value="${safeToken}">
    <button type="submit" style="background-color: #b91c1c; color: white; border: 0; padding: 10px 16px; border-radius: 4px; font-size: 15px; cursor: pointer;">Yes, unsubscribe me</button>
  </form>
  <p style="margin-top: 24px;"><a href="/notifications/" style="color: #1d4ed8;">Cancel and keep my subscription</a></p>
</body>
</html>`;

  return new Response(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    console.error("unsubscribe: DB binding missing");
    return new Response("Service temporarily unavailable.", { status: 500 });
  }

  const url = new URL(request.url);

  // Token can arrive as a query param (RFC 8058 one-click POST from mail
  // clients) or as a form field (confirmation page above).
  let token = url.searchParams.get("token");
  let isOneClick = false;

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      if (!token) token = form.get("token");
      isOneClick = form.get("List-Unsubscribe") === "One-Click";
    } catch (e) {
      // fall through with whatever token we have
    }
  }

  if (!token) {
    return new Response("Unsubscribe token is missing.", { status: 400 });
  }

  const sub = await findSubscription(db, token);
  if (!sub) {
    if (isOneClick) {
      // One-click callers are mail clients; a 200 avoids retry storms
      return new Response(null, { status: 200 });
    }
    return Response.redirect(`${url.origin}/notifications/?status=unsubscribe_failed`, 302);
  }

  // Delete the subscription (cascades to keywords, logs, and session tokens via ON DELETE CASCADE)
  try {
    await db.prepare('DELETE FROM subscriptions WHERE id = ?').bind(sub.id).run();
  } catch (err) {
    console.error(`unsubscribe: database deletion failed: ${err.message}`);
    return new Response("Something went wrong. Please try again later.", { status: 500 });
  }

  if (isOneClick) {
    return new Response(null, { status: 200 });
  }

  // 303 so the browser lands on the status page with a GET (no PII in the URL)
  return new Response(null, {
    status: 303,
    headers: { Location: `${url.origin}/notifications/?status=unsubscribed` }
  });
}
