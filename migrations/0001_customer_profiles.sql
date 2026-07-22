CREATE TABLE IF NOT EXISTS customer_profiles (
  line_sub TEXT PRIMARY KEY,
  line_display_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_kana TEXT NOT NULL,
  first_kana TEXT NOT NULL,
  phone TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'pending',
  jos_customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_phone
  ON customer_profiles(phone);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_link_status
  ON customer_profiles(link_status);
