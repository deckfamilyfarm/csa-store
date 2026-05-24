import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import mysql from "mysql2/promise";
import path from "path";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { getPool } from "../db.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl } from "../localLineAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const legacyEnvPath =
  process.env.LOCALLINE_DASHBOARD_ENV_PATH ||
  "/Users/jdeck/code/ffcsa_scripts/localline/.env";
const legacyEnv = (() => {
  try {
    if (!legacyEnvPath || !fs.existsSync(legacyEnvPath)) return {};
    return dotenv.parse(fs.readFileSync(legacyEnvPath));
  } catch {
    return {};
  }
})();

function getDashboardEnv(key, fallback = "") {
  const direct = process.env[key];
  if (typeof direct !== "undefined" && direct !== "") return direct;
  const legacy = legacyEnv[key];
  if (typeof legacy !== "undefined" && legacy !== "") return legacy;
  return fallback;
}

const DASHBOARD_SHEET_ID =
  getDashboardEnv("GOOGLE_SHEETS_ID") ||
  getDashboardEnv("DASHBOARD_SHEET_ID") ||
  "1plDSzQo8PZqQbCAt9Xb1BRd-cdJmkpoGwSmCFQvolUc";
const DASHBOARD_SOURCE_GID = getDashboardEnv("DASHBOARD_SOURCE_GID", "707104494");
const DASHBOARD_TARGET_TITLE =
  getDashboardEnv("GOOGLE_SHEETS_TAB") ||
  getDashboardEnv("DASHBOARD_TARGET_TITLE") ||
  "Dashboard-auto-26";
const DEFAULT_SUBSCRIBER_HISTORY_DIR =
  getDashboardEnv("LOCALLINE_SUBSCRIBER_HISTORY_DIR") ||
  "/Users/jdeck/code/ffcsa_scripts/localline/data";
const TIMESHEET_APPROVED_STATUSES =
  getDashboardEnv("TIMESHEET_APPROVED_STATUSES", "1,0,2,3");
const DASHBOARD_ORDER_PRICE_LIST_IDS = parseDashboardIdList(
  getDashboardEnv("DASHBOARD_ORDER_PRICE_LIST_IDS") ||
    [
      getDashboardEnv("LL_PRICE_LIST_HERDSHARE_ID", "2966"),
      getDashboardEnv("LL_PRICE_LIST_CSA_MEMBERS_ID", "2718"),
      getDashboardEnv("LL_PRICE_LIST_GUEST_ID", "3124")
    ].join(",")
);
const LOCAL_LINE_RETRY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.LOCALLINE_FETCH_RETRY_ATTEMPTS || "2", 10) || 2
);

