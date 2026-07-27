import {
  PcSyncContractError,
  validateCustomerPage,
  validateStartPayload
} from './pc-sync-contract.js';

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function startPcSync(env, payload, options = {}) {
  validateStartPayload(payload);

  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const now = options.now instanceof Date
    ? options.now
    : new Date();
  const createId = typeof options.createId === 'function'
    ? options.createId
    : () => crypto.randomUUID();
  const syncRunId = createId();

  if (typeof syncRunId !== 'string' || !syncRunId.trim()) {
    throw new PcSyncContractError(
      'sync_id_unavailable',
      '同期実行IDを作成できません。'
    );
  }

  const startedAt = now.toISOString();
  const expiresAt = addMinutes(now, 30).toISOString();
  const retainUntil = addDays(now, 7).toISOString();

  const insertRun = env.jos_customer_db.prepare(
    `INSERT INTO pc_sync_runs
       (sync_run_id, schema_version, contract_name, status,
        started_at, expires_at, source_generated_at,
        source_customer_count, received_customer_count,
        source_metric_count, received_metric_count,
        customer_page_count, metric_page_count,
        source_customer_hash, source_metric_hash)
     VALUES (?, ?, ?, 'building', ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)`
  ).bind(
    syncRunId,
    payload.schemaVersion,
    payload.contractName,
    startedAt,
    expiresAt,
    payload.sourceGeneratedAt,
    payload.expectedCustomerCount,
    payload.expectedMetricCount,
    payload.customerPageCount,
    payload.metricPageCount,
    payload.customerDatasetHash,
    payload.metricDatasetHash
  );

  const insertGeneration = env.jos_customer_db.prepare(
    `INSERT INTO pc_sync_generations
       (generation_id, sync_run_id, is_active, is_reconciled, retain_until)
     VALUES (?, ?, 0, 0, ?)`
  ).bind(syncRunId, syncRunId, retainUntil);

  await env.jos_customer_db.batch([
    insertRun,
    insertGeneration
  ]);

  return {
    ok: true,
    syncRunId,
    status: 'building',
    expiresAt
  };
}

export async function receivePcCustomerPage(env, payload, options = {}) {
  validateCustomerPage(payload);

  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const now = options.now instanceof Date
    ? options.now
    : new Date();
  const run = await env.jos_customer_db.prepare(
    `SELECT status, schema_version, expires_at, customer_page_count
       FROM pc_sync_runs
      WHERE sync_run_id = ?`
  ).bind(payload.syncRunId).first();

  if (!run) {
    throw new PcSyncContractError(
      'sync_run_not_found',
      '同期実行が見つかりません。'
    );
  }
  if (run.status !== 'building') {
    throw new PcSyncContractError(
      'sync_run_not_building',
      '書き込み可能な同期実行ではありません。'
    );
  }
  if (Number(run.schema_version) !== payload.schemaVersion) {
    throw new PcSyncContractError(
      'schema_version_mismatch',
      '同期実行とページのスキーマバージョンが一致しません。'
    );
  }
  if (Number(run.customer_page_count) !== payload.totalPages) {
    throw new PcSyncContractError(
      'total_pages_mismatch',
      '開始時に宣言した顧客ページ数と一致しません。'
    );
  }
  if (!run.expires_at || now.getTime() >= Date.parse(run.expires_at)) {
    throw new PcSyncContractError(
      'sync_run_expired',
      '同期実行の有効期限が切れています。'
    );
  }

  const existing = await env.jos_customer_db.prepare(
    `SELECT page_hash, record_count
       FROM pc_sync_received_pages
      WHERE sync_run_id = ?
        AND dataset_type = 'customers'
        AND page_number = ?`
  ).bind(payload.syncRunId, payload.pageNumber).first();

  if (existing) {
    if (existing.page_hash === payload.pageHash &&
        Number(existing.record_count) === payload.recordCount) {
      return {
        ok: true,
        syncRunId: payload.syncRunId,
        pageNumber: payload.pageNumber,
        recordCount: payload.recordCount,
        idempotent: true
      };
    }
    throw new PcSyncContractError(
      'page_hash_conflict',
      '同じページ番号へ異なる内容を保存できません。'
    );
  }

  const statements = payload.records.map(record =>
    env.jos_customer_db.prepare(
      `INSERT INTO pc_customers_snapshot
         (generation_id, customer_id, customer_name, customer_kana,
          phone, customer_type, birth_date, route, referrer,
          store_memo, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      payload.syncRunId,
      record.customerId,
      record.name,
      record.kana,
      record.phone,
      record.customerType,
      record.birthDate,
      record.route,
      record.referrer,
      record.storeMemo,
      record.rowHash
    )
  );

  statements.push(env.jos_customer_db.prepare(
    `INSERT INTO pc_sync_received_pages
       (sync_run_id, dataset_type, page_number, total_pages,
        record_count, page_hash, received_at)
     VALUES (?, 'customers', ?, ?, ?, ?, ?)`
  ).bind(
    payload.syncRunId,
    payload.pageNumber,
    payload.totalPages,
    payload.recordCount,
    payload.pageHash,
    now.toISOString()
  ));

  statements.push(env.jos_customer_db.prepare(
    `UPDATE pc_sync_runs
        SET received_customer_count = received_customer_count + ?
      WHERE sync_run_id = ? AND status = 'building'`
  ).bind(payload.recordCount, payload.syncRunId));

  await env.jos_customer_db.batch(statements);

  return {
    ok: true,
    syncRunId: payload.syncRunId,
    pageNumber: payload.pageNumber,
    recordCount: payload.recordCount,
    idempotent: false
  };
}
