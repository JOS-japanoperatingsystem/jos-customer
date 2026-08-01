import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0019_customer_lifecycle_notifications.sql', import.meta.url), 'utf8');

test('new registrations and approved existing links queue immediate LINE notifications', () => {
  assert.match(worker, /profile\.registrationType === 'new'/);
  assert.match(worker, /'new-registration'/);
  assert.match(worker, /target\.registration_type === 'existing'/);
  assert.match(worker, /'existing-link'/);
  assert.match(worker, /pushLineText/);
});

test('lifecycle notifications are durable, idempotent, and retried', () => {
  assert.match(migration, /event_key TEXT PRIMARY KEY/);
  assert.match(worker, /INSERT OR IGNORE INTO customer_lifecycle_notifications/);
  assert.match(worker, /status = 'pending'/);
  assert.match(worker, /flushPendingCustomerLifecycleNotifications/);
  assert.match(worker, /status = 'sent'/);
});
