import assert from 'node:assert/strict';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  receivePcMetricPage
} from '../src/pc-sync-admin.js';

const hash = `sha256:${'a'.repeat(64)}`;
const metric = {
  customerId: 'T0001',
  visitCount: 0,
  firstVisitDate: null,
  lastVisitDate: null,
  nextReservationAt: null,
  nextReservationId: null,
  nextReservationMenu: null,
  totalSales: 0,
  averageSpend: 0,
  normalCancelCount: 0,
  sameDayCancelCount: 0,
  noShowCount: 0,
  lineStatus: 'unlinked',
  lineDisplayName: null,
  metricsStatus: 'verified',
  rowHash: hash
};
const payload = {
  schemaVersion: 1,
  syncRunId: 'sync-test-1',
  pageNumber: 1,
  totalPages: 1,
  recordCount: 1,
  pageHash: hash,
  records: [metric]
};

function fakeDatabase({ run, existing = null } = {}) {
  const state = { batches: [], statements: [] };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = {
            sql,
            values,
            async first() {
              if (/FROM pc_sync_runs/.test(sql)) return run || null;
              if (/FROM pc_sync_received_pages/.test(sql)) return existing;
              return null;
            }
          };
          state.statements.push(statement);
          return statement;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };
}

const activeRun = {
  status: 'building',
  schema_version: 1,
  expires_at: '2026-07-27T11:00:00.000Z',
  metric_page_count: 1
};

const db = fakeDatabase({ run: activeRun });
const result = await receivePcMetricPage(
  { jos_customer_db: db },
  payload,
  { now: new Date('2026-07-27T10:10:00.000Z') }
);
assert.equal(result.ok, true);
assert.equal(result.idempotent, false);
assert.equal(db.state.batches.length, 1);
assert.equal(db.state.batches[0].length, 3);
assert.match(
  db.state.batches[0][0].sql,
  /INSERT INTO pc_customer_metrics_snapshot/
);
assert.equal(db.state.batches[0][0].values[2], 0);
assert.equal(db.state.batches[0][0].values[8], 0);

const retryDb = fakeDatabase({
  run: activeRun,
  existing: { page_hash: hash, record_count: 1 }
});
const retry = await receivePcMetricPage(
  { jos_customer_db: retryDb },
  payload,
  { now: new Date('2026-07-27T10:10:00.000Z') }
);
assert.equal(retry.idempotent, true);
assert.equal(retryDb.state.batches.length, 0);

await assert.rejects(
  () => receivePcMetricPage(
    {
      jos_customer_db: fakeDatabase({
        run: activeRun,
        existing: {
          page_hash: `sha256:${'b'.repeat(64)}`,
          record_count: 1
        }
      })
    },
    payload,
    { now: new Date('2026-07-27T10:10:00.000Z') }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'page_hash_conflict'
);

await assert.rejects(
  () => receivePcMetricPage(
    { jos_customer_db: fakeDatabase({ run: activeRun }) },
    {
      ...payload,
      records: [{ ...metric, metricsStatus: 'unavailable' }]
    },
    { now: new Date('2026-07-27T10:10:00.000Z') }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'metrics_unavailable'
);

console.log('PC sync metric page API: OK');
