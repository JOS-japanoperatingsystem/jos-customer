CREATE TABLE IF NOT EXISTS followup_campaigns (
  campaign_id TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'approved', 'sending', 'completed', 'cancelled')
  ),
  message_template TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS followup_deliveries (
  delivery_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  jos_customer_id TEXT NOT NULL,
  last_visit_date TEXT NOT NULL,
  timing_group TEXT NOT NULL CHECK (timing_group IN ('beard', 'body_vio')),
  due_date TEXT NOT NULL,
  part_names_json TEXT NOT NULL DEFAULT '[]',
  message_text TEXT NOT NULL DEFAULT '',
  tracking_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'approved', 'sending', 'sent', 'failed', 'suppressed', 'cancelled')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  sending_started_at TEXT,
  sent_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (campaign_id) REFERENCES followup_campaigns(campaign_id),
  UNIQUE (jos_customer_id, last_visit_date, timing_group)
);

CREATE INDEX IF NOT EXISTS idx_followup_deliveries_status_due
ON followup_deliveries(status, due_date);

CREATE INDEX IF NOT EXISTS idx_followup_deliveries_customer_sent
ON followup_deliveries(jos_customer_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS followup_opt_outs (
  jos_customer_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  opted_out_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS followup_attributions (
  reservation_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attribution_type TEXT NOT NULL CHECK (attribution_type IN ('direct', 'indirect')),
  booking_request_id TEXT,
  booked_at TEXT NOT NULL,
  reservation_status TEXT NOT NULL DEFAULT '',
  expected_revenue INTEGER NOT NULL DEFAULT 0 CHECK (expected_revenue >= 0),
  confirmed_revenue INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_revenue >= 0),
  visit_completed_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (delivery_id) REFERENCES followup_deliveries(delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_followup_attributions_delivery
ON followup_attributions(delivery_id, attribution_type);

