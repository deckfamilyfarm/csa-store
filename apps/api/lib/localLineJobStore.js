import { getPool } from "../db.js";

let reconciledInterruptedJobs = false;
let reconcilePromise = null;

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch (_error) {
    return fallback;
  }
}

function normalizePersistedJobRow(row) {
  if (!row) return null;
  return {
    jobId: row.jobId,
    datasetKey: row.datasetKey,
    datasetLabel: row.datasetLabel,
    jobType: row.jobType,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    progress: safeJsonParse(row.progressJson, {
      phaseKey: "",
      phaseLabel: "",
      percent: 0,
      message: "",
      current: null,
      total: null
    }),
    phases: safeJsonParse(row.phasesJson, []),
    result: safeJsonParse(row.resultJson, null),
    error: safeJsonParse(row.errorJson, null)
  };
}

async function ensureInterruptedJobsReconciled() {
  if (reconciledInterruptedJobs) return;
  if (reconcilePromise) {
    await reconcilePromise;
    return;
  }

  reconcilePromise = (async () => {
    const pool = getPool();
    const now = new Date();
    const interruptedError = JSON.stringify({
      message: "API server restarted before this Local Line job completed."
    });
    await pool.query(
      `
        UPDATE local_line_job_runs
        SET
          status = 'failed',
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?,
          error_json = CASE
            WHEN error_json IS NULL OR error_json = '' THEN ?
            ELSE error_json
          END
        WHERE status IN ('queued', 'running')
      `,
      [now, now, interruptedError]
    );
    reconciledInterruptedJobs = true;
  })().finally(() => {
    reconcilePromise = null;
  });

  await reconcilePromise;
}

export async function persistLocalLineJobRun(job) {
  await ensureInterruptedJobsReconciled();
  const pool = getPool();
  const progressJson = JSON.stringify(job.progress || null);
  const phasesJson = JSON.stringify(job.phases || []);
  const resultJson = job.result == null ? null : JSON.stringify(job.result);
  const errorJson = job.error == null ? null : JSON.stringify(job.error);
  const createdAt = job.createdAt ? new Date(job.createdAt) : new Date();
  const startedAt = job.startedAt ? new Date(job.startedAt) : null;
  const finishedAt = job.finishedAt ? new Date(job.finishedAt) : null;
  const updatedAt = job.updatedAt ? new Date(job.updatedAt) : new Date();

  await pool.query(
    `
      INSERT INTO local_line_job_runs (
        job_id,
        dataset_key,
        dataset_label,
        job_type,
        status,
        progress_json,
        phases_json,
        result_json,
        error_json,
        created_at,
        started_at,
        finished_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        dataset_key = VALUES(dataset_key),
        dataset_label = VALUES(dataset_label),
        job_type = VALUES(job_type),
        status = VALUES(status),
        progress_json = VALUES(progress_json),
        phases_json = VALUES(phases_json),
        result_json = VALUES(result_json),
        error_json = VALUES(error_json),
        started_at = VALUES(started_at),
        finished_at = VALUES(finished_at),
        updated_at = VALUES(updated_at)
    `,
    [
      job.jobId,
      job.datasetKey || "",
      job.datasetLabel || "",
      job.jobType || "",
      job.status || "queued",
      progressJson,
      phasesJson,
      resultJson,
      errorJson,
      createdAt,
      startedAt,
      finishedAt,
      updatedAt
    ]
  );
}

export async function getPersistedLocalLineJobRun(jobId) {
  await ensureInterruptedJobsReconciled();
  const pool = getPool();
  const [rows] = await pool.query(
    `
      SELECT
        job_id AS jobId,
        dataset_key AS datasetKey,
        dataset_label AS datasetLabel,
        job_type AS jobType,
        status,
        progress_json AS progressJson,
        phases_json AS phasesJson,
        result_json AS resultJson,
        error_json AS errorJson,
        created_at AS createdAt,
        started_at AS startedAt,
        finished_at AS finishedAt,
        updated_at AS updatedAt
      FROM local_line_job_runs
      WHERE job_id = ?
      LIMIT 1
    `,
    [String(jobId || "")]
  );
  return normalizePersistedJobRow(rows[0] || null);
}

export async function getLatestPersistedLocalLineJobRun(datasetKey, jobType) {
  await ensureInterruptedJobsReconciled();
  const pool = getPool();
  const [rows] = await pool.query(
    `
      SELECT
        job_id AS jobId,
        dataset_key AS datasetKey,
        dataset_label AS datasetLabel,
        job_type AS jobType,
        status,
        progress_json AS progressJson,
        phases_json AS phasesJson,
        result_json AS resultJson,
        error_json AS errorJson,
        created_at AS createdAt,
        started_at AS startedAt,
        finished_at AS finishedAt,
        updated_at AS updatedAt
      FROM local_line_job_runs
      WHERE dataset_key = ?
        AND job_type = ?
      ORDER BY
        COALESCE(started_at, created_at) DESC,
        created_at DESC,
        id DESC
      LIMIT 1
    `,
    [String(datasetKey || ""), String(jobType || "")]
  );
  return normalizePersistedJobRow(rows[0] || null);
}

export async function getLatestPersistedLocalLineJobsByType(jobType) {
  await ensureInterruptedJobsReconciled();
  const pool = getPool();
  const [rows] = await pool.query(
    `
      SELECT
        job_id AS jobId,
        dataset_key AS datasetKey,
        dataset_label AS datasetLabel,
        job_type AS jobType,
        status,
        progress_json AS progressJson,
        phases_json AS phasesJson,
        result_json AS resultJson,
        error_json AS errorJson,
        created_at AS createdAt,
        started_at AS startedAt,
        finished_at AS finishedAt,
        updated_at AS updatedAt
      FROM local_line_job_runs
      WHERE job_type = ?
      ORDER BY
        dataset_key ASC,
        COALESCE(started_at, created_at) DESC,
        created_at DESC,
        id DESC
    `,
    [String(jobType || "")]
  );

  const jobsByDataset = {};
  for (const row of rows) {
    if (jobsByDataset[row.datasetKey]) continue;
    jobsByDataset[row.datasetKey] = normalizePersistedJobRow(row);
  }
  return cloneJson(jobsByDataset, {});
}
