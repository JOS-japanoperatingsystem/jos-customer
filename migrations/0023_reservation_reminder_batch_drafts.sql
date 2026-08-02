CREATE TABLE IF NOT EXISTS reservation_reminder_batches (
  batch_id TEXT PRIMARY KEY,
  target_date TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'scheduled', 'processing', 'completed', 'partial', 'failed', 'cancelled')
  ),
  candidate_count INTEGER NOT NULL CHECK (candidate_count > 0),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reservation_reminder_batches_target_status
ON reservation_reminder_batches(target_date, status, created_at DESC);

CREATE TABLE IF NOT EXISTS reservation_reminder_deliveries (
  delivery_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  jos_customer_id TEXT NOT NULL,
  reservation_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL DEFAULT '',
  store_name TEXT NOT NULL,
  menu_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'scheduled', 'sending', 'sent', 'suppressed', 'failed', 'cancelled')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (batch_id) REFERENCES reservation_reminder_batches(batch_id),
  UNIQUE (batch_id, reservation_id),
  UNIQUE (batch_id, jos_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_reminder_deliveries_batch_status
ON reservation_reminder_deliveries(batch_id, status);
