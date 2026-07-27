import assert from 'node:assert/strict';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  startPcSync
} from '../src/pc-sync-admin.js';

const hash = `sha256:${'a'.repeat(64)}`;
const validPayload = {
  schemaVersion: 1,
  contractName: 'jos-pc-admin-snapshot',
  sourceGeneratedAt: '2026-07-27T10:00:00.000Z',
  expectedCustomerCount: 1,
  expectedMetricCount: 1,
  customerPageCount: 1,
  metricPageCount: 1,
  customerDatasetHash: hash,
  metricDatasetHash: hash
};

function fakeDatabase() {
  const state = {
    statements: [],
    batches: []
  };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = { sql, values };
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

const db = fakeDatabase();
const result = await startPcSync(
  { jos_customer_db: db },
  validPayload,
  {
    now: new Date('2026-07-27T10:05:00.000Z'),
    createId: () => 'sync-test-1'
  }
);

assert.deepEqual(result, {
  ok: true,
  syncRunId: 'sync-test-1',
  status: 'building',
  expiresAt: '2026-07-27T10:35:00.000Z'
});
assert.equal(db.state.batches.length, 1);
assert.equal(db.state.batches[0].length, 2);
assert.match(db.state.statements[0].sql, /INSERT INTO pc_sync_runs/);
assert.match(db.state.statements[1].sql, /INSERT INTO pc_sync_generations/);
assert.equal(db.state.statements[0].values[0], 'sync-test-1');
assert.equal(db.state.statements[1].values[0], 'sync-test-1');
assert.equal(db.state.statements[1].values[2], '2026-08-03T10:05:00.000Z');

const rejectedDb = fakeDatabase();
await assert.rejects(
  () => startPcSync(
    { jos_customer_db: rejectedDb },
    { ...validPayload, expectedCustomerCount: -1 }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'invalid_integer'
);
assert.equal(rejectedDb.state.batches.length, 0);

await assert.rejects(
  () => startPcSync(
    {},
    validPayload,
    { createId: () => 'sync-test-2' }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'database_unavailable'
);

console.log('PC sync start API: OK');
