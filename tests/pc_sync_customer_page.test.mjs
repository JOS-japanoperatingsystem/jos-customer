import assert from 'node:assert/strict';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  receivePcCustomerPage
} from '../src/pc-sync-admin.js';

const hash = `sha256:${'a'.repeat(64)}`;
const record = {
  customerId: 'T0001',
  name: 'テスト 一郎',
  kana: 'テスト イチロウ',
  phone: null,
  customerType: '一般',
  birthDate: null,
  route: null,
  referrer: null,
  storeMemo: null,
  rowHash: hash
};
const payload = {
  schemaVersion: 1,
  syncRunId: 'sync-test-1',
  pageNumber: 1,
  totalPages: 1,
  recordCount: 1,
  pageHash: hash,
  records: [record]
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
  customer_page_count: 1
};

const db = fakeDatabase({ run: activeRun });
const result = await receivePcCustomerPage(
  { jos_customer_db: db },
  payload,
  { now: new Date('2026-07-27T10:10:00.000Z') }
);
assert.equal(result.ok, true);
assert.equal(result.idempotent, false);
assert.equal(db.state.batches.length, 1);
assert.equal(db.state.batches[0].length, 3);
assert.match(db.state.batches[0][0].sql, /INSERT INTO pc_customers_snapshot/);
assert.match(db.state.batches[0][1].sql, /INSERT INTO pc_sync_received_pages/);
assert.match(db.state.batches[0][2].sql, /UPDATE pc_sync_runs/);

const retryDb = fakeDatabase({
  run: activeRun,
  existing: { page_hash: hash, record_count: 1 }
});
const retry = await receivePcCustomerPage(
  { jos_customer_db: retryDb },
  payload,
  { now: new Date('2026-07-27T10:10:00.000Z') }
);
assert.equal(retry.idempotent, true);
assert.equal(retryDb.state.batches.length, 0);

await assert.rejects(
  () => receivePcCustomerPage(
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
  () => receivePcCustomerPage(
    {
      jos_customer_db: fakeDatabase({
        run: { ...activeRun, status: 'reconciled' }
      })
    },
    payload,
    { now: new Date('2026-07-27T10:10:00.000Z') }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'sync_run_not_building'
);

await assert.rejects(
  () => receivePcCustomerPage(
    { jos_customer_db: fakeDatabase({ run: activeRun }) },
    payload,
    { now: new Date('2026-07-27T11:00:00.000Z') }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'sync_run_expired'
);

console.log('PC sync customer page API: OK');
