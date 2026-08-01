CREATE TABLE IF NOT EXISTS customer_lifecycle_notifications (
  event_key TEXT PRIMARY KEY,
  line_sub TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_notifications_pending
ON customer_lifecycle_notifications(status, created_at);
