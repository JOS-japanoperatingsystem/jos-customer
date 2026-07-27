import assert from 'node:assert/strict';
import { expirePcSyncRuns } from '../src/pc-sync-admin.js';

function makeDb(candidates, changes = []) {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          return { results: candidates };
        }
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      assert.equal(statements.length, candidates.length);
      return statements.map((statement, index) => ({
        meta: { changes: changes[index] ?? 1 }
      }));
    }
  };
}

const now = new Date('2026-07-27T12:00:00.000Z');
const db = makeDb(
  [{ sync_run_id: 'expired-1' }, { sync_run_id: 'expired-2' }],
  [1, 1]
);
const result = await expirePcSyncRuns({ jos_customer_db: db }, { now });

assert.equal(result.ok, true);
assert.equal(result.expiredCount, 2);
assert.deepEqual(result.expiredSyncRunIds, ['expired-1', 'expired-2']);
assert.equal(result.idempotent, false);
assert.match(db.prepared[0].sql, /status = 'building'/);
assert.match(db.prepared[0].sql, /expires_at <= \?/);
assert.match(db.prepared[1].sql, /status = 'failed'/);
assert.match(db.prepared[1].sql, /error_code = 'sync_expired'/);
assert.deepEqual(
  db.prepared[1].values,
  [now.toISOString(), 'expired-1', now.toISOString()]
);

const racedDb = makeDb(
  [{ sync_run_id: 'already-completed' }],
  [0]
);
const raced = await expirePcSyncRuns(
  { jos_customer_db: racedDb },
  { now }
);
assert.equal(raced.expiredCount, 0);
assert.deepEqual(raced.expiredSyncRunIds, []);
assert.equal(raced.idempotent, true);

const emptyDb = makeDb([]);
const empty = await expirePcSyncRuns(
  { jos_customer_db: emptyDb },
  { now }
);
assert.equal(empty.expiredCount, 0);
assert.equal(empty.idempotent, true);
assert.equal(emptyDb.prepared.length, 1);

await assert.rejects(
  () => expirePcSyncRuns({}),
  error => error && error.code === 'database_unavailable'
);

console.log('PC sync expiration API: OK');
