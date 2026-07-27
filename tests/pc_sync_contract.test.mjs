import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const fixturePath = new URL('./pc_sync_contract_fixture.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const customerKeys = [
  'customerId', 'name', 'kana', 'phone', 'customerType',
  'birthDate', 'route', 'referrer', 'storeMemo'
];
const metricKeys = [
  'customerId', 'visitCount', 'firstVisitDate', 'lastVisitDate',
  'nextReservationAt', 'nextReservationId', 'nextReservationMenu',
  'totalSales', 'averageSpend', 'normalCancelCount',
  'sameDayCancelCount', 'noShowCount', 'lineStatus',
  'lineDisplayName', 'metricsStatus'
];

function orderedRecord(record, keys) {
  const actualKeys = Object.keys(record);
  assert.deepEqual(
    actualKeys.slice().sort(),
    keys.slice().sort(),
    `契約外キーまたは不足キー: ${record.customerId || 'unknown'}`
  );
  return Object.fromEntries(keys.map(key => [key, record[key]]));
}

function sha256(text) {
  return 'sha256:' +
    crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function dataset(records, keys) {
  const sorted = records.slice().sort((a, b) =>
    String(a.customerId).localeCompare(String(b.customerId), 'en')
  );
  const rows = sorted.map(record => JSON.stringify(orderedRecord(record, keys)));
  const rowHashes = rows.map(sha256);
  return {
    sorted,
    rows,
    rowHashes,
    datasetHash: sha256(rowHashes.join(''))
  };
}

assert.equal(fixture.schemaVersion, 1);

const customers = dataset(fixture.customers, customerKeys);
const metrics = dataset(fixture.metrics, metricKeys);

assert.deepEqual(customers.sorted.map(row => row.customerId), ['T0001', 'T0002']);
assert.deepEqual(metrics.sorted.map(row => row.customerId), ['T0001', 'T0002']);

const zeroMetric = metrics.sorted[0];
assert.equal(zeroMetric.visitCount, 0);
assert.equal(zeroMetric.totalSales, 0);
assert.equal(zeroMetric.lastVisitDate, null);
assert.equal(zeroMetric.lineStatus, 'unlinked');

assert.match(customers.datasetHash, /^sha256:[0-9a-f]{64}$/);
assert.match(metrics.datasetHash, /^sha256:[0-9a-f]{64}$/);
assert.equal(
  customers.datasetHash,
  'sha256:7ab9b5302634a78bfcb90ceb5aae450214d127a52cbd3d0c9c65a961dc87db26'
);
assert.equal(
  metrics.datasetHash,
  'sha256:98f1df28486310354001dfb2cd56d6350a3258bf86f8ad10a2f01521bd83b672'
);

console.log(`CUSTOMER_DATASET_HASH=${customers.datasetHash}`);
console.log(`METRIC_DATASET_HASH=${metrics.datasetHash}`);
console.log('PC sync contract fixture: OK');
