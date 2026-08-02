import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../migrations/0021_followup_line_admin_tests.sql', import.meta.url),
  'utf8'
);

test('admin follow-up test is restricted to configured notification recipient', () => {
  const statusStart = worker.indexOf("if (pathname === '/api/admin/followups/admin-test-status')");
  const sendStart = worker.indexOf("if (pathname === '/api/admin/followups/admin-test-send')");
  assert.ok(statusStart > 0 && sendStart > statusStart);
  const statusRoute = worker.slice(statusStart, sendStart);
  assert.match(statusRoute, /line_notification_settings WHERE setting_id = 1/);
  assert.doesNotMatch(statusRoute, /flushPending|pushLineText|UPDATE|INSERT/);
  const start = worker.indexOf("if (pathname === '/api/admin/followups/admin-test-send')");
  const end = worker.indexOf("if (pathname === '/api/admin/bookings/recent')", start);
  assert.ok(start > 0 && end > start);
  const route = worker.slice(start, end);
  assert.match(route, /confirmation !== '管理者本人へテスト送信'/);
  assert.match(route, /line_notification_settings WHERE setting_id = 1/);
  assert.doesNotMatch(route, /body\.lineSub|body\.customerId|customer_profiles/);
  assert.match(route, /followupAdminTestMessage\(messageType\)/);
});

test('admin follow-up test is durable, idempotent and records failures', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS followup_admin_tests/);
  assert.match(migration, /test_id TEXT PRIMARY KEY/);
  assert.match(migration, /'sending', 'sent', 'failed'/);
  assert.match(worker, /if \(existing\.status === 'sent'\)/);
  assert.match(worker, /idempotent: true/);
  assert.match(worker, /SET status = 'sent'/);
  assert.match(worker, /SET status = 'failed'/);
  assert.match(worker, /throw error/);
});

test('LINE message normalization preserves line breaks', () => {
  assert.match(worker, /function normalizeLineMessage/);
  assert.match(worker, /messages: \[\{ type: 'text', text: normalizeLineMessage\(text, 4500\) \}\]/);
});
