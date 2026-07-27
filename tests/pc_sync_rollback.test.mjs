import assert from 'node:assert/strict';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  rollbackPcSync
} from '../src/pc-sync-admin.js';

function fakeDatabase(target) {
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
      return statements.map(() => ({
        success: true,
        meta: { changes: 1 }
      }));
    }
  };
}

const eligible = {
  status: 'reconciled',
  is_active: 0,
  is_reconciled: 1,
  activated_at: '2026-07-20T10:00:00.000Z',
  retain_until: '2026-08-03T10:00:00.000Z'
};
const db = fakeDatabase(eligible);
const result = await rollbackPcSync(
  { jos_customer_db: db },
  { syncRunId: 'sync-old-1' },
  { now: new Date('2026-07-27T10:00:00.000Z') }
);
assert.equal(result.ok, true);
assert.equal(result.status, 'active');
assert.equal(result.rollback, true);
assert.equal(result.idempotent, false);
assert.equal(db.state.batches.length, 1);

const activeDb = fakeDatabase({
  ...eligible,
  status: 'active',
  is_active: 1
});
const retry = await rollbackPcSync(
  { jos_customer_db: activeDb },
  { syncRunId: 'sync-old-1' }
);
assert.equal(retry.idempotent, true);
assert.equal(retry.rollback, true);
assert.equal(activeDb.state.batches.length, 0);

await assert.rejects(
  () => rollbackPcSync(
    {
      jos_customer_db: fakeDatabase({
        ...eligible,
        activated_at: null
      })
    },
    { syncRunId: 'sync-never-active' }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'rollback_target_not_eligible'
);

await assert.rejects(
  () => rollbackPcSync(
    { jos_customer_db: fakeDatabase(eligible) },
    { syncRunId: 'sync-expired' },
    { now: new Date('2026-08-03T10:00:00.000Z') }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'rollback_target_expired'
);

console.log('PC sync rollback API: OK');
