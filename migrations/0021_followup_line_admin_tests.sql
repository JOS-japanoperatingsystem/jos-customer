CREATE TABLE IF NOT EXISTS followup_admin_tests (
  test_id TEXT PRIMARY KEY,
  message_type TEXT NOT NULL CHECK (message_type IN ('beard', 'body_vio')),
  recipient_line_sub TEXT NOT NULL,
  recipient_display_name TEXT NOT NULL DEFAULT '',
  message_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_followup_admin_tests_created
ON followup_admin_tests(created_at DESC);
