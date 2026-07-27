import assert from 'node:assert/strict';
import { getPcSnapshotManifest } from '../src/pc-sync-admin.js';

const now = new Date('2026-07-28T02:00:00.000Z');
const active = {
  sync_run_id: 'active-run',
  schema_version: 1,
  contract_name: 'jos-pc-admin-snapshot',
  status: 'active',
  source_generated_at: '2026-07-28T01:30:00.000Z',
  received_customer_count: 2,
  received_metric_count: 2,
  received_customer_hash:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  received_metric_hash:
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  generation_id: 'active-run',
  is_active: 1,
  is_reconciled: 1
};
const manifestRows = [
  {
    customer_id: 'C0001',
    customer_row_hash:
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    metric_row_hash:
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  },
  {
    customer_id: 'C0002',
    customer_row_hash:
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    metric_row_hash:
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  }
];

function makeDb(activeRows, rows = manifestRows) {
  let call = 0;
  return {
    prepare() {
      call += 1;
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: call === 1 ? activeRows : rows };
        }
      };
    }
  };
}

const result = await getPcSnapshotManifest(
  { jos_customer_db: makeDb([active]) },
  { now }
);
assert.equal(result.ok, true);
assert.equal(result.customerCount, 2);
assert.equal(result.metricCount, 2);
assert.equal(result.records.length, 2);
assert.deepEqual(
  Object.keys(result.records[0]),
  ['customerId', 'customerRowHash', 'metricRowHash']
);
assert.equal(JSON.stringify(result).includes('customer_name'), false);
assert.equal(JSON.stringify(result).includes('phone'), false);

await assert.rejects(
  () => getPcSnapshotManifest(
    { jos_customer_db: makeDb([]) },
    { now }
  ),
  error => error && error.code === 'replica_unavailable'
);

await assert.rejects(
  () => getPcSnapshotManifest(
    {
      jos_customer_db: makeDb([{
        ...active,
        source_generated_at: '2026-07-26T01:30:00.000Z'
      }])
    },
    { now }
  ),
  error => error && error.code === 'replica_stale'
);

await assert.rejects(
  () => getPcSnapshotManifest(
    { jos_customer_db: makeDb([active], [manifestRows[0]]) },
    { now }
  ),
  error => error && error.code === 'replica_count_mismatch'
);

console.log('PC snapshot manifest API: OK');
