ALTER TABLE menu_catalog ADD COLUMN initial_price INTEGER;
ALTER TABLE customer_booking_requests ADD COLUMN customer_total INTEGER;

CREATE TABLE IF NOT EXISTS customer_menu_maintenance (
  jos_customer_id TEXT NOT NULL,
  menu_id TEXT NOT NULL,
  maintenance_price INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (jos_customer_id, menu_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_menu_maintenance_customer
ON customer_menu_maintenance(jos_customer_id, is_active);
