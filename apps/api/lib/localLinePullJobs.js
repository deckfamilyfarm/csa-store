import { randomUUID } from "crypto";

const DEFAULT_PHASES = [
  { key: "fetch", label: "Fetch" },
  { key: "store", label: "Store" },
  { key: "finalize", label: "Finalize" }
];

const jobs = new Map();
const latestJobIdsByDataset = new Map();
const activeJobIdsByDataset = new Map();

function cloneJob(job) {
  return JSON.parse(JSON.stringify(job));
}

function buildPhases(phaseDefs = DEFAULT_PHASES) {
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

function getActiveJob(datasetKey) {
  const activeJobId = activeJobIdsByDataset.get(datasetKey);
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  if (!job) {
    activeJobIdsByDataset.delete(datasetKey);
    return null;
  }
  if (job.status === "completed" || job.status === "failed") {
    activeJobIdsByDataset.delete(datasetKey);
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

export function startLocalLinePullJob({ datasetKey, datasetLabel, run, phases = DEFAULT_PHASES }) {
  const runningJob = getActiveJob(datasetKey);
  if (runningJob) {
    return {
      job: cloneJob(runningJob),
      alreadyRunning: true
    };
  }

  const now = new Date().toISOString();
  const job = {
    jobId: randomUUID(),
    datasetKey,
    datasetLabel,
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
    phases: buildPhases(phases),
    result: null,
    error: null
  };

  jobs.set(job.jobId, job);
  latestJobIdsByDataset.set(datasetKey, job.jobId);
  activeJobIdsByDataset.set(datasetKey, job.jobId);

  Promise.resolve()
    .then(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      updateJobProgress(job, {
        phaseKey: phases[0]?.key || "fetch",
        phaseLabel: phases[0]?.label || "Fetch",
        status: "running",
        percent: 0,
        message: `Starting ${datasetLabel}`
      });

      const result = await run({
        reportProgress: (progress) => updateJobProgress(job, progress)
      });

      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      job.result = result;
      updateJobProgress(job, {
        phaseKey: phases[phases.length - 1]?.key || "finalize",
        phaseLabel: phases[phases.length - 1]?.label || "Finalize",
        status: "completed",
        percent: 100,
        message: `${datasetLabel} complete`
      });
      finalizeRunningPhases(job, "completed");
      activeJobIdsByDataset.delete(datasetKey);
    })
    .catch((error) => {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = {
        message: error?.message || "Unknown error"
      };
      updateJobProgress(job, {
        phaseKey: job.progress.phaseKey || phases[phases.length - 1]?.key || "finalize",
        phaseLabel: job.progress.phaseLabel || phases[phases.length - 1]?.label || "Finalize",
        status: "failed",
        percent: job.progress.percent || 0,
        message: error?.message || `${datasetLabel} failed`
      });
      finalizeRunningPhases(job, "failed", error?.message || `${datasetLabel} failed`);
      activeJobIdsByDataset.delete(datasetKey);
    });

  return {
    job: cloneJob(job),
    alreadyRunning: false
  };
}

export function getLocalLinePullJob(jobId) {
  const job = jobs.get(jobId);
  return job ? cloneJob(job) : null;
}

export function getLatestLocalLinePullJob(datasetKey) {
  const jobId = latestJobIdsByDataset.get(datasetKey);
  if (!jobId) return null;
  const job = jobs.get(jobId);
  return job ? cloneJob(job) : null;
}

export function getLatestLocalLinePullJobs() {
  const result = {};
  for (const [datasetKey, jobId] of latestJobIdsByDataset.entries()) {
    const job = jobs.get(jobId);
    if (job) {
      result[datasetKey] = cloneJob(job);
    }
  }
  return result;
}
