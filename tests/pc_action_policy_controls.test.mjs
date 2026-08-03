import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const worker = fs.readFileSync(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);

test('PC action list policy API exposes both automatic and manual restrictions read-only', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/policies/controls')");
  const end = worker.indexOf("if (pathname === '/api/admin/policy/get')", start);
  const route = worker.slice(start, end);
  assert.match(route, /automatic_restricted/);
  assert.match(route, /manual_restricted/);
  assert.match(route, /normal_cancel_count/);
  assert.match(route, /same_day_count/);
  assert.match(route, /no_show_count/);
  assert.match(route, /automaticRestricted:/);
  assert.match(route, /manualRestricted:/);
  assert.doesNotMatch(route, /INSERT|UPDATE|DELETE/);
});
