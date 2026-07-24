CREATE TABLE IF NOT EXISTS menu_catalog (
  menu_id TEXT PRIMARY KEY,
  menu_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  normal_price INTEGER NOT NULL DEFAULT 0,
  student_price INTEGER NOT NULL DEFAULT 0,
  treatment_time INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_menu_catalog_active_sort
ON menu_catalog(is_active, sort_order, menu_name);
