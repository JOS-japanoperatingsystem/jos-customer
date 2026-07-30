CREATE TABLE IF NOT EXISTS line_notification_recipients (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_notification_recipients_registered
ON line_notification_recipients(registered_at DESC);
