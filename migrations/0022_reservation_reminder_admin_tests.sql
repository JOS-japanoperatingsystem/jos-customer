CREATE TABLE IF NOT EXISTS reservation_reminder_admin_tests (
  test_id TEXT PRIMARY KEY,
  recipient_line_sub TEXT NOT NULL,
  recipient_display_name TEXT NOT NULL DEFAULT '',
  message_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reservation_reminder_admin_tests_created
ON reservation_reminder_admin_tests(created_at DESC);
