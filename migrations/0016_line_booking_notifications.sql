CREATE TABLE IF NOT EXISTS line_notification_settings (
  setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1),
  recipient_line_sub TEXT,
  recipient_display_name TEXT NOT NULL DEFAULT '',
  last_sent_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO line_notification_settings
  (setting_id, recipient_line_sub, recipient_display_name, updated_at)
VALUES
  (1, NULL, '', datetime('now'));

CREATE INDEX IF NOT EXISTS idx_booking_requests_created_status
ON customer_booking_requests(created_at DESC, status);