function parseDashboardIdList(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function toNullableString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function parseYmd(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toYmdFromDateish(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatYmd(
      new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
    );
  }
  const stringValue = String(value || "").trim();
  const isoMatch = stringValue.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  return null;
}

function addDaysYmd(ymd, days) {
  const date = parseYmd(ymd);
  if (!date) return ymd;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return formatYmd(date);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getUtcWeekStart(date) {
  const start = startOfUtcDay(date);
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  return start;
}

function getLatestCompletedWeekEndYmd(referenceDate = new Date()) {
  const today = startOfUtcDay(referenceDate);
  const currentWeekStart = getUtcWeekStart(today);
  currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - 1);
  return formatYmd(currentWeekStart);
}

function getLatestCompletedWeekStartYmd(referenceDate = new Date()) {
  return addDaysYmd(getLatestCompletedWeekEndYmd(referenceDate), -6);
}

function getTodayYmd() {
  return formatYmd(startOfUtcDay(new Date()));
}

function toYmdFromSheetWeekLabel(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  if (!match) return null;
  const month = String(Number(match[1])).padStart(2, "0");
  const day = String(Number(match[2])).padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function stringifyJson(value) {
  if (value === null || typeof value === "undefined") return null;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
}

function normalizeAutoValue(valueType, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  if (valueType === "int") return Math.round(Number(value));
  if (valueType === "currency") return Number(value);
  if (valueType === "percent") return Number(value) / 100;
  return value;
}

function buildSubscriberSnapshotKey(row) {
  const planNumber = String(row["Plan #"] || "").trim();
  if (planNumber) return `plan:${planNumber}`;
  const email = String(row.Email || "").trim().toLowerCase();
  const customer = String(row.Customer || "").trim().toLowerCase();
  const created = String(row.Created || "").trim();
  return `fallback:${email}|${customer}|${created}`;
}

function parseCurrencyCell(value) {
  const numeric = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseLocalLineExportDate(value) {
  const isoDate = toYmdFromDateish(value);
  if (isoDate) return isoDate;
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function parseSnapshotRawJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

function isYmdInRange(value, start, end) {
  return Boolean(value && start && end && String(value) >= String(start) && String(value) <= String(end));
}

function isFeedAFriendAmount(amount) {
  return [100, 150, 250].includes(Number(amount));
}

function getSnapCustomerKeySql(alias = "o") {
  return `CASE
    WHEN ${alias}.customer_id IS NOT NULL THEN CONCAT('id:', ${alias}.customer_id)
    WHEN TRIM(COALESCE(${alias}.customer_name, '')) <> '' THEN CONCAT('name:', LOWER(TRIM(${alias}.customer_name)))
    ELSE NULL
  END`;
}

function getManualSourceValue(rowMap, rowLabel, weekColIdx) {
  const row = rowMap[rowLabel] || [];
  return row[weekColIdx] || "";
}

function getMinimumYmd(values = []) {
  const filtered = values.filter(Boolean).sort();
  return filtered[0] || null;
}

function getYearFromWeekStart(weekStart) {
  const match = String(weekStart || "").match(/^(\d{4})-/);
  return match ? match[1] : "";
}

function normalizeTimesheetTaskKey(value) {
  return String(value || "").trim().toLowerCase();
}

function formatTimesheetTaskFallbackLabel(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "No task";
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function computeTimesheetWorkingHours(row) {
  const breakHours = Number(row?.break || 0) / 60;
  const startValue = String(row?.start_time || "").trim();
  const endValue = String(row?.end_time || "").trim();
  const startMs = startValue ? new Date(startValue.replace(" ", "T")).getTime() : NaN;
  const endMs = endValue ? new Date(endValue.replace(" ", "T")).getTime() : NaN;
  const grossHours =
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, (endMs - startMs) / (1000 * 60 * 60))
      : 0;
  const computedNet = round2(Math.max(0, grossHours - breakHours));
  const provided = Number(row?.hours);
  const hasProvided =
    row?.hours !== undefined &&
    row?.hours !== null &&
    !Number.isNaN(provided);

  if (hasProvided && provided > 0) {
    if (computedNet <= 0) return round2(Math.max(0, provided));
    if (provided <= computedNet + 1e-6) return round2(Math.max(0, provided));
    return computedNet;
  }

  return computedNet;
}

function buildYearlyAverageMap(weeks, weeklyKpiMap, metricKey) {
  const totalsByYear = new Map();

  (Array.isArray(weeks) ? weeks : []).forEach((week) => {
    const year = getYearFromWeekStart(week?.start);
    if (!year) return;
    const value = Number(weeklyKpiMap?.[week.start]?.[metricKey]);
    if (!Number.isFinite(value)) return;
    const current = totalsByYear.get(year) || { total: 0, count: 0 };
    current.total += value;
    current.count += 1;
    totalsByYear.set(year, current);
  });

  return Object.fromEntries(
    Array.from(totalsByYear.entries()).map(([year, summary]) => [
      year,
      summary.count ? summary.total / summary.count : 0
    ])
  );
}

function buildDashboardRows(
  weeks,
  rowMap,
  weeklyKpiMap,
  vendorWeeklyMap,
  timesheetWeeklyMap,
  timesheetTaskLabels,
  subscriberWeeklyMap,
  publishableWeekStarts = null
) {
  const yearlyAverageOrdersByYear = buildYearlyAverageMap(weeks, weeklyKpiMap, "numOrders");
  const yearlyAverageSalesByYear = buildYearlyAverageMap(weeks, weeklyKpiMap, "totalSales");
  const wageTaskRows = (Array.isArray(timesheetTaskLabels) ? timesheetTaskLabels : []).map(
    (taskLabel) => ({
      label: `Wages - ${taskLabel}`,
      entry: "AUTO",
      source: "Timesheets DB (FFCSA wages + fringe)",
      valueType: "currency",
      auto: (w) => Number(timesheetWeeklyMap[w.start]?.tasks?.[taskLabel] || 0)
    })
  );
  const layout = [
    {
      section: "GIVENS",
      rows: [
        { label: "Errors/week", entry: "MANUAL", source: "Manual QA", rowLabel: "Errors/week" },
        { label: "Positive responses/week", entry: "MANUAL", source: "Manual QA", rowLabel: "Positive responses/week" },
        { label: "Num Orders", entry: "AUTO", source: "Local DB", valueType: "int", auto: (w) => Number(weeklyKpiMap[w.start]?.numOrders) },
        {
          label: "Orders Compared to Yearly Average",
          entry: "AUTO",
          source: "Local DB vs same-year weekly average",
          valueType: "percent",
          auto: (w) => {
            const orders = Number(weeklyKpiMap[w.start]?.numOrders || 0);
            const average = Number(yearlyAverageOrdersByYear[getYearFromWeekStart(w.start)] || 0);
            if (!average) return null;
            return ((orders - average) / average) * 100;
          }
        },
        { label: "Num Subscriber Orders", entry: "AUTO", source: "Local DB", valueType: "int", auto: (w) => Number(weeklyKpiMap[w.start]?.numSubscriberOrders) },
        { label: "Num Guest Orders", entry: "AUTO", source: "Local DB", valueType: "int", auto: (w) => Number(weeklyKpiMap[w.start]?.numGuestOrders) }
      ]
    },
    {
      section: "REVENUE",
      rows: [
        {
          label: "New Subscribers",
          entry: "AUTO",
          source: "Subscriber export Created dates",
          valueType: "int",
          auto: (w) => subscriberWeeklyMap[w.start]?.newSubscribers
        },
        {
          label: "Exiting Subscribers",
          entry: "AUTO",
          source: "Subscriber export Cancelled Date values",
          valueType: "int",
          auto: (w) => subscriberWeeklyMap[w.start]?.exitingSubscribers
        },
        {
          label: "SNAP subscribers",
          entry: "AUTO",
          source: "SNAP pricelist orders in trailing 5 weeks",
          valueType: "int",
          auto: (w) => Number(subscriberWeeklyMap[w.start]?.snapSubscribers)
        },
        {
          label: "Total Subscribers",
          entry: "AUTO",
          source: "Subscriber export active as of week end + SNAP",
          valueType: "int",
          auto: (w) => Number(subscriberWeeklyMap[w.start]?.totalSubscribers)
        },
        {
          label: "Average items Per order",
          entry: "AUTO",
          source: "Local DB",
          valueType: "int",
          auto: (w) => Number(weeklyKpiMap[w.start]?.averageItemsPerOrder)
        },
        {
          label: "Average Order Amount",
          entry: "AUTO",
          source: "Order export Order Total",
          valueType: "currency",
          auto: (w) => Number(weeklyKpiMap[w.start]?.averageOrderAmount)
        },
        {
          label: "Sales compared to yearly average",
          entry: "AUTO",
          source: "Local DB vs same-year weekly average",
          valueType: "percent",
          auto: (w) => {
            const sales = Number(weeklyKpiMap[w.start]?.totalSales || 0);
            const average = Number(yearlyAverageSalesByYear[getYearFromWeekStart(w.start)] || 0);
            if (!average) return null;
            return ((sales - average) / average) * 100;
          }
        },
        {
          label: "Retail Sales",
          entry: "AUTO",
          source: "Local DB",
          valueType: "currency",
          auto: (w) => Number(weeklyKpiMap[w.start]?.totalSales)
        }
      ]
    },
    {
      section: "COGS",
      rows: [
        {
          label: "PURCHASE COST",
          entry: "AUTO",
          source: "Local DB reporting cache",
          valueType: "currency",
          auto: (w) => Number(vendorWeeklyMap[w.start]?.purchaseCost)
        },
        {
          label: "$ Product Credits Given",
          entry: "MANUAL",
          source: "Manual / TODO automation",
          rowLabel: "$ Product Credits Given"
        },
        ...wageTaskRows,
        {
          label: "Total Wages",
          entry: "AUTO",
          source: "Timesheets DB (FFCSA wages + fringe total)",
          valueType: "currency",
          auto: (w) => Number(timesheetWeeklyMap[w.start]?.totalWages || 0)
        },
        {
          label: "% Wages to Overall Sales",
          entry: "AUTO",
          source: "Timesheets total wages / dashboard retail sales",
          valueType: "percent",
          auto: (w) => {
            const wages = Number(timesheetWeeklyMap[w.start]?.totalWages || 0);
            const retailSales = Number(weeklyKpiMap[w.start]?.totalSales || 0);
            if (!retailSales) return null;
            return (wages / retailSales) * 100;
          }
        },
        {
          label: "Other FFCSA operating costs Ops",
          entry: "MANUAL",
          source: "Manual",
          rowLabel: "Other FFCSA operating costs Ops"
        },
        {
          label: "%  product markup",
          entry: "AUTO",
          source: "Local DB reporting cache",
          valueType: "percent",
          auto: (w) => {
            const purchase = Number(vendorWeeklyMap[w.start]?.purchaseCost || 0);
            const retail = Number(vendorWeeklyMap[w.start]?.retailSales || 0);
            if (!purchase) return null;
            return ((retail - purchase) / purchase) * 100;
          }
        }
      ]
    }
  ];

  const values = [];
  const metricRows = [];
  const sectionRows = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  values.push([`FFCSA Dashboard Auto 2026`, `Updated ${now}`, "", "", ...weeks.map((w) => w.label)]);
  values.push(["Section", "Metric", "Entry Type", "Source", ...weeks.map((w) => w.label)]);

  for (const group of layout) {
    sectionRows.push(values.length);
    values.push([group.section, "", "", "", ...weeks.map(() => "")]);
    for (const row of group.rows) {
      const nextRow = ["", row.label, row.entry, row.source];
      for (let index = 0; index < weeks.length; index += 1) {
        const week = weeks[index];
        const weekIsPublishable =
          !publishableWeekStarts || publishableWeekStarts.has(week.start);
        if (!weekIsPublishable) {
          nextRow.push("");
          continue;
        }
        if (row.entry === "AUTO") {
          nextRow.push(normalizeAutoValue(row.valueType, row.auto ? row.auto(week) : null));
        } else {
          nextRow.push(getManualSourceValue(rowMap, row.rowLabel || row.label, index + 1));
        }
      }
      metricRows.push({
        rowIndex: values.length,
        valueType: row.valueType || null,
        entry: row.entry
      });
      values.push(nextRow);
    }
  }

  return { values, metricRows, sectionRows };
}

async function loadDashboardPublishAvailability() {
  const pool = getPool();
  const latestCompletedWeekStart = getLatestCompletedWeekStartYmd();
  const [cursorRows] = await pool.query(
    `
      SELECT
        sync_key AS syncKey,
        last_finished_at AS lastFinishedAt,
        last_status AS lastStatus
      FROM local_line_sync_cursors
      WHERE sync_key IN ('orders', 'subscriptions')
    `
  );
  const [snapshotRows] = await pool.query(
    `
      SELECT MAX(snapshot_week_end) AS latestSnapshotWeekEnd
      FROM local_line_subscription_snapshot_runs
    `
  );

  const cursorByKey = Object.fromEntries(
    (cursorRows || []).map((row) => [String(row.syncKey || ""), row])
  );
  const ordersCursor = cursorByKey.orders || null;
  const subscriptionsCursor = cursorByKey.subscriptions || null;
  const latestOrdersDownloadedWeekStart =
    ordersCursor?.lastStatus === "completed" && ordersCursor?.lastFinishedAt
      ? getLatestCompletedWeekStartYmd(new Date(ordersCursor.lastFinishedAt))
      : null;
  const latestSubscriptionSnapshotWeekStart = snapshotRows?.[0]?.latestSnapshotWeekEnd
    ? addDaysYmd(String(snapshotRows[0].latestSnapshotWeekEnd), -6)
    : null;
  const latestSubscriptionsDownloadedWeekStart =
    subscriptionsCursor?.lastStatus === "completed" && subscriptionsCursor?.lastFinishedAt
      ? getLatestCompletedWeekStartYmd(new Date(subscriptionsCursor.lastFinishedAt))
      : null;

  const publishableThroughWeekStart = getMinimumYmd([
    latestCompletedWeekStart,
    latestOrdersDownloadedWeekStart,
    latestSubscriptionSnapshotWeekStart,
    latestSubscriptionsDownloadedWeekStart
  ]);

  return {
    latestCompletedWeekStart,
    latestOrdersDownloadedWeekStart,
    latestSubscriptionSnapshotWeekStart,
    latestSubscriptionsDownloadedWeekStart,
    publishableThroughWeekStart
  };
}

async function fetchWithRetry(url, options, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= LOCAL_LINE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= LOCAL_LINE_RETRY_ATTEMPTS) break;
    }
  }
  throw new Error(`${label} request failed: ${lastError?.message || "fetch failed"}`);
}

async function requestLocalLineExport(url, accessToken) {
  const response = await fetchWithRetry(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "Local Line export request"
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line export request failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const exportId = Number(payload?.id);
  if (!Number.isFinite(exportId)) {
    throw new Error("Local Line export request did not return an export id");
  }
  return exportId;
}

async function pollLocalLineExportFilePath(exportId, accessToken) {
  const timeoutMs = 90_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchWithRetry(
      `${getLocalLineBaseUrl()}export/${exportId}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      `Local Line export ${exportId}`
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Local Line export poll failed: ${response.status} ${body}`);
    }
    const payload = await response.json();
    if (payload?.status === "COMPLETE" && payload?.file_path) {
      return String(payload.file_path);
    }
    if (payload?.status === "FAILED") {
      throw new Error(`Local Line export ${exportId} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Local Line export ${exportId} did not complete in time`);
}

async function downloadTextFile(url, accessToken) {
  const response = await fetchWithRetry(
    url,
    { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined },
    "Local Line text download"
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line text download failed: ${response.status} ${body}`);
  }
  return response.text();
}

async function downloadBinaryFile(url, accessToken) {
  const response = await fetchWithRetry(
    url,
    { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined },
    "Local Line binary download"
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line binary download failed: ${response.status} ${body}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseRowsFromBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames?.[0];
  const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
  if (!worksheet) return [];
  return xlsx.utils.sheet_to_json(worksheet, { raw: false, defval: "" });
}

function getSnapshotWeekEndFromFilename(filePath) {
  const match = path.basename(String(filePath || "")).match(/^subscribers_(\d{4}-\d{2}-\d{2})\.csv$/);
  return match ? match[1] : null;
}

function getSubscriberSnapshotSummary(rows = []) {
  let activeSubscribers = 0;
  let projectedMonthlyRevenue = 0;
  let skippedSubscribers = 0;
  let feedAFriendSubscribers = 0;

  rows.forEach((row) => {
    if (String(row.Status || "").trim().toLowerCase() !== "active") return;
    activeSubscribers += 1;
    const total = parseCurrencyCell(row.Total);
    projectedMonthlyRevenue += total;
    if (String(row["Next Fulfillment Status"] || "").trim().toLowerCase() === "skipped") {
      skippedSubscribers += 1;
    }
    if (isFeedAFriendAmount(total)) {
      feedAFriendSubscribers += 1;
    }
  });

  return {
    activeSubscribers,
    projectedMonthlyRevenue: Number(projectedMonthlyRevenue.toFixed(2)),
    skippedSubscribers,
    feedAFriendSubscribers
  };
}

function mapRowsByLabel(rows) {
  const map = {};
  rows.forEach((row) => {
    const label = String(row?.[0] || "").trim();
    if (label) {
      map[label] = row;
    }
  });
  return map;
}

async function fetchSourceSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${DASHBOARD_SHEET_ID}/export?format=csv&gid=${DASHBOARD_SOURCE_GID}`;
  const response = await fetchWithRetry(url, {}, "Dashboard source sheet");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard source sheet fetch failed: ${response.status} ${body}`);
  }
  const text = await response.text();
  const workbook = xlsx.read(text, { type: "string" });
  const worksheet = workbook.Sheets[workbook.SheetNames?.[0]];
  return xlsx.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: "" });
}

function extractWeeksFromSource(rows) {
  const header = rows?.[0] || [];
  const weeks = [];
  for (let index = 1; index < header.length; index += 1) {
    const label = String(header[index] || "").trim();
    if (!label) continue;
    const start = toYmdFromSheetWeekLabel(label);
    if (!start) continue;
    weeks.push({
      label,
      start,
      end: addDaysYmd(start, 6)
    });
  }
  return weeks;
}

function buildInClause(values = []) {
  return values.map(() => "?").join(", ");
}

async function loadWeeklyOrderMetrics(weeks) {
  const pool = getPool();
  const weekKeys = weeks.map((week) => week.start).filter(Boolean);
  if (!weekKeys.length) return {};

  const membershipExclusion =
    "NOT (LOWER(COALESCE(category_name, '')) = 'membership' OR LOWER(COALESCE(fulfillment_name, '')) LIKE '%membership purchase%')";
  const weekSql = buildInClause(weekKeys);

  const [orderRows] = await pool.query(
    `
      SELECT
        reporting_orders.weekKey,
        COUNT(*) AS orderCount,
        COUNT(CASE WHEN LOWER(COALESCE(reporting_orders.priceListName, '')) LIKE '%guest%' THEN 1 END) AS guestOrderCount,
        COALESCE(AVG(order_totals.total), 0) AS averageOrderAmount
      FROM (
        SELECT
          week_start AS weekKey,
          local_line_order_id,
          MAX(COALESCE(price_list_name, '')) AS priceListName
        FROM local_line_order_reporting_entries
        WHERE order_status = 'OPEN'
          AND payment_status = 'PAID'
          AND ${membershipExclusion}
          AND week_start IN (${weekSql})
        GROUP BY week_start, local_line_order_id
      ) reporting_orders
      LEFT JOIN (
        SELECT local_line_order_id, MAX(COALESCE(total, 0)) AS total
        FROM local_line_orders
        GROUP BY local_line_order_id
      ) order_totals
        ON order_totals.local_line_order_id = reporting_orders.local_line_order_id
      GROUP BY reporting_orders.weekKey
    `,
    weekKeys
  );

  const [reportingRows] = await pool.query(
    `
      SELECT
        week_start AS weekKey,
        COUNT(*) AS lineCount,
        COALESCE(SUM(retail_amount), 0) AS retailAmount,
        COALESCE(SUM(purchase_total), 0) AS purchaseTotal
      FROM local_line_order_reporting_entries
      WHERE order_status = 'OPEN'
        AND payment_status = 'PAID'
        AND ${membershipExclusion}
        AND week_start IN (${weekSql})
      GROUP BY week_start
    `,
    weekKeys
  );
  const [orderTotalRows] = await pool.query(
    `
      SELECT
        reporting_entries.week_start AS weekKey,
        reporting_entries.local_line_order_id AS localLineOrderId,
        reporting_entries.raw_json AS rawJson,
        orders.price_list_id AS priceListId,
        orders.total AS apiTotal
      FROM local_line_order_reporting_entries reporting_entries
      LEFT JOIN local_line_orders orders
        ON orders.local_line_order_id = reporting_entries.local_line_order_id
      WHERE reporting_entries.order_status = 'OPEN'
        AND reporting_entries.payment_status = 'PAID'
        AND NOT (
          LOWER(COALESCE(reporting_entries.category_name, '')) = 'membership'
          OR LOWER(COALESCE(reporting_entries.fulfillment_name, '')) LIKE '%membership purchase%'
        )
        AND reporting_entries.week_start IN (${weekSql})
    `,
    weekKeys
  );

  const orderMap = new Map(orderRows.map((row) => [String(row.weekKey), row]));
  const reportingMap = new Map(reportingRows.map((row) => [String(row.weekKey), row]));
  const averageOrderAmountMap = new Map();
  const orderTotalsByWeekAndOrder = new Map();

  for (const row of orderTotalRows) {
    const priceListId = Number(row.priceListId);
    if (
      DASHBOARD_ORDER_PRICE_LIST_IDS.length &&
      !DASHBOARD_ORDER_PRICE_LIST_IDS.includes(priceListId)
    ) {
      continue;
    }

    const weekKey = String(row.weekKey || "");
    const orderId = String(row.localLineOrderId || "");
    if (!weekKey || !orderId) continue;

    const mapKey = `${weekKey}:${orderId}`;
    if (orderTotalsByWeekAndOrder.has(mapKey)) continue;

    const raw = parseSnapshotRawJson(row.rawJson);
    const exportTotal = parseCurrencyCell(raw["Order Total"]);
    const apiTotal = Number(row.apiTotal);
    orderTotalsByWeekAndOrder.set(
      mapKey,
      exportTotal || (Number.isFinite(apiTotal) ? apiTotal : 0)
    );
  }

  for (const [key, total] of orderTotalsByWeekAndOrder.entries()) {
    const weekKey = key.split(":")[0];
    const summary = averageOrderAmountMap.get(weekKey) || { total: 0, count: 0 };
    summary.total += total;
    summary.count += 1;
    averageOrderAmountMap.set(weekKey, summary);
  }

  const result = {};

  weekKeys.forEach((weekKey) => {
    const orderRow = orderMap.get(weekKey);
    const reportingRow = reportingMap.get(weekKey);
    const averageOrderSummary = averageOrderAmountMap.get(weekKey);
    const numOrders = Number(orderRow?.orderCount || 0);
    const numGuestOrders = Number(orderRow?.guestOrderCount || 0);
    const lineCount = Number(reportingRow?.lineCount || 0);
    result[weekKey] = {
      numOrders,
      numGuestOrders,
      numSubscriberOrders: Math.max(0, numOrders - numGuestOrders),
      averageItemsPerOrder: numOrders ? Math.round(lineCount / numOrders) : 0,
      averageOrderAmount:
        averageOrderSummary?.count
          ? Number((averageOrderSummary.total / averageOrderSummary.count).toFixed(2))
          : Number(Number(orderRow?.averageOrderAmount || 0).toFixed(2)),
      totalSales: Number(Number(reportingRow?.retailAmount || 0).toFixed(2))
    };
  });

  return result;
}

async function loadVendorWeeklyMap(weeks) {
  const pool = getPool();
  const weekKeys = weeks.map((week) => week.start).filter(Boolean);
  if (!weekKeys.length) return {};
  const membershipExclusion =
    "NOT (LOWER(COALESCE(category_name, '')) = 'membership' OR LOWER(COALESCE(fulfillment_name, '')) LIKE '%membership purchase%')";

  const [rows] = await pool.query(
    `
      SELECT
        week_start AS weekKey,
        COALESCE(SUM(retail_amount), 0) AS retailSales,
        COALESCE(SUM(purchase_total), 0) AS purchaseCost
      FROM local_line_order_reporting_entries
      WHERE order_status = 'OPEN'
        AND payment_status = 'PAID'
        AND ${membershipExclusion}
        AND week_start IN (${buildInClause(weekKeys)})
      GROUP BY week_start
    `,
    weekKeys
  );

  return Object.fromEntries(
    rows.map((row) => [
      String(row.weekKey),
      {
        retailSales: Number(Number(row.retailSales || 0).toFixed(2)),
        purchaseCost: Number(Number(row.purchaseCost || 0).toFixed(2))
      }
    ])
  );
}

async function loadSnapSubscriberCounts(weekEnds = []) {
  const uniqueWeekEnds = [...new Set((weekEnds || []).filter(Boolean))];
  if (!uniqueWeekEnds.length) return {};
  const pool = getPool();
  const counts = {};

  for (const weekEnd of uniqueWeekEnds) {
    const [rows] = await pool.query(
      `
        SELECT
          COUNT(DISTINCT ${getSnapCustomerKeySql("o")}) AS snapSubscriberCount
        FROM local_line_orders o
        WHERE o.status = 'OPEN'
          AND o.payment_status = 'PAID'
          AND LOWER(COALESCE(o.price_list_name, '')) LIKE '%snap%'
          AND COALESCE(DATE(o.fulfillment_date), DATE(o.created_at_remote)) BETWEEN DATE_SUB(?, INTERVAL 34 DAY) AND ?
      `,
      [weekEnd, weekEnd]
    );
    counts[weekEnd] = Number(rows?.[0]?.snapSubscriberCount || 0);
  }

  return counts;
}

async function buildSubscriberWeeklyMap(weeks) {
  const pool = getPool();
  const snapshotWeekEnds = [...new Set(
    weeks.flatMap((week) => [week.end, addDaysYmd(week.end, -7)]).filter(Boolean)
  )];
  if (!snapshotWeekEnds.length) return {};

  const [summaryRows] = await pool.query(
    `
      SELECT
        snapshot_week_end AS snapshotWeekEnd,
        active_subscriber_count AS activeSubscriberCount,
        snap_subscriber_count AS snapSubscriberCount
      FROM local_line_subscription_snapshot_runs
      WHERE snapshot_week_end IN (${buildInClause(snapshotWeekEnds)})
    `,
    snapshotWeekEnds
  );
  const [rowRows] = await pool.query(
    `
      SELECT
        snapshot_week_end AS snapshotWeekEnd,
        snapshot_key AS snapshotKey,
        status,
        raw_json AS rawJson
      FROM local_line_subscription_snapshot_rows
      WHERE snapshot_week_end IN (${buildInClause(snapshotWeekEnds)})
    `,
    snapshotWeekEnds
  );

  const summaryMap = new Map(summaryRows.map((row) => [String(row.snapshotWeekEnd), row]));
  const rowsByWeekEnd = new Map();
  const activeKeysByWeekEnd = new Map();
  rowRows.forEach((row) => {
    const weekEnd = String(row.snapshotWeekEnd || "");
    const nextRows = rowsByWeekEnd.get(weekEnd) || [];
    nextRows.push(row);
    rowsByWeekEnd.set(weekEnd, nextRows);
    if (String(row.status || "").trim().toLowerCase() !== "active") return;
    const nextSet = activeKeysByWeekEnd.get(weekEnd) || new Set();
    nextSet.add(String(row.snapshotKey || ""));
    activeKeysByWeekEnd.set(weekEnd, nextSet);
  });

  const result = {};
  weeks.forEach((week) => {
    const currentSet = activeKeysByWeekEnd.get(week.end) || null;
    const previousSet = activeKeysByWeekEnd.get(addDaysYmd(week.end, -7)) || null;
    const currentSummary = summaryMap.get(week.end);
    const currentRows = rowsByWeekEnd.get(week.end) || [];
    const newSubscriberKeys = new Set();
    const exitingSubscriberKeys = new Set();
    const activeAsOfWeekEndKeys = new Set();
    let hasCreatedDates = false;
    let hasCancelledDates = false;

    for (const row of currentRows) {
      const raw = parseSnapshotRawJson(row.rawJson);
      const snapshotKey = String(row.snapshotKey || "");
      const createdDate = parseLocalLineExportDate(raw.Created);
      const cancelledDate = parseLocalLineExportDate(raw["Cancelled Date"]);
      if (Object.prototype.hasOwnProperty.call(raw, "Created")) hasCreatedDates = true;
      if (Object.prototype.hasOwnProperty.call(raw, "Cancelled Date")) hasCancelledDates = true;
      if (
        createdDate &&
        String(createdDate) <= String(week.end) &&
        (String(row.status || "").trim().toLowerCase() === "active" ||
          (cancelledDate && String(cancelledDate) > String(week.end)))
      ) {
        activeAsOfWeekEndKeys.add(snapshotKey);
      }
      if (isYmdInRange(createdDate, week.start, week.end)) {
        newSubscriberKeys.add(snapshotKey);
      }
      if (isYmdInRange(cancelledDate, week.start, week.end)) {
        exitingSubscriberKeys.add(snapshotKey);
      }
    }

    result[week.start] = {
      snapSubscribers: Number(currentSummary?.snapSubscriberCount || 0),
      totalSubscribers:
        (hasCreatedDates
          ? activeAsOfWeekEndKeys.size
          : Number(currentSummary?.activeSubscriberCount || 0)) +
        Number(currentSummary?.snapSubscriberCount || 0),
      newSubscribers: hasCreatedDates
        ? newSubscriberKeys.size
        : currentSet && previousSet
          ? [...currentSet].filter((value) => !previousSet.has(value)).length
          : null,
      exitingSubscribers: hasCancelledDates
        ? exitingSubscriberKeys.size
        : currentSet && previousSet
          ? [...previousSet].filter((value) => !currentSet.has(value)).length
          : null
    };
  });

  return result;
}

function getTimesheetDbConfig() {
  const database =
    getDashboardEnv("TIMESHEET_DB_DATABASE") ||
    getDashboardEnv("TIMESHEET_DB_NAME") ||
    "timesheets";
  if (!database || (!getDashboardEnv("TIMESHEET_DB_HOST") && !getDashboardEnv("STORE_DB_HOST"))) {
    return { config: null, status: "timesheets DB connection settings not available" };
  }

  return {
    config: {
      host: getDashboardEnv("TIMESHEET_DB_HOST") || getDashboardEnv("STORE_DB_HOST"),
      port: Number(
        getDashboardEnv("TIMESHEET_DB_PORT") ||
          getDashboardEnv("STORE_DB_PORT") ||
          3306
      ),
      user: getDashboardEnv("TIMESHEET_DB_USER") || getDashboardEnv("STORE_DB_USER"),
      password:
        getDashboardEnv("TIMESHEET_DB_PASSWORD") || getDashboardEnv("STORE_DB_PASSWORD"),
      database
    },
    status: "enabled"
  };
}

async function loadTimesheetTaskDefinitions(pool, enterprise = "FFCSA") {
  try {
    const [rows] = await pool.query(
      `
        SELECT task_value, task_label, COALESCE(sort_order, 0) AS sort_order
        FROM enterprise_subtasks
        WHERE LOWER(TRIM(enterprise)) = LOWER(TRIM(?))
          AND COALESCE(is_active, 1) = 1
        ORDER BY
          CASE WHEN COALESCE(sort_order, 0) = 0 THEN 1 ELSE 0 END ASC,
          CASE WHEN COALESCE(sort_order, 0) = 0 THEN NULL ELSE sort_order END ASC,
          task_label ASC,
          task_value ASC
      `,
      [enterprise]
    );
    return (rows || []).map((row) => ({
      key: normalizeTimesheetTaskKey(row.task_value || row.task_label),
      label: String(row.task_label || row.task_value || "").trim(),
      sortOrder: Number(row.sort_order || 0)
    }));
  } catch (_error) {
    return [];
  }
}

function findTimesheetRate(ladders, employeeId, atDate) {
  const ladder = ladders.get(employeeId);
  if (!ladder || !ladder.length) return null;
  let chosen = null;
  for (let index = 0; index < ladder.length; index += 1) {
    if (ladder[index].from <= atDate) chosen = ladder[index];
    else break;
  }
  return chosen;
}

async function buildTimesheetWeeklyMap(weeks) {
  const weekKeys = (Array.isArray(weeks) ? weeks : []).map((week) => week.start).filter(Boolean);
  if (!weekKeys.length) {
    return { map: {}, taskLabels: [], status: "no dashboard weeks requested" };
  }

  const { config, status } = getTimesheetDbConfig();
  if (!config) return { map: {}, taskLabels: [], status };

  const pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0
  });

  const map = Object.fromEntries(
    weekKeys.map((weekKey) => [weekKey, { totalWages: 0, tasks: {} }])
  );

  try {
    const oldestWeekStart = [...weekKeys].sort()[0];
    const newestWeekStart = [...weekKeys].sort().slice(-1)[0];
    const timesheetStart = `${oldestWeekStart} 00:00:00`;
    const timesheetEnd = `${addDaysYmd(newestWeekStart, 6)} 23:59:59`;
    const approvedStatuses = String(TIMESHEET_APPROVED_STATUSES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    let timesheetSql = `
      SELECT employee_id, task, start_time, end_time, \`break\`, hours
      FROM timesheets
      WHERE start_time >= ?
        AND start_time <= ?
        AND enterprise LIKE ?
    `;
    const timesheetParams = [timesheetStart, timesheetEnd, "%FFCSA%"];
    if (approvedStatuses.length) {
      timesheetSql += ` AND approved IN (${buildInClause(approvedStatuses)})`;
      timesheetParams.push(...approvedStatuses);
    }
    timesheetSql += ` ORDER BY start_time ASC`;

    const [timesheetRows] = await pool.query(timesheetSql, timesheetParams);
    const employeeIds = Array.from(
      new Set((timesheetRows || []).map((row) => row.employee_id).filter(Boolean))
    );
    const taskDefs = await loadTimesheetTaskDefinitions(pool, "FFCSA");
    const taskDefByKey = new Map(
      taskDefs
        .filter((task) => task.key && task.label)
        .map((task) => [task.key, task])
    );

    const ladders = new Map();
    if (employeeIds.length) {
      const [wageRows] = await pool.query(
        `
          SELECT employee_id, wage, fringe, start_date AS effective_from
          FROM employee_wages
          WHERE employee_id IN (${buildInClause(employeeIds)})
            AND start_date <= ?
          ORDER BY employee_id ASC, start_date ASC
        `,
        [...employeeIds, timesheetEnd]
      );

      for (const row of wageRows || []) {
        const employeeId = row.employee_id;
        let fringe = Number(row.fringe || 0);
        if (fringe > 1) fringe = fringe / 100;
        if (!ladders.has(employeeId)) ladders.set(employeeId, []);
        ladders.get(employeeId).push({
          from: new Date(row.effective_from),
          wage: Number(row.wage || 0),
          fringe
        });
      }
    }

    const observedTaskLabels = new Set();
    for (const row of timesheetRows || []) {
      const rowDate = toYmdFromDateish(row.start_time);
      const rowDay = parseYmd(rowDate);
      if (!rowDay) continue;
      const weekStart = formatYmd(getUtcWeekStart(rowDay));
      if (!map[weekStart]) continue;

      const hours = computeTimesheetWorkingHours(row);
      if (!hours) continue;

      const rate = findTimesheetRate(ladders, row.employee_id, new Date(row.start_time));
      const withFringe = rate
        ? round2(hours * Number(rate.wage || 0) * (1 + Number(rate.fringe || 0)))
        : 0;

      const taskKey = normalizeTimesheetTaskKey(row.task);
      const taskLabel =
        taskDefByKey.get(taskKey)?.label || formatTimesheetTaskFallbackLabel(row.task);
      observedTaskLabels.add(taskLabel);

      const weekEntry = map[weekStart];
      weekEntry.totalWages = round2(weekEntry.totalWages + withFringe);
      weekEntry.tasks[taskLabel] = round2(
        Number(weekEntry.tasks[taskLabel] || 0) + withFringe
      );
    }

    const taskLabels = Array.from(observedTaskLabels).sort((left, right) => {
      const leftKey = normalizeTimesheetTaskKey(left);
      const rightKey = normalizeTimesheetTaskKey(right);
      const leftSort = taskDefByKey.get(leftKey)?.sortOrder || Number.MAX_SAFE_INTEGER;
      const rightSort = taskDefByKey.get(rightKey)?.sortOrder || Number.MAX_SAFE_INTEGER;
      if (leftSort !== rightSort) return leftSort - rightSort;
      return String(left).localeCompare(String(right));
    });

    return {
      map,
      taskLabels,
      status: `connected (${Object.keys(map).length}/${weeks.length} weeks, ${taskLabels.length} wage task rows)`
    };
  } catch (error) {
    return { map: {}, taskLabels: [], status: `connection error: ${error?.message || error}` };
  } finally {
    try {
      await pool.end();
    } catch (_error) {
      // no-op
    }
  }
}

function hexColor(hex) {
  const clean = hex.replace("#", "");
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255
  };
}

async function getSheetsAccessToken() {
  const serviceAccountJson = getDashboardEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const directAccessToken = getDashboardEnv("GOOGLE_SHEETS_ACCESS_TOKEN");
  const googleClientId = getDashboardEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = getDashboardEnv("GOOGLE_CLIENT_SECRET");
  const googleRefreshToken = getDashboardEnv("GOOGLE_REFRESH_TOKEN");

  if (serviceAccountJson) {
    const raw = serviceAccountJson.trim();
    const credentials = raw.startsWith("{")
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw), "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: credentials.token_uri || "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    };
    const base64Url = (value) =>
      Buffer.from(JSON.stringify(value))
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const unsigned = `${base64Url(header)}.${base64Url(claim)}`;
    const signature = crypto
      .createSign("RSA-SHA256")
      .update(unsigned)
      .sign(credentials.private_key, "base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`
      })
    });
    if (!response.ok) {
      throw new Error(`Google token request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    return payload.access_token;
  }

  if (googleClientId && googleClientSecret && googleRefreshToken) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: googleRefreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!response.ok) {
      throw new Error(`Google token refresh failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    return payload.access_token;
  }

  if (directAccessToken) {
    return directAccessToken;
  }

  throw new Error(
    "Google Sheets auth missing. Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN, or GOOGLE_SHEETS_ACCESS_TOKEN."
  );
}

