ALTER TABLE customer_next_reservations
RENAME TO customer_next_reservations_single;

DROP INDEX IF EXISTS idx_customer_next_reservation_date;

CREATE TABLE customer_next_reservations (
  reservation_id TEXT PRIMARY KEY,
  jos_customer_id TEXT NOT NULL,
  reservation_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL DEFAULT '',
  menu_name TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  reservation_status TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL
);

INSERT INTO customer_next_reservations
  (reservation_id, jos_customer_id, reservation_date, start_time,
   end_time, menu_name, price, reservation_status, synced_at)
SELECT
  reservation_id, jos_customer_id, reservation_date, start_time,
  end_time, menu_name, price, reservation_status, synced_at
FROM customer_next_reservations_single;

DROP TABLE customer_next_reservations_single;

CREATE INDEX idx_customer_next_reservation_customer
ON customer_next_reservations(jos_customer_id, reservation_date, start_time);

CREATE INDEX idx_customer_next_reservation_date
ON customer_next_reservations(reservation_date, start_time);
