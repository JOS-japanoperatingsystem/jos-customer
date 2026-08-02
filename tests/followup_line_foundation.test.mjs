import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../migrations/0020_followup_line_foundation.sql', import.meta.url),
  'utf8'
);

test('follow-up delivery history is durable and idempotent', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS followup_campaigns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS followup_deliveries/);
  assert.match(migration, /tracking_token TEXT NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(jos_customer_id, last_visit_date, timing_group\)/);
  assert.match(migration, /status IN \('draft', 'approved', 'sending', 'sent', 'failed', 'suppressed', 'cancelled'\)/);
});

test('opt-out and attribution are separate from reservations and sales', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS followup_opt_outs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS followup_attributions/);
  assert.match(migration, /reservation_id TEXT PRIMARY KEY/);
  assert.match(migration, /attribution_type IN \('direct', 'indirect'\)/);
  assert.match(migration, /confirmed_revenue INTEGER NOT NULL DEFAULT 0/);
});

