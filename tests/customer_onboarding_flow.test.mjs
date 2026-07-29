import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker = fs.readFileSync(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);
const page = fs.readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);
const migration = fs.readFileSync(
  new URL('../migrations/0015_customer_registration_type.sql', import.meta.url),
  'utf8'
);

test('customer selects new or existing before registration', () => {
  assert.match(page, /name="registrationType" value="new"/);
  assert.match(page, /name="registrationType" value="existing"/);
  assert.match(page, /初めてのお客様は自動登録されます/);
  assert.match(page, /name="customerType" value="一般"/);
  assert.match(page, /name="customerType" value="学生"/);
  assert.match(
    page,
    /editing && profile && profile\.linkStatus === 'approved'/
  );
});

test('hiragana furigana is converted to katakana on client and server', () => {
  assert.match(page, /replace\(\/\[ぁ-ゖ\]\/g/);
  assert.match(worker, /function normalizeKana/);
  assert.match(worker, /lastKana: normalizeKana/);
  assert.match(worker, /firstKana: normalizeKana/);
});

test('registration metadata is persisted for guarded automatic creation', () => {
  assert.match(migration, /ADD COLUMN registration_type/);
  assert.match(migration, /ADD COLUMN customer_type/);
  assert.match(migration, /ADD COLUMN birthday/);
  assert.match(worker, /registration_type, customer_type, birthday/);
  assert.match(worker, /registrationType: row\.registration_type/);
});
