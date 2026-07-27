import assert from 'node:assert/strict';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  activatePcSync
} from '../src/pc-sync-admin.js';

function fakeDatabase(target, changes = [1, 1, 1, 1]) {
  const state = { batches: [] };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            async first() {
              return target;
            }
          };
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return changes.map(value => ({
        success: true,
        meta: { changes: value }
      }));
    }
  };
}

const db = fakeDatabase({
  status: 'reconciled',
  is_active: 0,
  is_reconciled: 1
});
const result = await activatePcSync(
  { jos_customer_db: db },
  { syncRunId: 'sync-test-1' },
  { now: new Date('2026-07-27T10:20:00.000Z') }
);
assert.deepEqual(result, {
  ok: true,
  syncRunId: 'sync-test-1',
  status: 'active',
  activatedAt: '2026-07-27T10:20:00.000Z',
  idempotent: false
});
assert.equal(db.state.batches.length, 1);
assert.equal(db.state.batches[0].length, 4);
assert.match(db.state.batches[0][0].sql, /status = 'reconciled'/);
assert.match(db.state.batches[0][1].sql, /is_active = 0/);
assert.match(db.state.batches[0][2].sql, /is_active = 1/);
assert.match(db.state.batches[0][3].sql, /status = 'active'/);

const retryDb = fakeDatabase({
  status: 'active',
  is_active: 1,
  is_reconciled: 1
});
const retry = await activatePcSync(
  { jos_customer_db: retryDb },
  { syncRunId: 'sync-test-1' }
);
assert.equal(retry.idempotent, true);
assert.equal(retryDb.state.batches.length, 0);

await assert.rejects(
  () => activatePcSync(
    {
      jos_customer_db: fakeDatabase({
        status: 'building',
        is_active: 0,
        is_reconciled: 0
      })
    },
    { syncRunId: 'sync-test-2' }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'sync_run_not_reconciled'
);

await assert.rejects(
  () => activatePcSync(
    {
      jos_customer_db: fakeDatabase({
        status: 'reconciled',
        is_active: 0,
        is_reconciled: 1
      }, [1, 1, 0, 0])
    },
    { syncRunId: 'sync-test-3' }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'activation_not_confirmed'
);

console.log('PC sync activation API: OK');
