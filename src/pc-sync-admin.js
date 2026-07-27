import {
  PcSyncContractError,
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
