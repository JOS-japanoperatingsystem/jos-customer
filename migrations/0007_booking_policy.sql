CREATE TABLE IF NOT EXISTS customer_booking_policy (
  jos_customer_id TEXT PRIMARY KEY,
  normal_cancel_count INTEGER NOT NULL DEFAULT 0,
  same_day_count INTEGER NOT NULL DEFAULT 0,
  no_show_count INTEGER NOT NULL DEFAULT 0,
  automatic_restricted INTEGER NOT NULL DEFAULT 0,
  manual_restricted INTEGER NOT NULL DEFAULT 0,
  manual_restriction_note TEXT NOT NULL DEFAULT '',
  policy_reset_at TEXT,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_booking_policy_restricted
ON customer_booking_policy(automatic_restricted, manual_restricted);
