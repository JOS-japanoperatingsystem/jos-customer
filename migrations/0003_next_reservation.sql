CREATE TABLE IF NOT EXISTS customer_next_reservations (
  jos_customer_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  reservation_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL DEFAULT '',
  menu_name TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  reservation_status TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_next_reservation_date
  ON customer_next_reservations(reservation_date, start_time);
