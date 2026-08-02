import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function singleSendRoute() {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/single-send')");
  const end = worker.indexOf("if (pathname === '/api/admin/followups/draft-cancel')", start);
  assert.ok(start > 0 && end > start);
  return worker.slice(start, end);
}

test('single send requires one approved record and fresh JOS revalidation', () => {
  const route = singleSendRoute();
  assert.match(route, /confirmation !== '承認済みのお客様1人へ送信'/);
  assert.match(route, /validationAge[^]*> 60000/);
  assert.match(route, /delivery\.status !== 'approved'/);
  assert.match(route, /linkedProfiles\.length !== 1/);
  assert.doesNotMatch(route, /body\.lineSub|body\.customerId|一括/);
});

test('single send rechecks opt-out and recent delivery before atomic claim', () => {
  const route = singleSendRoute();
  assert.match(route, /followup_opt_outs WHERE jos_customer_id = \?/);
  assert.match(route, /status = 'sent' AND sent_at >= \?/);
  assert.match(route, /WHERE delivery_id = \? AND status = 'approved'/);
  assert.match(route, /claim[^]*meta[^]*changes[^]*!== 1/);
  assert.match(route, /attempt_count = attempt_count \+ 1/);
});

test('single send records failure and only reports sent after durable success', () => {
  const route = singleSendRoute();
  const pushAt = route.indexOf('await pushLineText');
  const sentAt = route.indexOf("SET status = 'sent'");
  const returnAt = route.lastIndexOf('sent: true');
  assert.ok(pushAt > 0 && sentAt > pushAt && returnAt > sentAt);
  assert.match(route, /SET status = 'failed'/);
  assert.match(route, /自動再送は行いません/);
  assert.match(route, /finalized[^]*meta[^]*changes[^]*!== 1/);
});
