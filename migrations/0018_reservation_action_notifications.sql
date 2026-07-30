ALTER TABLE customer_reservation_actions ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_reservation_actions ADD COLUMN original_date TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_reservation_actions ADD COLUMN original_start_time TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_reservation_actions ADD COLUMN original_end_time TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_reservation_actions ADD COLUMN menu_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_reservation_actions_created
ON customer_reservation_actions(created_at DESC);