async function sheetsRequest(accessToken, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets request failed: ${response.status} ${response.statusText} ${text}`);
  }
  return response.json().catch(() => ({}));
}

async function getOrCreateSheetProperties(accessToken, spreadsheetId, title) {
  const meta = await sheetsRequest(
    accessToken,
    "GET",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`
  );
  const match = (meta.sheets || []).find((sheet) => sheet?.properties?.title === title);
  if (match?.properties?.sheetId || match?.properties?.sheetId === 0) {
    return match.properties;
  }
  const created = await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      requests: [{ addSheet: { properties: { title } } }]
    }
  );
  return created?.replies?.[0]?.addSheet?.properties || null;
}

async function writeDashboardToSheet(accessToken, values, metricRows, sectionRows) {
  const sheetProperties = await getOrCreateSheetProperties(
    accessToken,
    DASHBOARD_SHEET_ID,
    DASHBOARD_TARGET_TITLE
  );
  const sheetId = Number(sheetProperties?.sheetId);
  const maxCols = values[0]?.length || 1;
  const maxRows = values.length || 1;
  const gridRowCount = Math.max(Number(sheetProperties?.gridProperties?.rowCount || 0), maxRows, 1);
  const gridColumnCount = Math.max(Number(sheetProperties?.gridProperties?.columnCount || 0), maxCols, 1);
  const titleMergeEndCol = Math.min(4, maxCols);

  await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${DASHBOARD_TARGET_TITLE}!A:ZZ`)}:clear`,
    {}
  );
  await sheetsRequest(
    accessToken,
    "PUT",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${DASHBOARD_TARGET_TITLE}!A1`)}?valueInputOption=USER_ENTERED`,
    {
      range: `${DASHBOARD_TARGET_TITLE}!A1`,
      majorDimension: "ROWS",
      values
    }
  );

  const requests = [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 2, frozenColumnCount: 4 }
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: gridRowCount,
          startColumnIndex: 0,
          endColumnIndex: gridColumnCount
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#FFFFFF"),
            textFormat: { foregroundColor: hexColor("#000000"), fontSize: 10, bold: false },
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)"
      }
    }
  ];

  if (titleMergeEndCol > 1) {
    requests.push({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: titleMergeEndCol
        },
        mergeType: "MERGE_ALL"
      }
    });
  }

  requests.push(
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#1F4E78"),
            textFormat: { foregroundColor: hexColor("#FFFFFF"), bold: true, fontSize: 12 },
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)"
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#2F75B5"),
            textFormat: { foregroundColor: hexColor("#FFFFFF"), bold: true },
            horizontalAlignment: "CENTER"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
      }
    }
  );

  sectionRows.forEach((rowIndex) => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#D9E1F2"),
            textFormat: { bold: true }
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)"
      }
    });
  });

  metricRows.forEach((metric) => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            backgroundColor: metric.entry === "AUTO" ? hexColor("#D9EAD3") : hexColor("#FFF2CC"),
            textFormat: { bold: true },
            horizontalAlignment: "CENTER"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
      }
    });

    let pattern = null;
    if (metric.valueType === "currency") pattern = "$#,##0.00";
    if (metric.valueType === "int") pattern = "0";
    if (metric.valueType === "percent") pattern = "0.00%";
    if (!pattern) return;

    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 4, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type:
                metric.valueType === "currency"
                  ? "CURRENCY"
                  : metric.valueType === "percent"
                    ? "PERCENT"
                    : "NUMBER",
              pattern
            }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    });
  });

  [
    { startIndex: 0, pixelSize: 120 },
    { startIndex: 1, pixelSize: 260 },
    { startIndex: 2, pixelSize: 110 },
    { startIndex: 3, pixelSize: 180 }
  ].forEach((column) => {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: column.startIndex,
          endIndex: column.startIndex + 1
        },
        properties: { pixelSize: column.pixelSize },
        fields: "pixelSize"
      }
    });
  });

  requests.push({
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: 4,
        endIndex: maxCols
      },
      properties: { pixelSize: 92 },
      fields: "pixelSize"
    }
  });

  await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}:batchUpdate`,
    { requests }
  );
}

async function upsertSyncCursor(connection, syncKey, values = {}) {
  const now = new Date();
  await connection.query(
    `
      INSERT INTO local_line_sync_cursors (
        sync_key,
        cursor_value,
        synced_through_at,
        last_started_at,
        last_finished_at,
        last_status,
        last_message,
        summary_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        cursor_value = VALUES(cursor_value),
        synced_through_at = VALUES(synced_through_at),
        last_started_at = VALUES(last_started_at),
        last_finished_at = VALUES(last_finished_at),
        last_status = VALUES(last_status),
        last_message = VALUES(last_message),
        summary_json = VALUES(summary_json),
        updated_at = VALUES(updated_at)
    `,
    [
      syncKey,
      values.cursorValue ?? null,
      values.syncedThroughAt ?? null,
      values.lastStartedAt ?? null,
      values.lastFinishedAt ?? null,
      values.lastStatus ?? null,
      values.lastMessage ?? null,
      values.summaryJson ?? null,
      values.createdAt ?? now,
      values.updatedAt ?? now
    ]
  );
}

export async function syncLocalLineSubscriberSnapshotCache({
  reportProgress = () => {},
  snapshotWeekEnd = null,
  phase = {}
} = {}) {
  const effectiveWeekEnd = snapshotWeekEnd || getLatestCompletedWeekEndYmd();
  const accessToken = await getLocalLineAccessToken();
  const phaseKeys = {
    fetch: phase.fetchKey || "fetch",
    store: phase.storeKey || "store",
    finalize: phase.finalizeKey || "finalize"
  };
  const phaseLabels = {
    fetch: phase.fetchLabel || "Fetch Subscribers",
    store: phase.storeLabel || "Store Subscribers",
    finalize: phase.finalizeLabel || "Finalize"
  };
  reportProgress({
    phaseKey: phaseKeys.fetch,
    phaseLabel: phaseLabels.fetch,
    status: "running",
    percent: 0,
    message: `Downloading subscriber snapshot for week ending ${effectiveWeekEnd}`
  });

  const buffer = await downloadBinaryFile(`${getLocalLineBaseUrl()}order-subscriptions/export/`, accessToken);
  const rows = parseRowsFromBuffer(buffer);
  const summary = getSubscriberSnapshotSummary(rows);
  const snapCounts = await loadSnapSubscriberCounts([effectiveWeekEnd]);
  const snapSubscriberCount = Number(snapCounts[effectiveWeekEnd] || 0);
  const pool = getPool();
  const connection = await pool.getConnection();
  const now = new Date();

  try {
    reportProgress({
      phaseKey: phaseKeys.fetch,
      phaseLabel: phaseLabels.fetch,
      status: "completed",
      percent: 100,
      current: rows.length,
      total: rows.length,
      message: `Fetched ${rows.length} subscription rows`
    });
    reportProgress({
      phaseKey: phaseKeys.store,
      phaseLabel: phaseLabels.store,
      status: "running",
      percent: 0,
      current: 0,
      total: rows.length,
      message: `Writing subscriber snapshot for ${effectiveWeekEnd}`
    });

    await connection.beginTransaction();
    await connection.query(
      "DELETE FROM local_line_subscription_snapshot_rows WHERE snapshot_week_end = ?",
      [effectiveWeekEnd]
    );

    const preparedRows = rows.map((row) => {
      const total = parseCurrencyCell(row.Total);
      return [
        effectiveWeekEnd,
        buildSubscriberSnapshotKey(row),
        toNullableString(row["Plan #"]),
        toNullableString(row.Customer),
        toNullableString(row.Email),
        toNullableString(row.Status),
        toNullableString(row["Next Fulfillment Status"]),
        Number(total.toFixed(2)),
        isFeedAFriendAmount(total) ? 1 : 0,
        stringifyJson(row),
        now,
        now,
        now
      ];
    });

    const chunkSize = 250;
    for (let index = 0; index < preparedRows.length; index += chunkSize) {
      const chunk = preparedRows.slice(index, index + chunkSize);
      if (!chunk.length) continue;
      const valuesSql = chunk
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");
      await connection.query(
        `
          INSERT INTO local_line_subscription_snapshot_rows (
            snapshot_week_end,
            snapshot_key,
            plan_number,
            customer_name,
            email,
            status,
            next_fulfillment_status,
            total,
            is_feed_a_friend,
            raw_json,
            captured_at,
            created_at,
            updated_at
          ) VALUES ${valuesSql}
        `,
        chunk.flat()
      );
      reportProgress({
        phaseKey: phaseKeys.store,
        phaseLabel: phaseLabels.store,
        status: "running",
        percent: Math.round((Math.min(index + chunk.length, preparedRows.length) / Math.max(preparedRows.length, 1)) * 100),
        current: Math.min(index + chunk.length, preparedRows.length),
        total: preparedRows.length,
        message: `Stored ${Math.min(index + chunk.length, preparedRows.length)} of ${preparedRows.length} subscription rows`
      });
    }

    await connection.query(
      `
        INSERT INTO local_line_subscription_snapshot_runs (
          snapshot_week_end,
          row_count,
          active_subscriber_count,
          snap_subscriber_count,
          projected_monthly_revenue,
          skipped_subscriber_count,
          feed_a_friend_subscriber_count,
          captured_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          row_count = VALUES(row_count),
          active_subscriber_count = VALUES(active_subscriber_count),
          snap_subscriber_count = VALUES(snap_subscriber_count),
          projected_monthly_revenue = VALUES(projected_monthly_revenue),
          skipped_subscriber_count = VALUES(skipped_subscriber_count),
          feed_a_friend_subscriber_count = VALUES(feed_a_friend_subscriber_count),
          captured_at = VALUES(captured_at),
          updated_at = VALUES(updated_at)
      `,
      [
        effectiveWeekEnd,
        preparedRows.length,
        summary.activeSubscribers,
        snapSubscriberCount,
        summary.projectedMonthlyRevenue,
        summary.skippedSubscribers,
        summary.feedAFriendSubscribers,
        now,
        now,
        now
      ]
    );

    await upsertSyncCursor(connection, "subscriptions", {
      cursorValue: effectiveWeekEnd,
      syncedThroughAt: now,
      lastStartedAt: now,
      lastFinishedAt: now,
      lastStatus: "completed",
      lastMessage: `Stored subscriber snapshot for ${effectiveWeekEnd}`,
      summaryJson: stringifyJson({
        snapshotWeekEnd: effectiveWeekEnd,
        rowCount: preparedRows.length,
        snapSubscriberCount,
        ...summary
      }),
      updatedAt: now
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    await upsertSyncCursor(connection, "subscriptions", {
      cursorValue: effectiveWeekEnd,
      lastStartedAt: now,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Subscriber sync failed",
      updatedAt: new Date()
    }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }

  reportProgress({
    phaseKey: phaseKeys.store,
    phaseLabel: phaseLabels.store,
    status: "completed",
    percent: 100,
    current: rows.length,
    total: rows.length,
    message: `Stored subscriber snapshot for ${effectiveWeekEnd}`
  });
  reportProgress({
    phaseKey: phaseKeys.finalize,
    phaseLabel: phaseLabels.finalize,
    status: "completed",
    percent: 100,
    message: "Subscriber sync complete"
  });

  return {
    snapshotWeekEnd: effectiveWeekEnd,
    rowCount: rows.length,
    snapSubscriberCount,
    ...summary
  };
}

export async function importLocalLineSubscriberHistory({
  reportProgress = () => {},
  sourceDir = DEFAULT_SUBSCRIBER_HISTORY_DIR
} = {}) {
  const resolvedDir = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Subscriber history directory not found: ${resolvedDir}`);
  }

  const files = fs
    .readdirSync(resolvedDir)
    .filter((name) => /^subscribers_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
    .sort();

  if (!files.length) {
    throw new Error(`No subscriber snapshot CSV files found in ${resolvedDir}`);
  }

  const pool = getPool();
  const connection = await pool.getConnection();
  const startedAt = new Date();

  try {
    await upsertSyncCursor(connection, "subscriptions-history", {
      cursorValue: files[files.length - 1] || null,
      lastStartedAt: startedAt,
      lastStatus: "running",
      lastMessage: `Importing ${files.length} historical subscriber snapshots`,
      updatedAt: startedAt
    });

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Read Snapshot Files",
      status: "running",
      percent: 0,
      current: 0,
      total: files.length,
      message: `Scanning ${files.length} historical subscriber files`
    });

    let importedWeeks = 0;
    let importedRows = 0;

    for (let index = 0; index < files.length; index += 1) {
      const filename = files[index];
      const snapshotWeekEnd = getSnapshotWeekEndFromFilename(filename);
      if (!snapshotWeekEnd) continue;
      const filePath = path.join(resolvedDir, filename);
      const buffer = fs.readFileSync(filePath);
      const rows = parseRowsFromBuffer(buffer);
      const summary = getSubscriberSnapshotSummary(rows);
      const snapCounts = await loadSnapSubscriberCounts([snapshotWeekEnd]);
      const snapSubscriberCount = Number(snapCounts[snapshotWeekEnd] || 0);
      const now = new Date();

      reportProgress({
        phaseKey: "fetch",
        phaseLabel: "Read Snapshot Files",
        status: "running",
        percent: Math.round(((index + 1) / files.length) * 100),
        current: index + 1,
        total: files.length,
        message: `Read ${filename}`
      });
      reportProgress({
        phaseKey: "store",
        phaseLabel: "Store Snapshot History",
        status: "running",
        percent: Math.round((index / files.length) * 100),
        current: index,
        total: files.length,
        message: `Importing ${filename}`
      });

      await connection.beginTransaction();
      await connection.query(
        "DELETE FROM local_line_subscription_snapshot_rows WHERE snapshot_week_end = ?",
        [snapshotWeekEnd]
      );

      const preparedRows = rows.map((row) => {
        const total = parseCurrencyCell(row.Total);
        return [
          snapshotWeekEnd,
          buildSubscriberSnapshotKey(row),
          toNullableString(row["Plan #"]),
          toNullableString(row.Customer),
          toNullableString(row.Email),
          toNullableString(row.Status),
          toNullableString(row["Next Fulfillment Status"]),
          Number(total.toFixed(2)),
          isFeedAFriendAmount(total) ? 1 : 0,
          stringifyJson(row),
          now,
          now,
          now
        ];
      });

      const chunkSize = 250;
      for (let rowIndex = 0; rowIndex < preparedRows.length; rowIndex += chunkSize) {
        const chunk = preparedRows.slice(rowIndex, rowIndex + chunkSize);
        if (!chunk.length) continue;
        const valuesSql = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        await connection.query(
          `
            INSERT INTO local_line_subscription_snapshot_rows (
              snapshot_week_end,
              snapshot_key,
              plan_number,
              customer_name,
              email,
              status,
              next_fulfillment_status,
              total,
              is_feed_a_friend,
              raw_json,
              captured_at,
              created_at,
              updated_at
            ) VALUES ${valuesSql}
          `,
          chunk.flat()
        );
      }

      await connection.query(
        `
          INSERT INTO local_line_subscription_snapshot_runs (
            snapshot_week_end,
            row_count,
            active_subscriber_count,
            snap_subscriber_count,
            projected_monthly_revenue,
            skipped_subscriber_count,
            feed_a_friend_subscriber_count,
            captured_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            row_count = VALUES(row_count),
            active_subscriber_count = VALUES(active_subscriber_count),
            snap_subscriber_count = VALUES(snap_subscriber_count),
            projected_monthly_revenue = VALUES(projected_monthly_revenue),
            skipped_subscriber_count = VALUES(skipped_subscriber_count),
            feed_a_friend_subscriber_count = VALUES(feed_a_friend_subscriber_count),
            captured_at = VALUES(captured_at),
            updated_at = VALUES(updated_at)
        `,
        [
          snapshotWeekEnd,
          preparedRows.length,
          summary.activeSubscribers,
          snapSubscriberCount,
          summary.projectedMonthlyRevenue,
          summary.skippedSubscribers,
          summary.feedAFriendSubscribers,
          now,
          now,
          now
        ]
      );
      await connection.commit();

      importedWeeks += 1;
      importedRows += preparedRows.length;
      reportProgress({
        phaseKey: "store",
        phaseLabel: "Store Snapshot History",
        status: "running",
        percent: Math.round(((index + 1) / files.length) * 100),
        current: index + 1,
        total: files.length,
        message: `Imported ${filename}`
      });
    }

    const finishedAt = new Date();
    const summary = {
      sourceDir: resolvedDir,
      fileCount: files.length,
      importedWeeks,
      importedRows,
      firstSnapshotWeekEnd: getSnapshotWeekEndFromFilename(files[0]),
      lastSnapshotWeekEnd: getSnapshotWeekEndFromFilename(files[files.length - 1])
    };

    await upsertSyncCursor(connection, "subscriptions-history", {
      cursorValue: summary.lastSnapshotWeekEnd,
      syncedThroughAt: finishedAt,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastStatus: "completed",
      lastMessage: `Imported ${importedWeeks} historical subscriber snapshots`,
      summaryJson: stringifyJson(summary),
      updatedAt: finishedAt
    });

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Read Snapshot Files",
      status: "completed",
      percent: 100,
      current: files.length,
      total: files.length,
      message: `Read ${files.length} snapshot files`
    });
    reportProgress({
      phaseKey: "store",
      phaseLabel: "Store Snapshot History",
      status: "completed",
      percent: 100,
      current: files.length,
      total: files.length,
      message: `Imported ${importedWeeks} snapshot weeks`
    });
    reportProgress({
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Subscriber history import complete"
    });

    return summary;
  } catch (error) {
    await connection.rollback().catch(() => {});
    await upsertSyncCursor(connection, "subscriptions-history", {
      lastStartedAt: startedAt,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Subscriber history import failed",
      updatedAt: new Date()
    }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function publishLocalLineDashboard({ reportProgress = () => {} } = {}) {
  const pool = getPool();
  const connection = await pool.getConnection();
  const startedAt = new Date();

  try {
    await upsertSyncCursor(connection, "dashboard", {
      lastStartedAt: startedAt,
      lastStatus: "running",
      lastMessage: "Building dashboard dataset",
      updatedAt: startedAt
    });

    reportProgress({
      phaseKey: "prepare",
      phaseLabel: "Prepare Dashboard",
      status: "running",
      percent: 0,
      message: "Loading source sheet layout"
    });

    const sourceRows = await fetchSourceSheetRows();
    const weeks = extractWeeksFromSource(sourceRows);
    if (!weeks.length) {
      throw new Error("No dashboard week columns found in the source sheet.");
    }
    const rowMap = mapRowsByLabel(sourceRows.slice(2));
    const availability = await loadDashboardPublishAvailability();
    const publishableWeekStarts = new Set(
      weeks
        .filter(
          (week) =>
            availability.publishableThroughWeekStart &&
            String(week.start || "") <= String(availability.publishableThroughWeekStart)
        )
        .map((week) => week.start)
    );
    const skippedWeeks = weeks.filter((week) => !publishableWeekStarts.has(week.start));
    const warningSkippedWeeks = skippedWeeks.filter(
      (week) =>
        availability.latestCompletedWeekStart &&
        String(week.start || "") <= String(availability.latestCompletedWeekStart)
    );
    const futureSkippedWeeks = skippedWeeks.filter(
      (week) =>
        !availability.latestCompletedWeekStart ||
        String(week.start || "") > String(availability.latestCompletedWeekStart)
    );
    const dashboardWarnings = [];

    if (!availability.publishableThroughWeekStart) {
      dashboardWarnings.push(
        "No completed dashboard week is publishable yet because local orders/subscriber pulls do not cover a full week."
      );
    }
    if (warningSkippedWeeks.length) {
      dashboardWarnings.push(
        `Left ${warningSkippedWeeks.length} completed but not-yet-pulled week columns blank: ${warningSkippedWeeks
          .map((week) => week.label)
          .join(", ")}`
      );
    }

    reportProgress({
      phaseKey: "prepare",
      phaseLabel: "Prepare Dashboard",
      status: "completed",
      percent: 100,
      current: weeks.length,
      total: weeks.length,
      message: warningSkippedWeeks.length
        ? `Loaded ${weeks.length} dashboard weeks; ${warningSkippedWeeks.length} completed week columns are still blank pending local data`
        : `Loaded ${weeks.length} dashboard weeks`
    });

    reportProgress({
      phaseKey: "compute",
      phaseLabel: "Compute Metrics",
      status: "running",
      percent: 0,
      message: "Building weekly dashboard metrics"
    });

    const [weeklyKpiMap, vendorWeeklyMap, subscriberWeeklyMap, timesheetResult] = await Promise.all([
      loadWeeklyOrderMetrics(weeks),
      loadVendorWeeklyMap(weeks),
      buildSubscriberWeeklyMap(weeks),
      buildTimesheetWeeklyMap(weeks)
    ]);

    const { values, metricRows, sectionRows } = buildDashboardRows(
      weeks,
      rowMap,
      weeklyKpiMap,
      vendorWeeklyMap,
      timesheetResult.map || {},
      timesheetResult.taskLabels || [],
      subscriberWeeklyMap,
      publishableWeekStarts
    );

    const missingSubscriberWeeks = weeks
      .filter(
        (week) =>
          publishableWeekStarts.has(week.start) && !subscriberWeeklyMap[week.start]?.totalSubscribers
      )
      .map((week) => week.end);

    reportProgress({
      phaseKey: "compute",
      phaseLabel: "Compute Metrics",
      status: "completed",
      percent: 100,
      current: weeks.length,
      total: weeks.length,
      message: dashboardWarnings.length
        ? `${dashboardWarnings[0]}`
        : `Built dashboard rows for ${weeks.length} weeks`
    });

    reportProgress({
      phaseKey: "publish",
      phaseLabel: "Publish Dashboard",
      status: "running",
      percent: 0,
      message: `Writing ${DASHBOARD_TARGET_TITLE} to Google Sheets`
    });

    const accessToken = await getSheetsAccessToken();
    await writeDashboardToSheet(accessToken, values, metricRows, sectionRows);

    const finishedAt = new Date();
    const summary = {
      spreadsheetId: DASHBOARD_SHEET_ID,
      targetTitle: DASHBOARD_TARGET_TITLE,
      sourceGid: DASHBOARD_SOURCE_GID,
      weekCount: weeks.length,
      publishableWeekCount: publishableWeekStarts.size,
      rowCount: values.length,
      latestWeekStart: availability.publishableThroughWeekStart || null,
      latestWeekEnd: availability.publishableThroughWeekStart
        ? addDaysYmd(availability.publishableThroughWeekStart, 6)
        : null,
      latestSourceWeekStart: weeks[weeks.length - 1]?.start || null,
      latestSourceWeekEnd: weeks[weeks.length - 1]?.end || null,
      skippedWeeks: skippedWeeks.map((week) => ({
        label: week.label,
        start: week.start,
        end: week.end
      })),
      warningSkippedWeeks: warningSkippedWeeks.map((week) => ({
        label: week.label,
        start: week.start,
        end: week.end
      })),
      futureSkippedWeeks: futureSkippedWeeks.map((week) => ({
        label: week.label,
        start: week.start,
        end: week.end
      })),
      warnings: dashboardWarnings,
      availability,
      missingSubscriberWeeks,
      timesheetStatus: timesheetResult.status
    };

    await upsertSyncCursor(connection, "dashboard", {
      cursorValue: availability.publishableThroughWeekStart
        ? addDaysYmd(availability.publishableThroughWeekStart, 6)
        : null,
      syncedThroughAt: finishedAt,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastStatus: "completed",
      lastMessage: dashboardWarnings.length
        ? `Published dashboard with warning: ${dashboardWarnings[0]}`
        : `Published ${values.length} dashboard rows`,
      summaryJson: stringifyJson(summary),
      updatedAt: finishedAt
    });

    reportProgress({
      phaseKey: "publish",
      phaseLabel: "Publish Dashboard",
      status: "completed",
      percent: 100,
      message: dashboardWarnings.length
        ? `Published ${DASHBOARD_TARGET_TITLE} with warnings`
        : `Published ${DASHBOARD_TARGET_TITLE}`
    });
    reportProgress({
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Dashboard publish complete"
    });

    return summary;
  } catch (error) {
    await upsertSyncCursor(connection, "dashboard", {
      lastStartedAt: startedAt,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Dashboard publish failed",
      updatedAt: new Date()
    }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
