import assert from 'node:assert/strict';
import { getPcSyncStatus } from '../src/pc-sync-admin.js';

function makeDb(activeRows, recentRows) {
  let call = 0;
  return {
    prepare() {
      call += 1;
      return {
        async all() {
          return { results: call === 1 ? activeRows : recentRows };
        }
      };
    }
  };
}

const now = new Date('2026-07-27T12:00:00.000Z');
const active = {
  sync_run_id: 'run-active',
  generation_id: 'run-active',
  status: 'active',
  is_active: 1,
  is_reconciled: 1,
  started_at: '2026-07-27T11:00:00.000Z',
  finished_at: '2026-07-27T11:01:00.000Z',
  source_generated_at: '2026-07-27T10:59:00.000Z',
  received_customer_count: 2,
  received_metric_count: 2,
  activated_at: '2026-07-27T11:02:00.000Z',
  retain_until: '2026-08-03T11:00:00.000Z'
};
const normalRun = {
  sync_run_id: 'run-active',
  status: 'active',
  started_at: active.started_at,
  finished_at: active.finished_at,
  expires_at: '2026-07-27T11:30:00.000Z',
  source_generated_at: active.source_generated_at,
  activated_at: active.activated_at,
  error_code: null,
  error_message: null
};

const healthy = await getPcSyncStatus(
  { jos_customer_db: makeDb([active], [normalRun]) },
  { now }
);
assert.equal(healthy.health, 'healthy');
assert.equal(healthy.canServeFromD1, true);
assert.equal(healthy.activeGeneration.customerCount, 2);
assert.deepEqual(healthy.issues, []);

const noActive = await getPcSyncStatus(
  { jos_customer_db: makeDb([], [normalRun]) },
  { now }
);
assert.equal(noActive.health, 'unavailable');
assert.equal(noActive.canServeFromD1, false);
assert.equal(noActive.issues[0].code, 'active_generation_missing');

const expiredRun = {
  ...normalRun,
  sync_run_id: 'run-expired',
  status: 'building',
  expires_at: '2026-07-27T11:30:00.000Z',
  activated_at: null
};
const degraded = await getPcSyncStatus(
  { jos_customer_db: makeDb([active], [expiredRun]) },
  { now }
);
assert.equal(degraded.health, 'degraded');
assert.equal(degraded.canServeFromD1, true);
assert.equal(degraded.recentRuns[0].expired, true);
assert.equal(degraded.issues[0].code, 'sync_run_expired');

const failedRun = {
  ...normalRun,
  sync_run_id: 'run-failed',
  status: 'failed',
  error_code: 'dataset_hash_mismatch',
  error_message: '照合に失敗しました。',
  activated_at: null
};
const failed = await getPcSyncStatus(
  { jos_customer_db: makeDb([active], [failedRun]) },
  { now }
);
assert.equal(failed.health, 'degraded');
assert.equal(failed.issues[0].code, 'sync_run_failed');
assert.equal(failed.issues[0].errorCode, 'dataset_hash_mismatch');

await assert.rejects(
  () => getPcSyncStatus({}),
  error => error && error.code === 'database_unavailable'
);

console.log('PC sync status API: OK');
