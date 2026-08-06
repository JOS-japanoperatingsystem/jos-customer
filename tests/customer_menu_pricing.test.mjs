import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0026_menu_initial_and_customer_maintenance.sql', import.meta.url), 'utf8');

test('menu schema stores initial and customer-specific maintenance prices', () => {
  assert.match(migration, /initial_price/);
  assert.match(migration, /customer_menu_maintenance/);
  assert.match(migration, /customer_total/);
});

test('menu API and booking request use customer-specific maintenance price', () => {
  assert.match(worker, /customer-maintenance\/sync/);
  assert.match(worker, /cm\.maintenance_price/);
  assert.match(worker, /normal_total, student_total, customer_total/);
  assert.match(worker, /customerTotal: Number\(row\.customer_total/);
});

test('customer page shows general student and initial prices', () => {
  assert.doesNotMatch(page, /あなたの料金/);
  assert.doesNotMatch(page, /メンテナンス料金（設定対象の方）/);
  assert.doesNotMatch(page, /通常料金 合計/);
  assert.doesNotMatch(page, /新規料金 合計/);
  assert.doesNotMatch(page, /予定料金/);
  assert.match(page, /'一般 ' \+ normalLabel \+ ' \/ 学生 '/);
  assert.match(page, /' \/ 新規 ' \+ formatYen\(initial\)/);
  assert.match(page, /includes\('全身'\) && normal === 12500/);
  assert.match(page, /12,500〜15,000円/);
  assert.match(page, /料金はお客様ごとに異なるため、店舗でご案内します/);
});
