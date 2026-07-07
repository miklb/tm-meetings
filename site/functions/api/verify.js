import { sha256Hex } from '../../lib/api-utils.js';

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

  // Tokens are stored as SHA-256 hashes; hash the presented token to look it up
  const tokenHash = await sha256Hex(token);
  const sub = await db.prepare(
    'SELECT id, verified FROM subscriptions WHERE verification_token = ?'
  ).bind(tokenHash).first();

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
    console.error(`verify: database update failed: ${err.message}`);
    return new Response("Something went wrong. Please try the link again later.", { status: 500 });
  }

  // Redirect to notifications page with success query param (no PII in the URL)
  return Response.redirect(`${url.origin}/notifications/?status=verified`, 302);
}
