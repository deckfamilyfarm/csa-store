import { ensureLocalLineSyncSchema, getPool } from "../db.js";

// A pricelist is a current snapshot; its reporting week is the local export week.
export function getPricelistPublishWeek(publishedAt = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(publishedAt);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const start = new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    latestWeekStart: start.toISOString().slice(0, 10),
    latestWeekEnd: end.toISOString().slice(0, 10)
  };
}

export async function recordGoogleDrivePublish(publicationKey, summary, publishedAt = new Date()) {
  await ensureLocalLineSyncSchema();
  // Store UTC explicitly so API servers and command-line publishers agree on the instant.
  await getPool().query(
    `INSERT INTO google_drive_publish_history
      (publication_key, published_at, latest_week_start, latest_week_end, summary_json)
      VALUES (?, ?, ?, ?, ?)`,
    [publicationKey, publishedAt.toISOString().slice(0, 19).replace("T", " "),
      summary.latestWeekStart || null, summary.latestWeekEnd || null, JSON.stringify(summary)]
  );
}

function parseSummary(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "null") || {};
  } catch {
    return {};
  }
}

export function publicationFromRow(row) {
  if (!row?.publishedAt) return null;
  const summary = parseSummary(row.summaryJson);
  return {
    publishedAt: new Date(summary.publishedAt || row.publishedAt).toISOString(),
    latestWeekStart: row.latestWeekStart || summary.latestWeekStart || null,
    latestWeekEnd: row.latestWeekEnd || summary.latestWeekEnd || null,
    summary
  };
}

async function getLatestPublication(publicationKey) {
  const [rows] = await getPool().query(
    `SELECT DATE_FORMAT(published_at, '%Y-%m-%dT%H:%i:%sZ') AS publishedAt,
       latest_week_start AS latestWeekStart, latest_week_end AS latestWeekEnd,
       summary_json AS summaryJson
     FROM google_drive_publish_history WHERE publication_key = ?
     ORDER BY published_at DESC, id DESC LIMIT 1`,
    [publicationKey]
  );
  return publicationFromRow(rows[0]);
}

async function getLegacyDashboardPublication() {
  // Existing successful dashboard jobs remain valid history, even after a failed attempt.
  const [rows] = await getPool().query(
    `SELECT finished_at AS publishedAt, result_json AS summaryJson
     FROM local_line_job_runs
     WHERE dataset_key = 'dashboard' AND status = 'completed' AND finished_at IS NOT NULL
     ORDER BY finished_at DESC, id DESC LIMIT 1`
  );
  const [cursors] = await getPool().query(
    `SELECT synced_through_at AS publishedAt, cursor_value AS latestWeekEnd,
       summary_json AS summaryJson
     FROM local_line_sync_cursors
     WHERE sync_key = 'dashboard' AND last_status = 'completed'
       AND synced_through_at IS NOT NULL`
  );
  // These older tables stored driver-local DATETIMEs, so let the driver decode them.
  return [...rows, ...cursors].map(publicationFromRow).filter(Boolean)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0] || null;
}

export async function getGoogleDrivePublishStatus() {
  await ensureLocalLineSyncSchema();
  const [pricelist, dashboard] = await Promise.all([
    getLatestPublication("pricelist"),
    getLatestPublication("dashboard")
  ]);
  return {
    pricelist,
    dashboard: dashboard || await getLegacyDashboardPublication()
  };
}
