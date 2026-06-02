export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    return new Response("Database binding missing.", { status: 500 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Unsubscribe token is missing.", { status: 400 });
  }

  // Find the subscription with this token
  const sub = await db.prepare(
    'SELECT id, email FROM subscriptions WHERE unsubscribe_token = ?'
  ).bind(token).first();

  if (!sub) {
    // If not found, redirect to notifications page with an error status
    return Response.redirect(`${url.origin}/notifications/?status=unsubscribe_failed`, 302);
  }

  // Delete the subscription (cascades to keywords and logs automatically due to foreign key ON DELETE CASCADE)
  try {
    await db.prepare('DELETE FROM subscriptions WHERE id = ?').bind(sub.id).run();
  } catch (err) {
    return new Response(`Database deletion failed: ${err.message}`, { status: 500 });
  }

  // Redirect to notifications page with unsubscribed query param
  return Response.redirect(`${url.origin}/notifications/?status=unsubscribed&email=${encodeURIComponent(sub.email)}`, 302);
}
