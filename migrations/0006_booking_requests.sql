CREATE TABLE IF NOT EXISTS customer_booking_requests (
  request_id TEXT PRIMARY KEY,
  line_sub TEXT NOT NULL,
  jos_customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  menu_ids TEXT NOT NULL,
  menu_names TEXT NOT NULL,
  reservation_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  treatment_time INTEGER NOT NULL,
  normal_total INTEGER NOT NULL DEFAULT 0,
  student_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reservation_id TEXT,
  final_price INTEGER,
  result_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_requests_pending
ON customer_booking_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_booking_requests_date_time
ON customer_booking_requests(reservation_date, start_time, end_time, status);
