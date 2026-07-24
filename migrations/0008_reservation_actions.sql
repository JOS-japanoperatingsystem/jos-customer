CREATE TABLE IF NOT EXISTS customer_reservation_actions (
  action_id TEXT PRIMARY KEY,
  line_sub TEXT NOT NULL,
  jos_customer_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  cancel_status TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  result_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_reservation_actions_pending
ON customer_reservation_actions(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_reservation_actions_one_pending
ON customer_reservation_actions(reservation_id)
WHERE status = 'pending';
