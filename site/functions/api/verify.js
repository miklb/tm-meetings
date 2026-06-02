export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    return new Response("Database binding missing.", { status: 500 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Verification token is missing.", { status: 400 });
  }

  // Find the subscription with this token
  const sub = await db.prepare(
    'SELECT id, email, verified FROM subscriptions WHERE verification_token = ?'
  ).bind(token).first();

  if (!sub) {
    // If not found, redirect to notifications page with an error status
    return Response.redirect(`${url.origin}/notifications/?status=verify_failed`, 302);
  }

  if (sub.verified === 1) {
    // If already verified, just redirect to notifications page
    return Response.redirect(`${url.origin}/notifications/?status=already_verified`, 302);
  }

  // Update D1: mark as verified and clear the verification token
  try {
    await db.prepare(
      'UPDATE subscriptions SET verified = 1, verification_token = NULL, updated_at = (datetime(\'now\')) WHERE id = ?'
    ).bind(sub.id).run();
  } catch (err) {
    return new Response(`Database update failed: ${err.message}`, { status: 500 });
  }

  // Redirect to notifications page with success query param
  return Response.redirect(`${url.origin}/notifications/?status=verified&email=${encodeURIComponent(sub.email)}`, 302);
}
