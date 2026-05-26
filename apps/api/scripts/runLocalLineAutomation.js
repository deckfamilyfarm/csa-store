import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import { ensureLocalLineSyncSchema, getPool } from "../db.js";
import {
  publishLocalLineDashboard,
  syncLocalLineSubscriberSnapshotCache
} from "../lib/dashboardPublisher.js";
import {
  getLatestLocalLineFullSyncJob,
  getLocalLineFullSyncJob,
  startLocalLineFullSyncJob
} from "../lib/localLineFullSyncJobs.js";
import {
  getLatestLocalLinePullJob,
  getLocalLinePullJob,
  startLocalLinePullJob
} from "../lib/localLinePullJobs.js";
import {
  LOCAL_LINE_DASHBOARD_JOB_PHASES,
  LOCAL_LINE_FULFILLMENT_JOB_PHASES,
  LOCAL_LINE_ORDER_JOB_PHASES,
  LOCAL_LINE_SUBSCRIPTION_JOB_PHASES,
  syncLocalLineFulfillmentStrategiesToStore,
  syncLocalLineOrdersToStore
} from "../lib/localLineAutomationSync.js";
import {
  getPersistedLocalLineJobRun,
  persistLocalLineJobRun
} from "../lib/localLineJobStore.js";

const __filename = fileURLToPath(import.meta.url);
const LOCK_NAME = "csa-store:localline-automation";
const DEFAULT_ORDER_CUTOFF = "2026-01-01T00:00:00.000Z";
const POLL_INTERVAL_MS = 5_000;
const PERSIST_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_DASHBOARD_PREREQ_AGE_HOURS = 26;

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseMode(value) {
  const mode = String(value || "pull").trim().toLowerCase();
  if (["pull", "dashboard", "full"].includes(mode)) return mode;
  throw new Error(`Unsupported automation mode "${mode}". Use pull, dashboard, or full.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPhaseDefs(mode) {
  const phases = [];
  if (mode === "pull" || mode === "full") {
    phases.push(
      { key: "products", label: "Pull Products" },
      { key: "fulfillments", label: "Pull Fulfillments" },
      { key: "orders", label: "Pull Orders" },
      { key: "subscriptions", label: "Pull Subscribers" }
    );
  }
  if (mode === "dashboard" || mode === "full") {
    phases.push({ key: "dashboard", label: "Publish Dashboard" });
  }
  phases.push({ key: "finalize", label: "Finalize" });
  return phases;
}

function buildPhases(phaseDefs) {
  return phaseDefs.map((phase) => ({
    ...phase,
    status: "pending",
    percent: 0,
    message: "",
    current: null,
    total: null,
    startedAt: null,
    finishedAt: null
  }));
}

function buildAutomationJob({ mode, phaseDefs }) {
  const now = new Date().toISOString();
  return {
    jobId: randomUUID(),
    datasetKey: "automation",
    datasetLabel: `Local Line automation (${mode})`,
    jobType: "pipeline",
    status: "queued",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    progress: {
      phaseKey: "",
      phaseLabel: "",
      percent: 0,
      message: "Queued",
      current: null,
      total: null
    },
    phases: buildPhases(phaseDefs),
    result: {
      mode,
      childJobs: []
    },
    error: null
  };
}

async function updateAutomationJob(job, progress = {}) {
  const now = new Date().toISOString();
  const phaseKey = progress.phaseKey || job.progress.phaseKey || "";
  const phase = phaseKey ? job.phases.find((item) => item.key === phaseKey) : null;
  job.updatedAt = now;
  job.progress = {
    phaseKey,
    phaseLabel: progress.phaseLabel || phase?.label || job.progress.phaseLabel || "",
    percent: Number.isFinite(progress.percent) ? progress.percent : job.progress.percent,
    message: progress.message || job.progress.message || "",
    current:
      Object.prototype.hasOwnProperty.call(progress, "current")
        ? (typeof progress.current === "number" ? progress.current : null)
        : (job.progress.current ?? null),
    total:
      Object.prototype.hasOwnProperty.call(progress, "total")
        ? (typeof progress.total === "number" ? progress.total : null)
        : (job.progress.total ?? null)
  };

  if (phase) {
    if (progress.status === "running") {
      phase.status = "running";
      phase.startedAt = phase.startedAt || now;
    } else if (progress.status === "completed") {
      phase.status = "completed";
      phase.startedAt = phase.startedAt || now;
      phase.finishedAt = now;
    } else if (progress.status === "failed") {
      phase.status = "failed";
      phase.startedAt = phase.startedAt || now;
      phase.finishedAt = now;
    }
    if (Number.isFinite(progress.percent)) phase.percent = progress.percent;
    if (progress.message) phase.message = progress.message;
    if (Object.prototype.hasOwnProperty.call(progress, "current")) {
      phase.current = typeof progress.current === "number" ? progress.current : null;
    }
    if (Object.prototype.hasOwnProperty.call(progress, "total")) {
      phase.total = typeof progress.total === "number" ? progress.total : null;
    }
  }

  await persistLocalLineJobRun(job);
}

function finalizeRunningPhases(job, status, message) {
  const now = new Date().toISOString();
  for (const phase of job.phases) {
    if (phase.status === "running") {
      phase.status = status;
      phase.finishedAt = now;
      if (message && !phase.message) {
        phase.message = message;
      }
    }
  }
}

function jobFinishedAtMs(job) {
  const value = job?.finishedAt || job?.updatedAt || job?.startedAt;
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function assertRecentCompletedJob(job, label, maxAgeMs) {
  if (!job) {
    throw new Error(`${label} has not completed yet.`);
  }
  if (job.status !== "completed") {
    throw new Error(`${label} latest job is ${job.status || "unknown"}, not completed.`);
  }
  const ageMs = Date.now() - jobFinishedAtMs(job);
  if (ageMs > maxAgeMs) {
    throw new Error(`${label} latest job is stale.`);
  }
}

async function assertDashboardPrereqsFresh() {
  const maxAgeHours = Number(
    process.env.LOCAL_LINE_AUTOMATION_DASHBOARD_MAX_PULL_AGE_HOURS ||
      DEFAULT_MAX_DASHBOARD_PREREQ_AGE_HOURS
  );
  const maxAgeMs = Math.max(1, maxAgeHours) * 60 * 60 * 1000;
  const [productsJob, fulfillmentsJob, ordersJob, subscriptionsJob] = await Promise.all([
    getLatestLocalLineFullSyncJob(),
    getLatestLocalLinePullJob("fulfillments"),
    getLatestLocalLinePullJob("orders"),
    getLatestLocalLinePullJob("subscriptions")
  ]);
  assertRecentCompletedJob(productsJob, "Product pull", maxAgeMs);
  assertRecentCompletedJob(fulfillmentsJob, "Fulfillment pull", maxAgeMs);
  assertRecentCompletedJob(ordersJob, "Order pull", maxAgeMs);
  assertRecentCompletedJob(subscriptionsJob, "Subscriber pull", maxAgeMs);
}

async function acquireAutomationLock() {
  const connection = await getPool().getConnection();
  let released = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [LOCK_NAME]);
    if (Number(rows?.[0]?.acquired || 0) !== 1) {
      connection.release();
      released = true;
      throw new Error("Another Local Line automation run is already active.");
    }
    return connection;
  } catch (error) {
    if (!released) {
      connection.release();
    }
    throw error;
  }
}

async function releaseAutomationLock(connection) {
  if (!connection) return;
  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
  } finally {
    connection.release();
  }
}

async function waitForChildJob({
  jobId,
  getJob,
  automationJob,
  phaseKey,
  phaseLabel,
  timeoutMs
}) {
  const startedAt = Date.now();
  let lastMessage = "";
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJob(jobId);
    if (!job) {
      throw new Error(`${phaseLabel} job ${jobId} disappeared.`);
    }
    const progressMessage = job.progress?.message || job.status || "";
    if (progressMessage !== lastMessage || job.status === "completed" || job.status === "failed") {
      lastMessage = progressMessage;
      console.log(`[${phaseLabel}] ${job.status}: ${progressMessage}`);
    }
    await updateAutomationJob(automationJob, {
      phaseKey,
      phaseLabel,
      status: job.status === "failed" ? "failed" : "running",
      percent: Number.isFinite(job.progress?.percent) ? job.progress.percent : automationJob.progress.percent,
      current: job.progress?.current,
      total: job.progress?.total,
      message: progressMessage
    });

    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(job.error?.message || `${phaseLabel} failed.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${phaseLabel} did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
}

async function waitForPersistedChildJob({ jobId, phaseLabel, timeoutMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const persisted = await getPersistedLocalLineJobRun(jobId);
    if (persisted?.status === "completed") return persisted;
    if (persisted?.status === "failed") {
      throw new Error(persisted.error?.message || `${phaseLabel} failed before final persistence.`);
    }
    await sleep(PERSIST_POLL_INTERVAL_MS);
  }
  throw new Error(`${phaseLabel} completed but final job state was not persisted in time.`);
}

async function runChildJob({
  automationJob,
  phaseKey,
  phaseLabel,
  start,
  get,
  timeoutMs
}) {
  console.log(`[${phaseLabel}] starting`);
  await updateAutomationJob(automationJob, {
    phaseKey,
    phaseLabel,
    status: "running",
    percent: 0,
    message: "Starting"
  });

  const started = await start();
  const childJob = started.job;
  automationJob.result.childJobs.push({
    phaseKey,
    jobId: childJob.jobId,
    datasetKey: childJob.datasetKey,
    jobType: childJob.jobType,
    attachedToRunningJob: Boolean(started.alreadyRunning)
  });
  await persistLocalLineJobRun(automationJob);

  const finished = await waitForChildJob({
    jobId: childJob.jobId,
    getJob: get,
    automationJob,
    phaseKey,
    phaseLabel,
    timeoutMs
  });
  if (finished?.status === "completed") {
    await persistLocalLineJobRun(finished);
  }
  const persistTimeoutMs = Number(
    process.env.LOCAL_LINE_AUTOMATION_PERSIST_TIMEOUT_MS || DEFAULT_PERSIST_TIMEOUT_MS
  );
  const persistedFinished = await waitForPersistedChildJob({
    jobId: childJob.jobId,
    phaseLabel,
    timeoutMs: persistTimeoutMs
  });
  await updateAutomationJob(automationJob, {
    phaseKey,
    phaseLabel,
    status: "completed",
    percent: 100,
    message: `${phaseLabel} complete`
  });
  return persistedFinished || finished;
}

export async function runLocalLineAutomation({ mode = "pull" } = {}) {
  const normalizedMode = parseMode(mode);
  const phaseDefs = buildPhaseDefs(normalizedMode);
  const job = buildAutomationJob({ mode: normalizedMode, phaseDefs });
  const timeoutMs = Number(process.env.LOCAL_LINE_AUTOMATION_JOB_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const orderCutoff = process.env.LOCAL_LINE_AUTOMATION_ORDER_CUTOFF || DEFAULT_ORDER_CUTOFF;
  let lockConnection = null;

  try {
    await ensureLocalLineSyncSchema();
    lockConnection = await acquireAutomationLock();
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await updateAutomationJob(job, {
      phaseKey: phaseDefs[0]?.key || "finalize",
      phaseLabel: phaseDefs[0]?.label || "Finalize",
      status: "running",
      percent: 0,
      message: `Starting ${normalizedMode} automation`
    });

    if (normalizedMode === "pull" || normalizedMode === "full") {
      await runChildJob({
        automationJob: job,
        phaseKey: "products",
        phaseLabel: "Pull Products",
        timeoutMs,
        start: () => startLocalLineFullSyncJob({}),
        get: getLocalLineFullSyncJob
      });
      await runChildJob({
        automationJob: job,
        phaseKey: "fulfillments",
        phaseLabel: "Pull Fulfillments",
        timeoutMs,
        start: () =>
          startLocalLinePullJob({
            datasetKey: "fulfillments",
            datasetLabel: "Local Line fulfillment sync",
            phases: LOCAL_LINE_FULFILLMENT_JOB_PHASES,
            run: ({ reportProgress }) => syncLocalLineFulfillmentStrategiesToStore({ reportProgress })
          }),
        get: getLocalLinePullJob
      });
      await runChildJob({
        automationJob: job,
        phaseKey: "orders",
        phaseLabel: "Pull Orders",
        timeoutMs,
        start: () =>
          startLocalLinePullJob({
            datasetKey: "orders",
            datasetLabel: "Local Line order sync",
            phases: LOCAL_LINE_ORDER_JOB_PHASES.filter((phase) => phase.key !== "subscriptions"),
            run: ({ reportProgress }) =>
              syncLocalLineOrdersToStore({
                reportProgress,
                cutoffDate: orderCutoff,
                includeSubscriberSnapshot: false
              })
          }),
        get: getLocalLinePullJob
      });
      await runChildJob({
        automationJob: job,
        phaseKey: "subscriptions",
        phaseLabel: "Pull Subscribers",
        timeoutMs,
        start: () =>
          startLocalLinePullJob({
            datasetKey: "subscriptions",
            datasetLabel: "Local Line subscriber sync",
            phases: LOCAL_LINE_SUBSCRIPTION_JOB_PHASES,
            run: ({ reportProgress }) => syncLocalLineSubscriberSnapshotCache({ reportProgress })
          }),
        get: getLocalLinePullJob
      });
    }

    if (normalizedMode === "dashboard") {
      await assertDashboardPrereqsFresh();
    }

    if (normalizedMode === "dashboard" || normalizedMode === "full") {
      await runChildJob({
        automationJob: job,
        phaseKey: "dashboard",
        phaseLabel: "Publish Dashboard",
        timeoutMs,
        start: () =>
          startLocalLinePullJob({
            datasetKey: "dashboard",
            datasetLabel: "Local Line dashboard publish",
            phases: LOCAL_LINE_DASHBOARD_JOB_PHASES,
            run: ({ reportProgress }) => publishLocalLineDashboard({ reportProgress })
          }),
        get: getLocalLinePullJob
      });
    }

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    await updateAutomationJob(job, {
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Local Line automation complete"
    });
    finalizeRunningPhases(job, "completed");
    await persistLocalLineJobRun(job);
    return job;
  } catch (error) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = { message: error?.message || "Local Line automation failed" };
    await updateAutomationJob(job, {
      phaseKey: job.progress.phaseKey || "finalize",
      phaseLabel: job.progress.phaseLabel || "Finalize",
      status: "failed",
      percent: job.progress.percent || 0,
      message: error?.message || "Local Line automation failed"
    }).catch(() => {});
    finalizeRunningPhases(job, "failed", error?.message || "Local Line automation failed");
    await persistLocalLineJobRun(job).catch(() => {});
    throw error;
  } finally {
    await releaseAutomationLock(lockConnection).catch((error) => {
      console.warn("Failed to release Local Line automation lock:", error?.message || error);
    });
  }
}

async function main() {
  const mode = parseMode(getArg("mode", "pull"));
  const job = await runLocalLineAutomation({ mode });
  console.log(JSON.stringify({
    ok: true,
    jobId: job.jobId,
    mode,
    status: job.status,
    childJobs: job.result?.childJobs || []
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main()
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end().catch(() => {});
    });
}
