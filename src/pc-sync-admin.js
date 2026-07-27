import {
  PcSyncContractError,
  validateCustomerPage,
  validateMetricPage,
  validateStartPayload
} from './pc-sync-contract.js';

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function hashRowHashes(rows) {
  const input = rows.map(row => String(row.row_hash || '')).join('');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  const hex = Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function requireSyncRunId(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      typeof payload.syncRunId !== 'string' ||
      !payload.syncRunId.trim() ||
      payload.syncRunId.length > 100) {
    throw new PcSyncContractError(
      'invalid_sync_run_id',
      '同期実行IDが正しくありません。'
    );
  }
  return payload.syncRunId.trim();
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

export async function receivePcMetricPage(env, payload, options = {}) {
  validateMetricPage(payload);

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
    `SELECT status, schema_version, expires_at, metric_page_count
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
  if (Number(run.metric_page_count) !== payload.totalPages) {
    throw new PcSyncContractError(
      'total_pages_mismatch',
      '開始時に宣言した集計ページ数と一致しません。'
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
        AND dataset_type = 'metrics'
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
      `INSERT INTO pc_customer_metrics_snapshot
         (generation_id, customer_id, visit_count, first_visit_date,
          last_visit_date, next_reservation_at, next_reservation_id,
          next_reservation_menu, total_sales, average_spend,
          normal_cancel_count, same_day_cancel_count, no_show_count,
          line_status, line_display_name, metrics_status, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      payload.syncRunId,
      record.customerId,
      record.visitCount,
      record.firstVisitDate,
      record.lastVisitDate,
      record.nextReservationAt,
      record.nextReservationId,
      record.nextReservationMenu,
      record.totalSales,
      record.averageSpend,
      record.normalCancelCount,
      record.sameDayCancelCount,
      record.noShowCount,
      record.lineStatus,
      record.lineDisplayName,
      record.metricsStatus,
      record.rowHash
    )
  );

  statements.push(env.jos_customer_db.prepare(
    `INSERT INTO pc_sync_received_pages
       (sync_run_id, dataset_type, page_number, total_pages,
        record_count, page_hash, received_at)
     VALUES (?, 'metrics', ?, ?, ?, ?, ?)`
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
        SET received_metric_count = received_metric_count + ?
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

export async function validatePcSync(env, payload, options = {}) {
  const syncRunId = requireSyncRunId(payload);
  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const createId = typeof options.createId === 'function'
    ? options.createId
    : () => crypto.randomUUID();
  const db = env.jos_customer_db;

  const run = await db.prepare(
    `SELECT status, expires_at,
            source_customer_count, source_metric_count,
            customer_page_count, metric_page_count,
            source_customer_hash, source_metric_hash
       FROM pc_sync_runs
      WHERE sync_run_id = ?`
  ).bind(syncRunId).first();

  if (!run) {
    throw new PcSyncContractError(
      'sync_run_not_found',
      '同期実行が見つかりません。'
    );
  }
  if (run.status !== 'building') {
    throw new PcSyncContractError(
      'sync_run_not_building',
      '照合可能な同期実行ではありません。'
    );
  }
  if (!run.expires_at || now.getTime() >= Date.parse(run.expires_at)) {
    throw new PcSyncContractError(
      'sync_run_expired',
      '同期実行の有効期限が切れています。'
    );
  }

  const customerPages = await db.prepare(
    `SELECT COUNT(*) AS page_count,
            COALESCE(SUM(record_count), 0) AS record_count
       FROM pc_sync_received_pages
      WHERE sync_run_id = ? AND dataset_type = 'customers'`
  ).bind(syncRunId).first();
  const metricPages = await db.prepare(
    `SELECT COUNT(*) AS page_count,
            COALESCE(SUM(record_count), 0) AS record_count
       FROM pc_sync_received_pages
      WHERE sync_run_id = ? AND dataset_type = 'metrics'`
  ).bind(syncRunId).first();
  const customerCount = await db.prepare(
    `SELECT COUNT(*) AS value
       FROM pc_customers_snapshot
      WHERE generation_id = ?`
  ).bind(syncRunId).first();
  const metricCount = await db.prepare(
    `SELECT COUNT(*) AS value
       FROM pc_customer_metrics_snapshot
      WHERE generation_id = ?`
  ).bind(syncRunId).first();
  const customersWithoutMetrics = await db.prepare(
    `SELECT COUNT(*) AS value
       FROM pc_customers_snapshot c
       LEFT JOIN pc_customer_metrics_snapshot m
         ON m.generation_id = c.generation_id
        AND m.customer_id = c.customer_id
      WHERE c.generation_id = ? AND m.customer_id IS NULL`
  ).bind(syncRunId).first();
  const metricsWithoutCustomers = await db.prepare(
    `SELECT COUNT(*) AS value
       FROM pc_customer_metrics_snapshot m
       LEFT JOIN pc_customers_snapshot c
         ON c.generation_id = m.generation_id
        AND c.customer_id = m.customer_id
      WHERE m.generation_id = ? AND c.customer_id IS NULL`
  ).bind(syncRunId).first();
  const customerRows = await db.prepare(
    `SELECT customer_id, row_hash
       FROM pc_customers_snapshot
      WHERE generation_id = ?
      ORDER BY customer_id ASC`
  ).bind(syncRunId).all();
  const metricRows = await db.prepare(
    `SELECT customer_id, row_hash
       FROM pc_customer_metrics_snapshot
      WHERE generation_id = ?
      ORDER BY customer_id ASC`
  ).bind(syncRunId).all();

  const receivedCustomerHash = await hashRowHashes(
    customerRows.results || []
  );
  const receivedMetricHash = await hashRowHashes(
    metricRows.results || []
  );

  const checks = [
    ['customer_page_count',
      Number(customerPages.page_count) === Number(run.customer_page_count)],
    ['metric_page_count',
      Number(metricPages.page_count) === Number(run.metric_page_count)],
    ['customer_record_count',
      Number(customerPages.record_count) === Number(run.source_customer_count)],
    ['metric_record_count',
      Number(metricPages.record_count) === Number(run.source_metric_count)],
    ['customer_snapshot_count',
      Number(customerCount.value) === Number(run.source_customer_count)],
    ['metric_snapshot_count',
      Number(metricCount.value) === Number(run.source_metric_count)],
    ['customers_without_metrics',
      Number(customersWithoutMetrics.value) === 0],
    ['metrics_without_customers',
      Number(metricsWithoutCustomers.value) === 0],
    ['customer_dataset_hash',
      receivedCustomerHash === run.source_customer_hash],
    ['metric_dataset_hash',
      receivedMetricHash === run.source_metric_hash]
  ];

  const failedChecks = checks
    .filter(([, matched]) => !matched)
    .map(([name]) => name);
  const finishedAt = now.toISOString();
  const statements = checks.map(([fieldName, matched]) =>
    db.prepare(
      `INSERT INTO pc_reconciliation_results
         (result_id, sync_run_id, scope, field_name, matched, created_at)
       VALUES (?, ?, 'global', ?, ?, ?)`
    ).bind(
      createId(),
      syncRunId,
      fieldName,
      matched ? 1 : 0,
      finishedAt
    )
  );

  if (failedChecks.length) {
    statements.push(db.prepare(
      `UPDATE pc_sync_runs
          SET status = 'failed', finished_at = ?,
              received_customer_count = ?,
              received_metric_count = ?,
              received_customer_hash = ?,
              received_metric_hash = ?,
              error_code = 'reconciliation_failed',
              error_message = ?
        WHERE sync_run_id = ? AND status = 'building'`
    ).bind(
      finishedAt,
      Number(customerCount.value),
      Number(metricCount.value),
      receivedCustomerHash,
      receivedMetricHash,
      failedChecks.join(','),
      syncRunId
    ));
    await db.batch(statements);
    throw new PcSyncContractError(
      'reconciliation_failed',
      '同期データの照合に失敗しました。'
    );
  }

  statements.push(db.prepare(
    `UPDATE pc_sync_runs
        SET status = 'reconciled', finished_at = ?,
            received_customer_count = ?,
            received_metric_count = ?,
            received_customer_hash = ?,
            received_metric_hash = ?,
            error_code = NULL, error_message = NULL
      WHERE sync_run_id = ? AND status = 'building'`
  ).bind(
    finishedAt,
    Number(customerCount.value),
    Number(metricCount.value),
    receivedCustomerHash,
    receivedMetricHash,
    syncRunId
  ));
  statements.push(db.prepare(
    `UPDATE pc_sync_generations
        SET is_reconciled = 1
      WHERE generation_id = ? AND is_active = 0`
  ).bind(syncRunId));
  await db.batch(statements);

  return {
    ok: true,
    syncRunId,
    status: 'reconciled',
    customerCount: Number(customerCount.value),
    metricCount: Number(metricCount.value),
    customerHash: receivedCustomerHash,
    metricHash: receivedMetricHash
  };
}

export async function activatePcSync(env, payload, options = {}) {
  const syncRunId = requireSyncRunId(payload);
  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const db = env.jos_customer_db;
  const now = options.now instanceof Date ? options.now : new Date();
  const activatedAt = now.toISOString();
  const target = await db.prepare(
    `SELECT r.status, g.is_active, g.is_reconciled
       FROM pc_sync_runs r
       JOIN pc_sync_generations g
         ON g.sync_run_id = r.sync_run_id
      WHERE r.sync_run_id = ?`
  ).bind(syncRunId).first();

  if (!target) {
    throw new PcSyncContractError(
      'sync_run_not_found',
      '同期実行が見つかりません。'
    );
  }
  if (target.status === 'active' && Number(target.is_active) === 1) {
    return {
      ok: true,
      syncRunId,
      status: 'active',
      activatedAt: null,
      idempotent: true
    };
  }
  if (target.status !== 'reconciled' ||
      Number(target.is_reconciled) !== 1 ||
      Number(target.is_active) !== 0) {
    throw new PcSyncContractError(
      'sync_run_not_reconciled',
      '照合済みの未有効世代だけを有効化できます。'
    );
  }

  const statements = [
    db.prepare(
      `UPDATE pc_sync_runs
          SET status = 'reconciled'
        WHERE status = 'active'
          AND sync_run_id IN (
            SELECT sync_run_id
              FROM pc_sync_generations
             WHERE is_active = 1 AND generation_id <> ?
          )`
    ).bind(syncRunId),
    db.prepare(
      `UPDATE pc_sync_generations
          SET is_active = 0, superseded_at = ?
        WHERE is_active = 1 AND generation_id <> ?`
    ).bind(activatedAt, syncRunId),
    db.prepare(
      `UPDATE pc_sync_generations
          SET is_active = 1, activated_at = ?, superseded_at = NULL
        WHERE generation_id = ?
          AND is_reconciled = 1
          AND is_active = 0`
    ).bind(activatedAt, syncRunId),
    db.prepare(
      `UPDATE pc_sync_runs
          SET status = 'active', activated_at = ?
        WHERE sync_run_id = ? AND status = 'reconciled'`
    ).bind(activatedAt, syncRunId)
  ];

  const results = await db.batch(statements);
  const generationChanges = Number(
    results &&
    results[2] &&
    results[2].meta &&
    results[2].meta.changes
  );
  const runChanges = Number(
    results &&
    results[3] &&
    results[3].meta &&
    results[3].meta.changes
  );

  if (generationChanges !== 1 || runChanges !== 1) {
    throw new PcSyncContractError(
      'activation_not_confirmed',
      '有効世代の切替結果を確認できませんでした。'
    );
  }

  return {
    ok: true,
    syncRunId,
    status: 'active',
    activatedAt,
    idempotent: false
  };
}

export async function rollbackPcSync(env, payload, options = {}) {
  const syncRunId = requireSyncRunId(payload);
  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const target = await env.jos_customer_db.prepare(
    `SELECT r.status, g.is_active, g.is_reconciled,
            g.activated_at, g.retain_until
       FROM pc_sync_runs r
       JOIN pc_sync_generations g
         ON g.sync_run_id = r.sync_run_id
      WHERE r.sync_run_id = ?`
  ).bind(syncRunId).first();

  if (!target) {
    throw new PcSyncContractError(
      'rollback_target_not_found',
      '切戻し対象の世代が見つかりません。'
    );
  }
  if (Number(target.is_active) === 1 && target.status === 'active') {
    return {
      ok: true,
      syncRunId,
      status: 'active',
      activatedAt: null,
      idempotent: true,
      rollback: true
    };
  }
  if (target.status !== 'reconciled' ||
      Number(target.is_reconciled) !== 1 ||
      Number(target.is_active) !== 0 ||
      !target.activated_at) {
    throw new PcSyncContractError(
      'rollback_target_not_eligible',
      '過去に有効化済みの照合済み世代だけへ切り戻せます。'
    );
  }
  if (!target.retain_until ||
      now.getTime() >= Date.parse(target.retain_until)) {
    throw new PcSyncContractError(
      'rollback_target_expired',
      '切戻し対象の保持期限が切れています。'
    );
  }

  const result = await activatePcSync(env, payload, options);
  return {
    ...result,
    rollback: true
  };
}

export async function getPcSyncStatus(env, options = {}) {
  if (!env || !env.jos_customer_db) {
    throw new PcSyncContractError(
      'database_unavailable',
      '同期用データベースを利用できません。'
    );
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const db = env.jos_customer_db;
  const active = await db.prepare(
    `SELECT r.sync_run_id, r.status, r.started_at, r.finished_at,
            r.source_generated_at, r.source_customer_count,
            r.received_customer_count, r.source_metric_count,
            r.received_metric_count, r.error_code, r.error_message,
            r.activated_at, g.generation_id, g.is_active,
            g.is_reconciled, g.retain_until
       FROM pc_sync_generations g
       JOIN pc_sync_runs r ON r.sync_run_id = g.sync_run_id
      WHERE g.is_active = 1
      LIMIT 2`
  ).all();
  const recent = await db.prepare(
    `SELECT sync_run_id, status, started_at, finished_at, expires_at,
            source_generated_at, error_code, error_message, activated_at
       FROM pc_sync_runs
      ORDER BY started_at DESC
      LIMIT 10`
  ).all();

  const activeRows = active && Array.isArray(active.results)
    ? active.results
    : [];
  const recentRows = recent && Array.isArray(recent.results)
    ? recent.results
    : [];
  const issues = [];

  if (activeRows.length === 0) {
    issues.push({
      code: 'active_generation_missing',
      message: '有効な同期世代がありません。'
    });
  } else if (activeRows.length > 1) {
    issues.push({
      code: 'multiple_active_generations',
      message: '有効な同期世代が複数あります。'
    });
  } else {
    const row = activeRows[0];
    if (row.status !== 'active' ||
        Number(row.is_active) !== 1 ||
        Number(row.is_reconciled) !== 1) {
      issues.push({
        code: 'active_generation_inconsistent',
        message: '有効世代の状態が一致していません。'
      });
    }
  }

  const runs = recentRows.map(row => {
    const expired = row.status === 'building' &&
      (!row.expires_at ||
       !Number.isFinite(Date.parse(row.expires_at)) ||
       now.getTime() >= Date.parse(row.expires_at));
    if (expired) {
      issues.push({
        code: 'sync_run_expired',
        syncRunId: row.sync_run_id,
        message: '未完了の同期が期限切れです。'
      });
    }
    if (row.status === 'failed') {
      issues.push({
        code: 'sync_run_failed',
        syncRunId: row.sync_run_id,
        errorCode: row.error_code || null,
        message: row.error_message || '同期に失敗しました。'
      });
    }
    return {
      syncRunId: row.sync_run_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at || null,
      expiresAt: row.expires_at,
      sourceGeneratedAt: row.source_generated_at,
      activatedAt: row.activated_at || null,
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      expired
    };
  });

  const blockingCodes = new Set([
    'active_generation_missing',
    'multiple_active_generations',
    'active_generation_inconsistent'
  ]);
  const health = issues.some(issue => blockingCodes.has(issue.code))
    ? 'unavailable'
    : issues.length > 0
      ? 'degraded'
      : 'healthy';
  const activeRow = activeRows.length === 1 ? activeRows[0] : null;

  return {
    ok: true,
    checkedAt: now.toISOString(),
    health,
    canServeFromD1: health !== 'unavailable',
    activeGeneration: activeRow ? {
      generationId: activeRow.generation_id,
      syncRunId: activeRow.sync_run_id,
      status: activeRow.status,
      sourceGeneratedAt: activeRow.source_generated_at,
      activatedAt: activeRow.activated_at || null,
      retainUntil: activeRow.retain_until,
      customerCount: Number(activeRow.received_customer_count),
      metricCount: Number(activeRow.received_metric_count)
    } : null,
    issues,
    recentRuns: runs
  };
}
