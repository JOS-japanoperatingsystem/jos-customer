export const PC_SYNC_SCHEMA_VERSION = 1;
export const PC_SYNC_CONTRACT_NAME = 'jos-pc-admin-snapshot';

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CUSTOMER_KEYS = [
  'customerId', 'name', 'kana', 'phone', 'customerType',
  'birthDate', 'route', 'referrer', 'storeMemo', 'rowHash'
];

const METRIC_KEYS = [
  'customerId', 'visitCount', 'firstVisitDate', 'lastVisitDate',
  'nextReservationAt', 'nextReservationId', 'nextReservationMenu',
  'totalSales', 'averageSpend', 'normalCancelCount',
  'sameDayCancelCount', 'noShowCount', 'lineStatus',
  'lineDisplayName', 'metricsStatus', 'rowHash'
];

export class PcSyncContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PcSyncContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PcSyncContractError(code, message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label}はオブジェクトである必要があります。`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = expected.slice().sort();
  if (actual.length !== required.length ||
      actual.some((key, index) => key !== required[index])) {
    fail('invalid_keys', `${label}の項目が契約と一致しません。`);
  }
}

function requireString(value, label, maxLength, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_string', `${label}は空でない文字列である必要があります。`);
  }
  if (value.length > maxLength) {
    fail('string_too_long', `${label}が最大文字数を超えています。`);
  }
}

function requireNullableString(value, label, maxLength) {
  if (value === null) return;
  if (typeof value !== 'string') {
    fail('invalid_nullable_string', `${label}は文字列またはnullである必要があります。`);
  }
  if (value.length > maxLength) {
    fail('string_too_long', `${label}が最大文字数を超えています。`);
  }
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail('invalid_integer', `${label}は${minimum}以上の整数である必要があります。`);
  }
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('invalid_hash', `${label}は正しいSHA-256形式である必要があります。`);
  }
}

function requireIsoUtc(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' ||
      !ISO_UTC_PATTERN.test(value) ||
      Number.isNaN(Date.parse(value))) {
    fail('invalid_datetime', `${label}はUTCのISO 8601日時である必要があります。`);
  }
}

function requireDate(value, label) {
  if (value === null) return;
  if (typeof value !== 'string' ||
      !DATE_PATTERN.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail('invalid_date', `${label}はYYYY-MM-DDまたはnullである必要があります。`);
  }
}

function validateCommonPage(payload) {
  requireObject(payload, 'ページ');
  requireInteger(payload.schemaVersion, 'schemaVersion', 1);
  if (payload.schemaVersion !== PC_SYNC_SCHEMA_VERSION) {
    fail('unsupported_schema_version', '未対応のスキーマバージョンです。');
  }
  requireString(payload.syncRunId, 'syncRunId', 100);
  requireInteger(payload.pageNumber, 'pageNumber', 1);
  requireInteger(payload.totalPages, 'totalPages', 1);
  if (payload.pageNumber > payload.totalPages) {
    fail('invalid_page_number', 'pageNumberがtotalPagesを超えています。');
  }
  requireInteger(payload.recordCount, 'recordCount');
  requireHash(payload.pageHash, 'pageHash');
  if (!Array.isArray(payload.records)) {
    fail('invalid_records', 'recordsは配列である必要があります。');
  }
  if (payload.records.length !== payload.recordCount) {
    fail('record_count_mismatch', 'recordCountとrecords件数が一致しません。');
  }
}

export function validateStartPayload(payload) {
  const keys = [
    'schemaVersion', 'contractName', 'sourceGeneratedAt',
    'expectedCustomerCount', 'expectedMetricCount',
    'customerPageCount', 'metricPageCount',
    'customerDatasetHash', 'metricDatasetHash'
  ];
  requireObject(payload, '同期開始ペイロード');
  requireExactKeys(payload, keys, '同期開始ペイロード');
  requireInteger(payload.schemaVersion, 'schemaVersion', 1);
  if (payload.schemaVersion !== PC_SYNC_SCHEMA_VERSION) {
    fail('unsupported_schema_version', '未対応のスキーマバージョンです。');
  }
  if (payload.contractName !== PC_SYNC_CONTRACT_NAME) {
    fail('invalid_contract_name', '契約名が一致しません。');
  }
  requireIsoUtc(payload.sourceGeneratedAt, 'sourceGeneratedAt');
  requireInteger(payload.expectedCustomerCount, 'expectedCustomerCount');
  requireInteger(payload.expectedMetricCount, 'expectedMetricCount');
  requireInteger(payload.customerPageCount, 'customerPageCount');
  requireInteger(payload.metricPageCount, 'metricPageCount');
  if ((payload.expectedCustomerCount === 0) !==
      (payload.customerPageCount === 0)) {
    fail('customer_page_count_mismatch', '顧客件数とページ数の関係が不正です。');
  }
  if ((payload.expectedMetricCount === 0) !==
      (payload.metricPageCount === 0)) {
    fail('metric_page_count_mismatch', '集計件数とページ数の関係が不正です。');
  }
  requireHash(payload.customerDatasetHash, 'customerDatasetHash');
  requireHash(payload.metricDatasetHash, 'metricDatasetHash');
  return payload;
}

export function validateCustomerPage(payload) {
  const pageKeys = [
    'schemaVersion', 'syncRunId', 'pageNumber',
    'totalPages', 'recordCount', 'pageHash', 'records'
  ];
  requireObject(payload, '顧客ページ');
  requireExactKeys(payload, pageKeys, '顧客ページ');
  validateCommonPage(payload);
  const ids = new Set();
  payload.records.forEach((record, index) => {
    const label = `customers[${index}]`;
    requireObject(record, label);
    requireExactKeys(record, CUSTOMER_KEYS, label);
    requireString(record.customerId, `${label}.customerId`, 80);
    if (ids.has(record.customerId)) {
      fail('duplicate_customer_id', '同じページ内に顧客IDの重複があります。');
    }
    ids.add(record.customerId);
    requireNullableString(record.name, `${label}.name`, 200);
    requireNullableString(record.kana, `${label}.kana`, 200);
    requireNullableString(record.phone, `${label}.phone`, 40);
    requireNullableString(record.customerType, `${label}.customerType`, 40);
    requireDate(record.birthDate, `${label}.birthDate`);
    requireNullableString(record.route, `${label}.route`, 100);
    requireNullableString(record.referrer, `${label}.referrer`, 200);
    requireNullableString(record.storeMemo, `${label}.storeMemo`, 2000);
    requireHash(record.rowHash, `${label}.rowHash`);
  });
  return payload;
}

export function validateMetricPage(payload) {
  const pageKeys = [
    'schemaVersion', 'syncRunId', 'pageNumber',
    'totalPages', 'recordCount', 'pageHash', 'records'
  ];
  requireObject(payload, '集計ページ');
  requireExactKeys(payload, pageKeys, '集計ページ');
  validateCommonPage(payload);
  const ids = new Set();
  payload.records.forEach((record, index) => {
    const label = `metrics[${index}]`;
    requireObject(record, label);
    requireExactKeys(record, METRIC_KEYS, label);
    requireString(record.customerId, `${label}.customerId`, 80);
    if (ids.has(record.customerId)) {
      fail('duplicate_customer_id', '同じページ内に顧客IDの重複があります。');
    }
    ids.add(record.customerId);
    requireInteger(record.visitCount, `${label}.visitCount`);
    requireDate(record.firstVisitDate, `${label}.firstVisitDate`);
    requireDate(record.lastVisitDate, `${label}.lastVisitDate`);
    requireIsoUtc(record.nextReservationAt, `${label}.nextReservationAt`, true);
    requireNullableString(
      record.nextReservationId, `${label}.nextReservationId`, 80
    );
    requireNullableString(
      record.nextReservationMenu, `${label}.nextReservationMenu`, 300
    );
    requireInteger(record.totalSales, `${label}.totalSales`);
    requireInteger(record.averageSpend, `${label}.averageSpend`);
    requireInteger(record.normalCancelCount, `${label}.normalCancelCount`);
    requireInteger(record.sameDayCancelCount, `${label}.sameDayCancelCount`);
    requireInteger(record.noShowCount, `${label}.noShowCount`);
    if (!['linked', 'unlinked', 'unavailable'].includes(record.lineStatus)) {
      fail('invalid_line_status', `${label}.lineStatusが不正です。`);
    }
    requireNullableString(
      record.lineDisplayName, `${label}.lineDisplayName`, 200
    );
    if (record.metricsStatus !== 'verified') {
      fail('metrics_unavailable', '未取得の集計を同期世代へ含めることはできません。');
    }
    requireHash(record.rowHash, `${label}.rowHash`);
  });
  return payload;
}
