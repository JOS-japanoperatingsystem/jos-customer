import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../migrations/0023_reservation_reminder_batch_drafts.sql', import.meta.url), 'utf8'
);

test('reservation reminder batch draft persists without any LINE sending route', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/reminders/batch-save')");
  const end = worker.indexOf("if (pathname === '/api/admin/reminders/batch-approve')");
  const routes = worker.slice(start, end);
  assert.match(routes, /confirmation !== '送信せず18時予定を保存'/);
  assert.match(routes, /VALUES \(\?, \?, \?, 'draft'/);
  assert.match(routes, /同じ予約またはお客様が重複しています/);
  assert.doesNotMatch(routes, /pushLineText/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS reservation_reminder_batches/);
  assert.match(migration, /UNIQUE \(batch_id, reservation_id\)/);
  assert.match(migration, /UNIQUE \(batch_id, jos_customer_id\)/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|ALTER TABLE/);
});

test('approved reminder batch sends only freshly revalidated deliveries once', () => {
  assert.match(worker, /\/api\/admin\/reminders\/batch-approve/);
  assert.match(worker, /confirmation !== '確認済み候補を本日18時に送信予約'/);
  assert.match(worker, /確認済み候補を今すぐ送信予約/);
  assert.match(worker, /effectiveScheduledFor = immediate \? now : batch\.scheduled_for/);
  assert.match(worker, /scheduled_for = \?/);
  assert.match(worker, /\/api\/admin\/reminders\/batch-due/);
  assert.match(worker, /\/api\/admin\/reminders\/delivery-send/);
  assert.match(worker, /confirmation !== '18時予定の確認済み1件を送信'/);
  assert.match(worker, /validationAge|const age = Date\.now\(\) - revalidatedAt\.getTime\(\)/);
  assert.match(worker, /WHERE delivery_id = \? AND status = 'scheduled'/);
  assert.match(worker, /pushLineText\(env, linked\[0\]\.line_sub, delivery\.message_text\)/);
  assert.match(worker, /status = 'failed'/);
  assert.match(worker, /\/api\/admin\/reminders\/delivery-fail/);
  assert.match(worker, /送信失敗を記録し自動再送しない/);
});
