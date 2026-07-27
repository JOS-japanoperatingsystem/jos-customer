import assert from 'node:assert/strict';
import { getPcAdminCustomers } from '../src/pc-sync-admin.js';

const active = {
  sync_run_id: 'active-read-run',
  schema_version: 1,
  contract_name: 'jos-pc-admin-snapshot',
  status: 'active',
  source_generated_at: '2026-07-28T02:30:00.000Z',
  received_customer_count: 1,
  received_metric_count: 1,
  received_customer_hash:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  received_metric_hash:
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  generation_id: 'active-read-run',
  is_active: 1,
  is_reconciled: 1
};
const hashRows = [{
  customer_id: 'C0001',
  customer_row_hash:
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  metric_row_hash:
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
}];
const customerRows = [{
  customer_id: 'C0001',
  customer_name: '匿名確認',
  customer_kana: 'トクメイカクニン',
  phone: null,
  customer_type: '一般',
  birth_date: null,
  route: null,
  referrer: null,
  store_memo: null,
  visit_count: 0,
  first_visit_date: null,
  last_visit_date: null,
  next_reservation_at: null,
  next_reservation_id: null,
  next_reservation_menu: null,
  total_sales: 0,
  average_spend: 0,
  normal_cancel_count: 0,
  same_day_cancel_count: 0,
  no_show_count: 0,
  line_status: 'unavailable',
  line_display_name: null,
  metrics_status: 'verified'
}];

function makeDb(rows = customerRows) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async all() {
          if (sql.includes('WHERE g.is_active = 1')) {
            return { results: [active] };
          }
          if (sql.includes('c.row_hash AS customer_row_hash')) {
            return { results: hashRows };
          }
          if (sql.includes('c.customer_name')) {
            return { results: rows };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }
      };
    }
  };
}

const result = await getPcAdminCustomers(
  { jos_customer_db: makeDb() },
  { page: 1, pageSize: 50 },
  { now: new Date('2026-07-28T03:00:00.000Z') }
);
assert.equal(result.ok, true);
assert.equal(result.generationId, 'active-read-run');
assert.equal(result.totalCount, 1);
assert.equal(result.hasNext, false);
assert.equal(result.records[0].visitCount, 0);
assert.equal(result.records[0].totalSales, 0);
assert.equal(result.records[0].lineStatus, 'unavailable');
assert.equal(result.records[0].phone, null);
assert.equal(result.records[0].metricsStatus, 'verified');

await assert.rejects(
  () => getPcAdminCustomers(
    { jos_customer_db: makeDb() },
    { page: 1, pageSize: 101 },
    { now: new Date('2026-07-28T03:00:00.000Z') }
  ),
  error => error && error.code === 'invalid_pagination'
);

await assert.rejects(
  () => getPcAdminCustomers(
    { jos_customer_db: makeDb([{
      ...customerRows[0],
      metrics_status: 'unavailable'
    }]) },
    {},
    { now: new Date('2026-07-28T03:00:00.000Z') }
  ),
  error => error && error.code === 'replica_data_invalid'
);

console.log('PC admin guarded customer read API: OK');
