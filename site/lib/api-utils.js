// Shared helpers for Pages Functions API endpoints.
// Lives outside site/functions/ so it is never exposed as a route.

export function isDev(env) {
  return env.ENVIRONMENT === 'development';
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Returns `bytes` of cryptographic randomness as a hex string (2 chars per byte).
export function generateToken(bytes = 32) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-safe secret comparison: compare fixed-length digests instead of
// the raw strings so the comparison cannot leak a matching prefix length.
export async function secretsMatch(received, expected) {
  if (!received || !expected) return false;
  const [a, b] = await Promise.all([sha256Hex(received), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function verifyTurnstile(token, secretKey, ip) {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token, remoteip: ip })
  });
  const data = await res.json();
  return data.success === true;
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
