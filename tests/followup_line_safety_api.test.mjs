import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

test('admin safety endpoint exposes only linkage, opt-out and follow-up history', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/followups/safety-state')");
  const end = worker.indexOf("if (pathname === '/api/admin/approved')", start);
  assert.ok(start >= 0 && end > start);
  const route = worker.slice(start, end);
  assert.match(route, /followup_opt_outs/);
  assert.match(route, /followup_deliveries/);
  assert.match(route, /status IN \('draft', 'approved', 'sending', 'sent', 'failed'\)/);
  assert.match(route, /readOnly:\s*true/);
  assert.doesNotMatch(route, /pushLineText|INSERT|UPDATE|DELETE/);
});
