import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0019_customer_lifecycle_notifications.sql', import.meta.url), 'utf8');

test('new and existing registrations notify safely at submission', () => {
  assert.match(worker, /profile\.registrationType === 'new'/);
  assert.match(worker, /'new-registration'/);
  const saveStart = worker.indexOf('async function saveProfile');
  const saveEnd = worker.indexOf('function adminAuthorized', saveStart);
  const saveRoute = worker.slice(saveStart, saveEnd);
  assert.match(saveRoute, /'existing-link-request'/);
  assert.match(worker, /【お客様ページ連携申請を受け付けました】/);
  assert.match(worker, /pushLineText/);
});

test('automatic linkage approval queues a completion notification for the administrator', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/approve')");
  const end = worker.indexOf("if (pathname === '/api/admin/reservation-actions/pending')", start);
  assert.ok(start >= 0 && end > start);
  const approvalRoute = worker.slice(start, end);
  assert.match(approvalRoute, /approvalMode === 'automatic'/);
  assert.match(approvalRoute, /queueCustomerLifecycleNotification/);
  assert.match(approvalRoute, /'auto-link-completed'/);
  assert.match(worker, /【お客様ページ自動連携完了】/);
  assert.match(worker, /氏名・生年月日・電話番号が一致し、候補が1人だけ/);
});

test('non-unique or incomplete matching queues one durable manual-review notification', () => {
  assert.match(worker, /\/api\/admin\/link-review-notify/);
  assert.match(worker, /'manual-link-review'/);
  assert.match(worker, /【お客様ページ連携・手動確認が必要】/);
  assert.match(worker, /氏名・生年月日・電話番号の完全一致が1人に絞れませんでした/);
  assert.match(worker, /link_status = 'pending'/);
});

test('lifecycle notifications are durable, idempotent, and retried', () => {
  assert.match(migration, /event_key TEXT PRIMARY KEY/);
  assert.match(worker, /INSERT OR IGNORE INTO customer_lifecycle_notifications/);
  assert.match(worker, /status = 'pending'/);
  assert.match(worker, /flushPendingCustomerLifecycleNotifications/);
  assert.match(worker, /status = 'sent'/);
});
