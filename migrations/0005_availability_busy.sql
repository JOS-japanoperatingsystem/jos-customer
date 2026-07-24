CREATE TABLE IF NOT EXISTS availability_busy (
  busy_id TEXT PRIMARY KEY,
  busy_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  busy_type TEXT NOT NULL DEFAULT 'reservation',
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_availability_busy_date
ON availability_busy(busy_date, start_time, end_time);
