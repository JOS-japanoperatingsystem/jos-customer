import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const worker = fs.readFileSync(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);
const migration = fs.readFileSync(
  new URL('../migrations/0024_booking_lead_time_settings.sql', import.meta.url),
  'utf8'
);

test('booking lead time defaults safely to 60 minutes', () => {
  assert.match(worker, /DEFAULT_BOOKING_LEAD_MINUTES = 60/);
  assert.match(worker, /async function getBookingLeadMinutes/);
  assert.match(worker, /catch \(error\) \{\s*return DEFAULT_BOOKING_LEAD_MINUTES/);
});

test('booking lead time is stored as a singleton validated setting', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS booking_settings/);
  assert.match(migration, /CHECK \(setting_id = 1\)/);
  assert.match(migration, /CHECK \(lead_minutes BETWEEN 0 AND 1440\)/);
  assert.match(worker, /\/api\/admin\/booking-settings\/get/);
  assert.match(worker, /\/api\/admin\/booking-settings\/save/);
});

test('lead time is enforced for display and final submission', () => {
  const checks = worker.match(/isInsideBookingLeadTime\(/g) || [];
  assert.ok(checks.length >= 5, 'helper plus four booking checks are required');
  assert.match(worker, /return json\(\{ ok: true, date, treatmentMinutes, leadMinutes, slots \}\)/);
  assert.match(worker, /この時間の受付は予約開始の\$\{leadMinutes\}分前で終了しました/);
  assert.match(worker, /この時間への変更受付は予約開始の\$\{leadMinutes\}分前で終了しました/);
});
