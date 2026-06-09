-- Short-lived session tokens for keyword management (15-minute expiry)
CREATE TABLE IF NOT EXISTS session_tokens (
  token TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_tokens_subscription ON session_tokens (subscription_id);

-- Per-email rate limiting: max 3 emails per 24-hour rolling window
CREATE TABLE IF NOT EXISTS email_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_rate_limits_lookup ON email_rate_limits (email, sent_at);
