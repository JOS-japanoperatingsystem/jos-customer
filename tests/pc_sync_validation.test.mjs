import assert from 'node:assert/strict';
import {
  PcSyncContractError,
  validateCustomerPage,
  validateMetricPage,
  validateStartPayload
} from '../src/pc-sync-contract.js';

const hash = `sha256:${'a'.repeat(64)}`;

const validStart = {
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

const validCustomer = {
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

const validMetric = {
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

function page(record) {
  return {
    schemaVersion: 1,
    syncRunId: 'sync-test-1',
    pageNumber: 1,
    totalPages: 1,
    recordCount: 1,
    pageHash: hash,
    records: [record]
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error =>
    error instanceof PcSyncContractError && error.code === code
  );
}

assert.equal(validateStartPayload(validStart), validStart);
assert.equal(validateCustomerPage(page(validCustomer)).records[0].phone, null);
assert.equal(validateMetricPage(page(validMetric)).records[0].visitCount, 0);
assert.equal(validateMetricPage(page(validMetric)).records[0].totalSales, 0);

expectCode(
  () => validateStartPayload({ ...validStart, schemaVersion: 2 }),
  'unsupported_schema_version'
);
expectCode(
  () => validateCustomerPage({
    ...page(validCustomer),
    recordCount: 2
  }),
  'record_count_mismatch'
);
expectCode(
  () => validateCustomerPage(page({
    ...validCustomer,
    unexpected: 'reject'
  })),
  'invalid_keys'
);
expectCode(
  () => validateMetricPage(page({
    ...validMetric,
    totalSales: null
  })),
  'invalid_integer'
);
expectCode(
  () => validateMetricPage(page({
    ...validMetric,
    metricsStatus: 'unavailable'
  })),
  'metrics_unavailable'
);
expectCode(
  () => validateMetricPage(page({
    ...validMetric,
    lineStatus: 'unknown'
  })),
  'invalid_line_status'
);
expectCode(
  () => validateMetricPage(page({
    ...validMetric,
    rowHash: 'not-a-hash'
  })),
  'invalid_hash'
);

console.log('PC sync payload validation: OK');
