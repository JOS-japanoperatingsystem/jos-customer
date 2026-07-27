import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PcSyncContractError
} from '../src/pc-sync-contract.js';
import {
  validatePcSync
} from '../src/pc-sync-admin.js';

globalThis.crypto ||= crypto.webcrypto;

const rowHash = `sha256:${'a'.repeat(64)}`;
const datasetHash = 'sha256:' +
  crypto.createHash('sha256').update(rowHash, 'utf8').digest('hex');

function fakeDatabase({ mismatch = false } = {}) {
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
              if (/source_customer_count/.test(sql)) {
                return {
                  status: 'building',
                  expires_at: '2026-07-27T11:00:00.000Z',
                  source_customer_count: mismatch ? 2 : 1,
                  source_metric_count: 1,
                  customer_page_count: 1,
                  metric_page_count: 1,
                  source_customer_hash: datasetHash,
                  source_metric_hash: datasetHash
                };
              }
              if (/dataset_type = 'customers'/.test(sql)) {
                return { page_count: 1, record_count: 1 };
              }
              if (/dataset_type = 'metrics'/.test(sql)) {
                return { page_count: 1, record_count: 1 };
              }
              if (/LEFT JOIN/.test(sql)) {
                return { value: 0 };
              }
              if (/COUNT\(\*\) AS value/.test(sql)) {
                return { value: 1 };
              }
              return null;
            },
            async all() {
              return {
                results: [{ customer_id: 'T0001', row_hash: rowHash }]
              };
            }
          };
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
const result = await validatePcSync(
  { jos_customer_db: db },
  { syncRunId: 'sync-test-1' },
  {
    now: new Date('2026-07-27T10:10:00.000Z'),
    createId: (() => {
      let index = 0;
      return () => `result-${++index}`;
    })()
  }
);
assert.equal(result.status, 'reconciled');
assert.equal(result.customerCount, 1);
assert.equal(result.metricCount, 1);
assert.equal(result.customerHash, datasetHash);
assert.equal(db.state.batches.length, 1);
assert.match(
  db.state.batches[0][db.state.batches[0].length - 2].sql,
  /status = 'reconciled'/
);
assert.match(
  db.state.batches[0][db.state.batches[0].length - 1].sql,
  /is_reconciled = 1/
);

const mismatchDb = fakeDatabase({ mismatch: true });
await assert.rejects(
  () => validatePcSync(
    { jos_customer_db: mismatchDb },
    { syncRunId: 'sync-test-2' },
    {
      now: new Date('2026-07-27T10:10:00.000Z'),
      createId: () => crypto.randomUUID()
    }
  ),
  error =>
    error instanceof PcSyncContractError &&
    error.code === 'reconciliation_failed'
);
assert.equal(mismatchDb.state.batches.length, 1);
assert.match(
  mismatchDb.state.batches[0][mismatchDb.state.batches[0].length - 1].sql,
  /status = 'failed'/
);

console.log('PC sync validation API: OK');
