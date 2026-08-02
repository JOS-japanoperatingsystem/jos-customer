import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

test('approved profile API provides the customer-entered name for reminder addressing', () => {
  const endpoint = worker.slice(
    worker.indexOf("if (pathname === '/api/admin/approved')"),
    worker.indexOf("if (pathname === '/api/admin/reservations/sync')")
  );
  assert.match(endpoint, /SELECT jos_customer_id, last_name, first_name/);
  assert.match(endpoint, /registeredCustomerName/);
  assert.match(endpoint, /row\.last_name/);
  assert.match(endpoint, /row\.first_name/);
  assert.doesNotMatch(endpoint, /line_display_name/);
});
