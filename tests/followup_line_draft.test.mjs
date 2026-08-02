import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

test('follow-up draft save never sends LINE and requires explicit confirmation', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/draft-save')");
  const end = worker.indexOf("if (pathname === '/api/admin/bookings/recent')", start);
  assert.ok(start > 0 && end > start);
  const route = worker.slice(start, end);
  assert.match(route, /confirmation !== '送信せず下書き保存'/);
  assert.match(route, /status, created_at\)\s+VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, 'draft', \?\)/);
  assert.doesNotMatch(route, /pushLineText|fetch\(|status = 'sent'/);
});

test('follow-up draft save rechecks safety and is idempotent', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/draft-save')");
  const end = worker.indexOf("if (pathname === '/api/admin/bookings/recent')", start);
  const route = worker.slice(start, end);
  assert.match(route, /link_status = 'approved'/);
  assert.match(route, /matching_count[^]*!== 1/);
  assert.match(route, /followup_opt_outs WHERE jos_customer_id = \?/);
  assert.match(route, /dueDate !== expectedDueDate/);
  assert.match(route, /existing\.status === 'draft'/);
  assert.match(route, /idempotent: true/);
});

test('safety state includes active drafts so they leave the candidate list', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/safety-state')");
  const end = worker.indexOf("if (pathname === '/api/admin/approved')", start);
  const route = worker.slice(start, end);
  assert.match(route, /status IN \('draft', 'approved', 'sending', 'sent'\)/);
});

test('draft list is read-only and exposes no LINE recipient identifier', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/drafts')");
  const end = worker.indexOf("if (pathname === '/api/admin/followups/draft-cancel')", start);
  assert.ok(start > 0 && end > start);
  const route = worker.slice(start, end);
  assert.match(route, /WHERE status = 'draft'/);
  assert.match(route, /readOnly: true/);
  assert.doesNotMatch(route, /line_sub|pushLineText|INSERT|UPDATE|DELETE/);
});

test('only drafts can be cancelled and cancellation never sends LINE', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/draft-cancel')");
  const end = worker.indexOf("if (pathname === '/api/admin/bookings/recent')", start);
  assert.ok(start > 0 && end > start);
  const route = worker.slice(start, end);
  assert.match(route, /confirmation !== '下書きを取り消す'/);
  assert.match(route, /existing\.status !== 'draft'/);
  assert.match(route, /SET status = 'cancelled'/);
  assert.match(route, /WHERE delivery_id = \? AND status = 'draft'/);
  assert.match(route, /existing\.status === 'cancelled'/);
  assert.doesNotMatch(route, /pushLineText|fetch\(|DELETE/);
});
