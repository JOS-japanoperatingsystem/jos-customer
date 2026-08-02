import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const worker = fs.readFileSync(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);
const migration = fs.readFileSync(
  new URL('../migrations/0025_customer_profile_update_birthday.sql', import.meta.url),
  'utf8'
);

test('profile update queue durably includes birthday', () => {
  assert.match(migration, /ADD COLUMN birthday TEXT NOT NULL DEFAULT ''/);
  assert.match(worker, /last_kana, first_kana, phone, birthday, status/);
  assert.match(worker, /phone: row\.phone,\s*birthday: row\.birthday \|\| ''/);
  assert.match(worker, /first_kana = \?, phone = \?, birthday = \?, updated_at/);
});

test('existing link approval queues identity update after customer id selection', () => {
  const start = worker.indexOf("if (pathname === '/api/admin/approve')");
  const end = worker.indexOf("if (pathname === '/api/admin/reservation-actions/pending')", start);
  const route = worker.slice(start, end);
  assert.match(route, /target\.registration_type \|\| 'existing'/);
  assert.match(route, /INSERT OR IGNORE INTO customer_profile_update_requests/);
  assert.match(route, /`link-\$\{approvalKey\}`/);
  assert.match(route, /env\.jos_customer_db\.batch\(statements\)/);
  assert.match(route, /target\.birthday \|\| ''/);
});
