ALTER TABLE customer_reservation_actions
ADD COLUMN requested_date TEXT NOT NULL DEFAULT '';

ALTER TABLE customer_reservation_actions
ADD COLUMN requested_start_time TEXT NOT NULL DEFAULT '';

ALTER TABLE customer_reservation_actions
ADD COLUMN requested_end_time TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_customer_reservation_actions_change_slot
ON customer_reservation_actions(
  requested_date,
  requested_start_time,
  requested_end_time,
  status
);
