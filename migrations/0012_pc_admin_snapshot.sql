CREATE TABLE pc_sync_runs (
  sync_run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  contract_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('building', 'validating', 'reconciled', 'active', 'failed')
  ),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  source_generated_at TEXT NOT NULL,
  source_customer_count INTEGER NOT NULL CHECK (source_customer_count >= 0),
  received_customer_count INTEGER NOT NULL DEFAULT 0
    CHECK (received_customer_count >= 0),
  source_metric_count INTEGER NOT NULL CHECK (source_metric_count >= 0),
  received_metric_count INTEGER NOT NULL DEFAULT 0
    CHECK (received_metric_count >= 0),
  customer_page_count INTEGER NOT NULL CHECK (customer_page_count >= 0),
  metric_page_count INTEGER NOT NULL CHECK (metric_page_count >= 0),
  source_customer_hash TEXT NOT NULL,
  received_customer_hash TEXT,
  source_metric_hash TEXT NOT NULL,
  received_metric_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  activated_at TEXT
);

CREATE TABLE pc_sync_generations (
  generation_id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  is_reconciled INTEGER NOT NULL DEFAULT 0 CHECK (is_reconciled IN (0, 1)),
  activated_at TEXT,
  superseded_at TEXT,
  retain_until TEXT NOT NULL,
  FOREIGN KEY (sync_run_id) REFERENCES pc_sync_runs(sync_run_id)
);

CREATE TABLE pc_sync_received_pages (
  sync_run_id TEXT NOT NULL,
  dataset_type TEXT NOT NULL CHECK (dataset_type IN ('customers', 'metrics')),
  page_number INTEGER NOT NULL CHECK (page_number >= 1),
  total_pages INTEGER NOT NULL CHECK (total_pages >= 1),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  page_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (sync_run_id, dataset_type, page_number),
  FOREIGN KEY (sync_run_id) REFERENCES pc_sync_runs(sync_run_id)
);

CREATE TABLE pc_customers_snapshot (
  generation_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  customer_kana TEXT,
  phone TEXT,
  customer_type TEXT,
  birth_date TEXT,
  route TEXT,
  referrer TEXT,
  store_memo TEXT,
  row_hash TEXT NOT NULL,
  PRIMARY KEY (generation_id, customer_id),
  FOREIGN KEY (generation_id) REFERENCES pc_sync_generations(generation_id)
);

CREATE TABLE pc_customer_metrics_snapshot (
  generation_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  visit_count INTEGER NOT NULL CHECK (visit_count >= 0),
  first_visit_date TEXT,
  last_visit_date TEXT,
  next_reservation_at TEXT,
  next_reservation_id TEXT,
  next_reservation_menu TEXT,
  total_sales INTEGER NOT NULL CHECK (total_sales >= 0),
  average_spend INTEGER NOT NULL CHECK (average_spend >= 0),
  normal_cancel_count INTEGER NOT NULL CHECK (normal_cancel_count >= 0),
  same_day_cancel_count INTEGER NOT NULL CHECK (same_day_cancel_count >= 0),
  no_show_count INTEGER NOT NULL CHECK (no_show_count >= 0),
  line_status TEXT NOT NULL CHECK (
    line_status IN ('linked', 'unlinked', 'unavailable')
  ),
  line_display_name TEXT,
  metrics_status TEXT NOT NULL CHECK (
    metrics_status IN ('verified', 'unavailable')
  ),
  row_hash TEXT NOT NULL,
  PRIMARY KEY (generation_id, customer_id),
  FOREIGN KEY (generation_id) REFERENCES pc_sync_generations(generation_id)
);

CREATE TABLE pc_reconciliation_results (
  result_id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'customer', 'metric')),
  customer_id TEXT,
  field_name TEXT,
  source_hash TEXT,
  replica_hash TEXT,
  matched INTEGER NOT NULL CHECK (matched IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (sync_run_id) REFERENCES pc_sync_runs(sync_run_id)
);

CREATE INDEX idx_pc_sync_runs_status
  ON pc_sync_runs(status, started_at);

CREATE UNIQUE INDEX idx_pc_one_active_generation
  ON pc_sync_generations(is_active)
  WHERE is_active = 1;

CREATE INDEX idx_pc_received_pages_run
  ON pc_sync_received_pages(sync_run_id, dataset_type, page_number);

CREATE INDEX idx_pc_customers_generation_name
  ON pc_customers_snapshot(generation_id, customer_name);

CREATE INDEX idx_pc_customers_generation_kana
  ON pc_customers_snapshot(generation_id, customer_kana);

CREATE INDEX idx_pc_metrics_generation_next
  ON pc_customer_metrics_snapshot(generation_id, next_reservation_at);

CREATE INDEX idx_pc_reconciliation_run_match
  ON pc_reconciliation_results(sync_run_id, matched);
