CREATE TABLE IF NOT EXISTS booking_settings (
  setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1),
  lead_minutes INTEGER NOT NULL DEFAULT 60
    CHECK (lead_minutes BETWEEN 0 AND 1440),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO booking_settings
  (setting_id, lead_minutes, updated_at)
VALUES
  (1, 60, datetime('now'));
