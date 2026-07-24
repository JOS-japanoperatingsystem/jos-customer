CREATE TABLE IF NOT EXISTS customer_profile_update_requests (
  request_id TEXT PRIMARY KEY,
  line_sub TEXT NOT NULL,
  jos_customer_id TEXT NOT NULL,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_kana TEXT NOT NULL,
  first_kana TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_profile_updates_pending
ON customer_profile_update_requests(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profile_updates_one_pending
ON customer_profile_update_requests(line_sub)
WHERE status = 'pending';
