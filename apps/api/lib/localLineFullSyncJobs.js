import { randomUUID } from "crypto";
import { runLocalLineFullSync } from "../scripts/syncLocalLineFull.js";

const PHASES = [
  { key: "catalog-sync", label: "Catalog Sync" },
  { key: "localline-fetch", label: "Local Line Fetch" },
  { key: "image-mirroring", label: "Image Mirroring" },
  { key: "store-write", label: "Store Writes" },
  { key: "finalize", label: "Finalize" }
];

const jobs = new Map();
let activeJobId = null;
let latestJobId = null;

function buildPhases() {
  return PHASES.map((phase) => ({
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

function cloneJob(job) {
  return JSON.parse(JSON.stringify(job));
}

function getActiveJob() {
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  if (!job) {
    activeJobId = null;
    return null;
  }
  if (job.status === "completed" || job.status === "failed") {
    activeJobId = null;
    return null;
  }
  return job;
}

function updateJobProgress(job, progress = {}) {
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

  if (!phase) return;

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

  if (Number.isFinite(progress.percent)) {
    phase.percent = progress.percent;
  }
  if (progress.message) {
    phase.message = progress.message;
  }
  if (Object.prototype.hasOwnProperty.call(progress, "current")) {
    phase.current = typeof progress.current === "number" ? progress.current : null;
  }
  if (Object.prototype.hasOwnProperty.call(progress, "total")) {
    phase.total = typeof progress.total === "number" ? progress.total : null;
  }
}

function finalizeRunningPhases(job, status, message) {
  const now = new Date().toISOString();
  job.phases.forEach((phase) => {
    if (phase.status === "running") {
      phase.status = status;
      phase.finishedAt = now;
      if (message && !phase.message) {
        phase.message = message;
      }
    }
  });
}

export function startLocalLineFullSyncJob(options = {}) {
  const runningJob = getActiveJob();
  if (runningJob) {
    return {
      job: cloneJob(runningJob),
      alreadyRunning: true
    };
  }

  const now = new Date().toISOString();
  const job = {
    jobId: randomUUID(),
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
    phases: buildPhases(),
    result: null,
    error: null
  };

  jobs.set(job.jobId, job);
  activeJobId = job.jobId;
  latestJobId = job.jobId;

  Promise.resolve()
    .then(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      updateJobProgress(job, {
        phaseKey: "catalog-sync",
        phaseLabel: "Catalog Sync",
        status: "running",
        percent: 0,
        message: "Starting Local Line full sync"
      });

      const result = await runLocalLineFullSync({
        ...options,
        onProgress: (progress) => updateJobProgress(job, progress)
      });

      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      job.result = result;
      updateJobProgress(job, {
        phaseKey: "finalize",
        phaseLabel: "Finalize",
        status: "completed",
        percent: 100,
        message: "Local Line full sync complete"
      });
      finalizeRunningPhases(job, "completed");
      activeJobId = null;
    })
    .catch((error) => {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = {
        message: error?.message || "Unknown error"
      };
      updateJobProgress(job, {
        phaseKey: job.progress.phaseKey || "finalize",
        phaseLabel: job.progress.phaseLabel || "Finalize",
        status: "failed",
        percent: job.progress.percent || 0,
        message: error?.message || "Local Line full sync failed"
      });
      finalizeRunningPhases(job, "failed", error?.message || "Local Line full sync failed");
      activeJobId = null;
    });

  return {
    job: cloneJob(job),
    alreadyRunning: false
  };
}

export function getLocalLineFullSyncJob(jobId) {
  const job = jobs.get(jobId);
  return job ? cloneJob(job) : null;
}

export function getLatestLocalLineFullSyncJob() {
  if (!latestJobId) return null;
  const job = jobs.get(latestJobId);
  return job ? cloneJob(job) : null;
}
