-- Migration: Create tables for subscription, keywords, notification logging, supporters, and beta testers

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,          -- nanoid
  email              TEXT NOT NULL UNIQUE,
  verified           INTEGER DEFAULT 0,
  verification_token TEXT,
  unsubscribe_token  TEXT UNIQUE,
  created_at         TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- Create keywords table
CREATE TABLE IF NOT EXISTS keywords (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  keyword            TEXT NOT NULL,             -- lowercased, trimmed
  match_type         TEXT DEFAULT 'contains',   -- contains | exact_phrase | file_number
  UNIQUE(subscription_id, keyword)
);

-- Create notification log table
CREATE TABLE IF NOT EXISTS notification_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  meeting_id         TEXT,
  agenda_item_id     TEXT,
  keyword_matched    TEXT,
  sent_at            TEXT DEFAULT (datetime('now'))
);

-- Create supporters table
CREATE TABLE IF NOT EXISTS supporters (
  email              TEXT PRIMARY KEY,          -- lowercased
  stripe_customer_id TEXT,                      -- NULL for manual imports during beta
  tier               TEXT DEFAULT 'supporter',  -- free | supporter
  source             TEXT,                      -- monthly | annual | donation | manual
  active_until       TEXT,                      -- NULL for active recurring; ISO date for one-time/annual/manual expiration
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- Create beta_testers table
CREATE TABLE IF NOT EXISTS beta_testers (
  email              TEXT PRIMARY KEY,          -- lowercased, trimmed
  created_at         TEXT DEFAULT (datetime('now'))
);
