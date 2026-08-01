import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0019_customer_lifecycle_notifications.sql', import.meta.url), 'utf8');

test('new registrations and existing-link requests notify at customer submission time', () => {
  assert.match(worker, /profile\.registrationType === 'new'/);
  assert.match(worker, /'new-registration'/);
  assert.match(worker, /'existing-link-request'/);
  assert.match(worker, /お客様ページ連携確認をしてください/);
  assert.match(worker, /pushLineText/);
});

test('admin linkage approval does not send a completion notification', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/approve')");
  const end = worker.indexOf("if (pathname === '/api/admin/reservation-actions/pending')", start);
  assert.ok(start >= 0 && end > start);
  const approvalRoute = worker.slice(start, end);
  assert.doesNotMatch(approvalRoute, /queueCustomerLifecycleNotification/);
  assert.match(approvalRoute, /申請通知はお客様の登録時点で送信済み/);
});

test('lifecycle notifications are durable, idempotent, and retried', () => {
  assert.match(migration, /event_key TEXT PRIMARY KEY/);
  assert.match(worker, /INSERT OR IGNORE INTO customer_lifecycle_notifications/);
  assert.match(worker, /status = 'pending'/);
  assert.match(worker, /flushPendingCustomerLifecycleNotifications/);
  assert.match(worker, /status = 'sent'/);
});
