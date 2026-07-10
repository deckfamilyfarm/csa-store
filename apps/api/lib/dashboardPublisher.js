import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import mysql from "mysql2/promise";
import path from "path";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { getPool } from "../db.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl } from "../localLineAuth.js";
import { loadDashboardQboPeriodMetrics } from "./qboDashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
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
const DASHBOARD_SNAP_PRICE_LIST_ID = Number(
  getDashboardEnv("DASHBOARD_SNAP_PRICE_LIST_ID") ||
    getDashboardEnv("LL_PRICE_LIST_SNAP_ID")
);
const LOCAL_LINE_RETRY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.LOCALLINE_FETCH_RETRY_ATTEMPTS || "2", 10) || 2
);
const PACK_WAGES_SALES_CHART_TITLE = "Pack Wages % and Retail Sales by Week";
const PACK_WAGES_SALES_CHART_LEGACY_TITLES = ["Pack Wages vs Retail Sales", "Pack Wages by Week"];
const PACK_WAGES_SALES_CHART_HEIGHT_PX = 420;
const PACK_WAGES_SALES_CHART_WIDTH_PX = 900;
const PACK_WAGES_SALES_CHART_MIN_WEEK_START = "2026-02-09";
const DASHBOARD_STATIC_COLUMN_COUNT = 4;
const DASHBOARD_SUMMARY_COLUMN_COUNT = 5;
const DASHBOARD_WEEK_START_COLUMN_INDEX =
  DASHBOARD_STATIC_COLUMN_COUNT + DASHBOARD_SUMMARY_COLUMN_COUNT;
const DASHBOARD_WEEKLY_LEASE_CHARGES = 375;
const DASHBOARD_WEEKLY_UTILITIES = 56;
// TODO: Move fixed dashboard expense assumptions to dated config so weekly changes,
// increases, and historical values can be handled without code edits.
const DASHBOARD_FIXED_EXPENSE_NOTE =
  "Hard-coded weekly value for now. TODO: move to dated config so weekly changes, increases, and historical values can be handled without code edits.";
const DASHBOARD_MANUAL_DELIVERY_EXPENSE_NOTE =
  "MANUAL row: dashboard publishing copies existing weekly values back by row label. TODO: keep this durable if row labels or weekly structure change.";

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

function formatDashboardWeekLabel(ymd) {
  const date = parseYmd(ymd);
  if (!date) return String(ymd || "");
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
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

function getSheetColumnName(zeroBasedIndex) {
  let index = Number(zeroBasedIndex) + 1;
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
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

function isSnapSubscriberSnapshotRow(row = {}) {
  return [
    row["Fulfillment Name"],
    row["Price List"],
    row["Plan"],
    row["Plan Name"],
    row["Subscription"],
    row["Subscription Name"],
    row.Tags
  ]
    .map((value) => String(value || "").toLowerCase())
    .some((value) => value.includes("snap"));
}

function getSnapPriceListId() {
  return Number.isFinite(DASHBOARD_SNAP_PRICE_LIST_ID) && DASHBOARD_SNAP_PRICE_LIST_ID > 0
    ? DASHBOARD_SNAP_PRICE_LIST_ID
    : null;
}

function getPriceListMemberCustomerKey(member = {}) {
  const customer = member.customer || {};
  const customerId = member.customer_id ?? customer.id;
  if (customerId !== null && typeof customerId !== "undefined" && String(customerId).trim()) {
    return `id:${String(customerId).trim()}`;
  }
  const email = String(customer.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const name = [customer.first_name, customer.last_name]
    .map((part) => String(part || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (name) return `name:${name}`;
  const membershipId = member.id;
  return membershipId !== null && typeof membershipId !== "undefined"
    ? `membership:${String(membershipId).trim()}`
    : null;
}

function getDashboardSubscriptionPredicate(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `(
    LOWER(COALESCE(${prefix}category_name, '')) = 'membership'
    OR LOWER(COALESCE(${prefix}fulfillment_name, '')) LIKE '%membership purchase%'
  )`;
}

function getDashboardRetailSalesPredicate(alias = "") {
  return `NOT ${getDashboardSubscriptionPredicate(alias)}`;
}

function getDashboardSubscriptionCreditGivenExpression(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const planName = `LOWER(CONCAT_WS(' ', ${prefix}product_name, ${prefix}package_name))`;
  const quantity = `CASE WHEN COALESCE(${prefix}quantity, 0) > 0 THEN ${prefix}quantity ELSE 1 END`;
  return `(
    ${quantity} *
    CASE
      WHEN ${planName} LIKE '%harvester%' THEN 500
      WHEN ${planName} LIKE '%grazer%' THEN 300
      WHEN ${planName} LIKE '%forager%' THEN 200
      WHEN ${planName} LIKE '%economy%' THEN 120
      ELSE COALESCE(${prefix}retail_amount, 0)
    END
  )`;
}

function setManualValue(manualValueMap, rowLabel, weekStart, value, { overwrite = false } = {}) {
  const label = String(rowLabel || "").trim();
  const weekKey = String(weekStart || "").trim();
  if (!label || !weekKey) return;
  if (value === null || typeof value === "undefined" || String(value).trim() === "") return;
  const rowValues = manualValueMap.get(label) || new Map();
  if (overwrite || !rowValues.has(weekKey)) {
    rowValues.set(weekKey, value);
  }
  manualValueMap.set(label, rowValues);
}

function getManualSourceValue(manualValueMap, rowLabel, weekStart) {
  const labels = Array.isArray(rowLabel) ? rowLabel : [rowLabel];
  for (const label of labels) {
    const rowValues = manualValueMap.get(String(label || "").trim()) || new Map();
    const value = rowValues.get(String(weekStart || "").trim());
    if (value !== null && typeof value !== "undefined" && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function isLikelyExpenseMetricLabel(value) {
  const normalized = normalizeManualMetricLabel(value);
  return /\b(expense|expenses|cost|costs|fee|fees|rent|lease|utility|utilities|insurance|supplies|fuel|delivery|repair|repairs|processing|payroll|wage|wages|tax|taxes)\b/.test(normalized);
}

const EXCLUDED_DASHBOARD_MANUAL_METRIC_LABELS = new Set([
  "cost of products sold",
  "wages & fringe for packout + delivery only",
  "delivery(includes load and clean out) hours",
  "wages as percentage of revenue",
  "target wages as percentage of revenue",
  "delivery miles this week (optimaroute) inc. wholesale",
  "# of orders home delivery"
]);

function isExcludedDashboardManualMetricLabel(value) {
  return EXCLUDED_DASHBOARD_MANUAL_METRIC_LABELS.has(normalizeManualMetricLabel(value));
}

function normalizeManualMetricLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildManualValueMapFromSourceRows(rows = [], weeks = []) {
  const manualValueMap = new Map();
  rows.slice(2).forEach((row) => {
    const label = String(row?.[0] || "").trim();
    if (!label) return;
    weeks.forEach((week, index) => {
      setManualValue(manualValueMap, label, week.start, row[index + 1]);
    });
  });
  return manualValueMap;
}

function buildCustomManualRowsFromSourceRows(rows = []) {
  const customRows = [];
  const seen = new Set();

  rows.slice(2).forEach((row) => {
    const label = String(row?.[0] || "").trim();
    if (!label) return;
    const hasWeekValue = row.slice(1).some((value) => {
      return value !== null && typeof value !== "undefined" && String(value).trim() !== "";
    });
    if (!hasWeekValue) return;

    const normalizedLabel = normalizeManualMetricLabel(label);
    if (!normalizedLabel || seen.has(normalizedLabel)) return;
    if (isExcludedDashboardManualMetricLabel(label)) return;
    if (!isLikelyExpenseMetricLabel(label)) return;
    seen.add(normalizedLabel);

    customRows.push({
      section: "EXPENSES",
      label,
      entry: "MANUAL",
      source: "Manual entry preserved from source dashboard",
      rowLabel: label
    });
  });

  return customRows;
}

function buildCustomManualRowsFromGeneratedRows(rows = []) {
  const headerIndex = rows.findIndex((row) => {
    const metric = String(row?.[1] || "").trim().toLowerCase();
    const source = String(row?.[3] || "").trim().toLowerCase();
    return metric === "metric" && source.includes("source");
  });
  if (headerIndex < 0) return [];

  const header = rows[headerIndex] || [];
  const weekColumnIndexes = [];
  for (let columnIndex = 4; columnIndex < header.length; columnIndex += 1) {
    if (toYmdFromSheetWeekLabel(header[columnIndex])) weekColumnIndexes.push(columnIndex);
  }

  const customRows = [];
  const seen = new Set();
  let currentSection = "";
  rows.slice(headerIndex + 1).forEach((row) => {
    const section = String(row?.[0] || "").trim();
    const label = String(row?.[1] || "").trim();
    const entry = String(row?.[2] || "").trim().toUpperCase();
    const source = String(row?.[3] || "").trim();

    if (section && !label) {
      currentSection = section;
      return;
    }
    if (!label) return;

    const hasWeekValue = weekColumnIndexes.some((columnIndex) => {
      const value = row[columnIndex];
      return value !== null && typeof value !== "undefined" && String(value).trim() !== "";
    });
    if (entry === "AUTO") return;
    if (entry !== "MANUAL" && !hasWeekValue) return;

    const normalizedLabel = normalizeManualMetricLabel(label);
    if (!normalizedLabel || seen.has(normalizedLabel)) return;
    if (isExcludedDashboardManualMetricLabel(label)) return;
    if (normalizeManualMetricLabel(currentSection || "MANUAL ENTRIES") === "manual entries") return;
    seen.add(normalizedLabel);

    customRows.push({
      section: currentSection || "MANUAL ENTRIES",
      label,
      entry: "MANUAL",
      source: source || "Manual entry preserved from dashboard",
      rowLabel: label
    });
  });

  return customRows;
}

function buildManualValueMapFromGeneratedRows(rows = []) {
  const manualValueMap = new Map();
  const headerIndex = rows.findIndex((row) => {
    const metric = String(row?.[1] || "").trim().toLowerCase();
    const source = String(row?.[3] || "").trim().toLowerCase();
    return metric === "metric" && source.includes("source");
  });
  if (headerIndex < 0) return manualValueMap;

  const header = rows[headerIndex] || [];
  const weekColumns = [];
  for (let columnIndex = 4; columnIndex < header.length; columnIndex += 1) {
    const weekStart = toYmdFromSheetWeekLabel(header[columnIndex]);
    if (weekStart) weekColumns.push({ columnIndex, weekStart });
  }

  rows.slice(headerIndex + 1).forEach((row) => {
    const label = String(row?.[1] || "").trim();
    if (!label) return;
    weekColumns.forEach(({ columnIndex, weekStart }) => {
      setManualValue(manualValueMap, label, weekStart, row[columnIndex], { overwrite: true });
    });
  });
  return manualValueMap;
}

function mergeManualValueMaps(...maps) {
  const merged = new Map();
  maps.forEach((manualValueMap, index) => {
    const overwrite = index > 0;
    for (const [label, rowValues] of manualValueMap.entries()) {
      for (const [weekStart, value] of rowValues.entries()) {
        setManualValue(merged, label, weekStart, value, { overwrite });
      }
    }
  });
  return merged;
}

function buildMetricMethodologyNote(row) {
  const notes = [];
  if (row.methodology) {
    notes.push(row.methodology);
  } else if (row.entry === "MANUAL") {
    const labels = Array.isArray(row.rowLabel)
      ? row.rowLabel.join(" / ")
      : row.rowLabel || row.label;
    notes.push(
      `Manual value copied by matching "${labels}" for the same week; dashboard publish checks the generated dashboard tab first, then falls back to the source dashboard tab.`
    );
  } else if (typeof row.formula === "function") {
    notes.push(`Calculated in Google Sheets from dashboard rows: ${row.source}.`);
  } else if (row.entry === "AUTO") {
    notes.push(`Automatically calculated from ${row.source}.`);
  }
  if (row.note) notes.push(row.note);
  return notes.filter(Boolean).join("\n\n") || null;
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

function addCustomManualRowsToLayout(layout, customManualRows = []) {
  if (!customManualRows.length) return layout;

  const builtInLabels = new Set();
  layout.forEach((group) => {
    (group.rows || []).forEach((row) => {
      builtInLabels.add(normalizeManualMetricLabel(row.label));
      const rowLabels = Array.isArray(row.rowLabel) ? row.rowLabel : [row.rowLabel];
      rowLabels.forEach((label) => {
        if (label) builtInLabels.add(normalizeManualMetricLabel(label));
      });
    });
  });

  const additionsBySection = new Map();
  customManualRows.forEach((row) => {
    const normalizedLabel = normalizeManualMetricLabel(row.label);
    if (!normalizedLabel || builtInLabels.has(normalizedLabel)) return;
    const section = String(row.section || "MANUAL ENTRIES").trim() || "MANUAL ENTRIES";
    const rows = additionsBySection.get(section) || [];
    rows.push(row);
    additionsBySection.set(section, rows);
    builtInLabels.add(normalizedLabel);
  });

  if (!additionsBySection.size) return layout;

  const nextLayout = layout.map((group) => {
    const additions = additionsBySection.get(group.section) || [];
    additionsBySection.delete(group.section);
    if (!additions.length) return group;
    const rows = group.rows || [];
    const totalIndex = rows.findIndex((row) => normalizeManualMetricLabel(row.label) === "total expenses");
    if (totalIndex < 0) {
      return { ...group, rows: [...rows, ...additions] };
    }
    return {
      ...group,
      rows: [
        ...rows.slice(0, totalIndex),
        ...additions,
        ...rows.slice(totalIndex)
      ]
    };
  });

  for (const [section, rows] of additionsBySection.entries()) {
    nextLayout.push({ section, rows });
  }

  return nextLayout;
}

function getExpenseTotalMetricLabels(layout = []) {
  const expenseGroup = layout.find((group) => String(group.section || "").trim().toUpperCase() === "EXPENSES");
  if (!expenseGroup) return [];
  return (expenseGroup.rows || [])
    .filter((row) => {
      const normalizedLabel = normalizeManualMetricLabel(row.label);
      if (!normalizedLabel || normalizedLabel === "total expenses") return false;
      if (normalizedLabel.startsWith("%")) return false;
      if (normalizedLabel.startsWith("wages - ")) return false;
      return row.valueType === "currency" || row.entry === "MANUAL";
    })
    .map((row) => row.label);
}

function getPublishableDashboardWeeks(weeks = [], publishableWeekStarts = null) {
  return weeks.filter((week) => {
    if (!week?.start || !week?.end) return false;
    return !publishableWeekStarts || publishableWeekStarts.has(week.start);
  });
}

function getQuarterNumberFromYmd(ymd) {
  const date = parseYmd(ymd);
  if (!date) return null;
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

function makeDashboardSummaryPeriod(year, key, label, periodWeeks, start = null, end = null) {
  const weeks = periodWeeks.filter((week) => week?.start && week?.end);
  return {
    key: `${year}:${key}`,
    label,
    year,
    start,
    end,
    started: Boolean(start && end && weeks.length),
    weekStarts: new Set(weeks.map((week) => week.start))
  };
}

function getDashboardSummaryYearForWeek(week, targetYear) {
  const startYear = Number(String(week?.start || "").slice(0, 4));
  const endYear = Number(String(week?.end || "").slice(0, 4));
  if (startYear < targetYear && endYear === targetYear) return targetYear;
  return startYear;
}

function getDashboardSummaryQuarterForWeek(week, targetYear) {
  const startYear = Number(String(week?.start || "").slice(0, 4));
  const endYear = Number(String(week?.end || "").slice(0, 4));
  if (startYear < targetYear && endYear === targetYear) {
    return getQuarterNumberFromYmd(week.end);
  }
  return getQuarterNumberFromYmd(week.start);
}

function getQuarterStartYmd(year, quarter) {
  return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
}

function getQuarterEndYmd(year, quarter) {
  return [
    `${year}-03-31`,
    `${year}-06-30`,
    `${year}-09-30`,
    `${year}-12-31`
  ][quarter - 1];
}

function buildDashboardSummaryPeriods(weeks = [], publishableWeekStarts = null) {
  const publishableWeeks = getPublishableDashboardWeeks(weeks, publishableWeekStarts);
  const latestPublishableWeek = publishableWeeks[publishableWeeks.length - 1] || null;
  const fallbackYear = Number(
    String(latestPublishableWeek?.end || publishableWeeks[0]?.end || weeks[0]?.end || getTodayYmd()).slice(0, 4)
  );
  const year = Number.isFinite(fallbackYear) ? fallbackYear : new Date().getUTCFullYear();
  const yearWeeks = publishableWeeks.filter(
    (week) => getDashboardSummaryYearForWeek(week, year) === year
  );
  const latestYearWeek = yearWeeks[yearWeeks.length - 1] || null;
  const totalEnd = latestYearWeek?.end || null;
  const periods = [
    makeDashboardSummaryPeriod(
      year,
      "total",
      "Total",
      yearWeeks,
      `${year}-01-01`,
      totalEnd
    )
  ];

  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const quarterStart = getQuarterStartYmd(year, quarter);
    const quarterEnd = getQuarterEndYmd(year, quarter);
    const effectiveQuarterEnd = totalEnd && totalEnd < quarterEnd ? totalEnd : quarterEnd;
    periods.push(
      makeDashboardSummaryPeriod(
        year,
        `q${quarter}`,
        `Q${quarter}`,
        yearWeeks.filter((week) => getDashboardSummaryQuarterForWeek(week, year) === quarter),
        quarterStart,
        effectiveQuarterEnd
      )
    );
  }

  return periods;
}

function isWeekInDashboardSummaryPeriod(week, period) {
  if (!week?.start || !period?.started) return false;
  return period.weekStarts instanceof Set
    ? period.weekStarts.has(week.start)
    : String(week.start) >= String(period.start) && String(week.start) <= String(period.end);
}

function getRowWeeklyRawValue(row, week, index, manualValueMap) {
  if (row.entry === "AUTO") return row.auto ? row.auto(week, index) : null;
  return getManualSourceValue(manualValueMap, row.rowLabel || row.label, week.start);
}

function parseDashboardNumber(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const raw = String(value).trim();
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const numeric = Number(raw.replace(/[(),$]/g, ""));
  return Number.isFinite(numeric) ? (negative ? -numeric : numeric) : null;
}

function getPeriodRowSum(row, weeks, period, manualValueMap) {
  let total = 0;
  let hasValue = false;
  weeks.forEach((week, index) => {
    if (!isWeekInDashboardSummaryPeriod(week, period)) return;
    const numeric = parseDashboardNumber(getRowWeeklyRawValue(row, week, index, manualValueMap));
    if (numeric === null) return;
    total += numeric;
    hasValue = true;
  });
  return hasValue ? total : null;
}

function getPeriodRowLatestValue(row, weeks, period, manualValueMap) {
  for (let index = weeks.length - 1; index >= 0; index -= 1) {
    const week = weeks[index];
    if (!isWeekInDashboardSummaryPeriod(week, period)) continue;
    const value = getRowWeeklyRawValue(row, week, index, manualValueMap);
    if (value !== null && typeof value !== "undefined" && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function buildMetricSheetRowsByLabel(layout = []) {
  const metricSheetRowsByLabel = new Map();
  let nextSheetRowNumber = 3;
  for (const group of layout) {
    nextSheetRowNumber += 1;
    for (const row of group.rows || []) {
      metricSheetRowsByLabel.set(row.label, nextSheetRowNumber);
      nextSheetRowNumber += 1;
    }
  }
  return metricSheetRowsByLabel;
}

function getMetricCellRef(metricSheetRowsByLabel, label, columnName) {
  const rowNumber = metricSheetRowsByLabel.get(label);
  return rowNumber ? `${columnName}${rowNumber}` : null;
}

function getMetricCellRefs(metricSheetRowsByLabel, labels, columnName) {
  return labels
    .map((label) => getMetricCellRef(metricSheetRowsByLabel, label, columnName))
    .filter(Boolean);
}

function buildDashboardRows(
  weeks,
  manualValueMap,
  weeklyKpiMap,
  vendorWeeklyMap,
  timesheetWeeklyMap,
  timesheetTaskLabels,
  subscriberWeeklyMap,
  publishableWeekStarts = null,
  summaryPeriods = [],
  qboPeriodMap = {},
  customManualRows = []
) {
  const yearlyAverageOrdersByYear = buildYearlyAverageMap(weeks, weeklyKpiMap, "numOrders");
  const yearlyAverageSalesByYear = buildYearlyAverageMap(weeks, weeklyKpiMap, "totalSales");
  const getRetailSales = (week) => Number(weeklyKpiMap[week.start]?.totalSales || 0);
  const getCashCollectedOnOrders = (week) => Number(weeklyKpiMap[week.start]?.cashCollectedOnOrders || 0);
  const getPaymentProcessingFees = (week) => Number(weeklyKpiMap[week.start]?.paymentProcessingFees || 0);
  const getNetOrderCash = (week) => getCashCollectedOnOrders(week) - getPaymentProcessingFees(week);
  const getPurchaseCost = (week) => Number(vendorWeeklyMap[week.start]?.purchaseCost || 0);
  const getGrossProfit = (week) => getRetailSales(week) - getPurchaseCost(week);
  const getQboMetric = (period, metricKey) => {
    const metrics = qboPeriodMap?.[period?.key] || null;
    const value = metrics?.[metricKey];
    return value === null || typeof value === "undefined" ? null : Number(value);
  };
  const packWageTaskLabels = [
    "Packout",
    "Delivery",
    "Dairy and Frozen Packing",
    "Pick Ups"
  ];
  const packWageMetricLabels = packWageTaskLabels.map((taskLabel) => "Wages - " + taskLabel);
  const packWageNote = "Attributes used: Wages - Packout; Wages - Delivery; Wages - Dairy and Frozen Packing; Wages - Pick Ups.";
  const wageTaskLabels = [
    ...new Set([
      ...(Array.isArray(timesheetTaskLabels) ? timesheetTaskLabels : []),
      ...packWageTaskLabels
    ])
  ];
  const wageTaskRows = wageTaskLabels.map(
    (taskLabel) => ({
      label: `Wages - ${taskLabel}`,
      entry: "AUTO",
      source: "Timesheets DB (FFCSA wages + fringe)",
      valueType: "currency",
      summary: "sum",
      auto: (w) => Number(timesheetWeeklyMap[w.start]?.tasks?.[taskLabel] || 0)
    })
  );
  const wageMetricLabels = wageTaskLabels.map((taskLabel) => `Wages - ${taskLabel}`);
  const layout = [
    {
      section: "GIVENS",
      rows: [
        { label: "Errors/week", entry: "MANUAL", source: "Manual QA", rowLabel: "Errors/week" },
        { label: "Positive responses/week", entry: "MANUAL", source: "Manual QA", rowLabel: "Positive responses/week" },
        { label: "Num Orders", entry: "AUTO", source: "Local DB", valueType: "int", summary: "sum", auto: (w) => Number(weeklyKpiMap[w.start]?.numOrders) },
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
        { label: "Num Guest Orders", entry: "AUTO", source: "Local DB", valueType: "int", summary: "sum", auto: (w) => Number(weeklyKpiMap[w.start]?.numGuestOrders) },
        {
          label: "Num Subscriber Orders",
          entry: "AUTO",
          source: "Num Orders - Num Guest Orders",
          valueType: "int",
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const numOrdersRef = getMetricCellRef(metricSheetRowsByLabel, "Num Orders", columnName);
            const guestOrdersRef = getMetricCellRef(metricSheetRowsByLabel, "Num Guest Orders", columnName);
            return numOrdersRef && guestOrdersRef
              ? `=IF(${numOrdersRef}="","",MAX(0,${numOrdersRef}-${guestOrdersRef}))`
              : "";
          }
        }
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
          summary: "sum",
          auto: (w) => subscriberWeeklyMap[w.start]?.newSubscribers
        },
        {
          label: "Exiting Subscribers",
          entry: "AUTO",
          source: "Subscriber export Cancelled Date values",
          valueType: "int",
          summary: "sum",
          auto: (w) => subscriberWeeklyMap[w.start]?.exitingSubscribers
        },
        {
          label: "SNAP subscribers",
          entry: "AUTO",
          source: "Local Line SNAP price-list members",
          methodology: "Counts distinct customers currently assigned to the Local Line SNAP price list. The SNAP price list is read from LL_PRICE_LIST_SNAP_ID, or DASHBOARD_SNAP_PRICE_LIST_ID when set, and refreshed during subscriber sync and dashboard publish.",
          valueType: "int",
          summary: "latest",
          auto: (w) => Number(subscriberWeeklyMap[w.start]?.snapSubscribers)
        },
        {
          label: "Total Subscribers",
          entry: "AUTO",
          source: "Subscriber export active as of week end + Local Line SNAP price-list members",
          methodology: "Adds active subscribers from the Local Line subscription snapshot for the week end to the current Local Line SNAP price-list member count.",
          valueType: "int",
          summary: "latest",
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
          label: "Subscription Income",
          entry: "AUTO",
          source: "Paid Membership / membership purchase rows excluded from Retail Sales",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.subscriptionIncome)
        },
        {
          label: "Subscription Credit Given",
          entry: "AUTO",
          source: "Membership plan credit value from paid membership purchase rows",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.subscriptionCreditGiven)
        },
        {
          label: "Store Credit Used",
          entry: "AUTO",
          source: "Local Line order payment_store_credit_amount / payment.store_credit_amount",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.subscriptionCreditUsed)
        },
        {
          label: "Cash Collected on Orders",
          entry: "AUTO",
          source: "Local Line order payment_strategy_amount",
          methodology: "Sums Local Line's non-credit payment amount for paid open orders. For older rows missing payment_strategy_amount, it uses order total only when no store credit was recorded.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => getCashCollectedOnOrders(w)
        },
        {
          label: "Net Order Cash",
          entry: "AUTO",
          source: "Cash collected on orders - payment processing fees",
          valueType: "currency",
          auto: (w) => getNetOrderCash(w),
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const cashCollectedRef = getMetricCellRef(metricSheetRowsByLabel, "Cash Collected on Orders", columnName);
            const feesRef = getMetricCellRef(metricSheetRowsByLabel, "Payment Processing Fees", columnName);
            return cashCollectedRef && feesRef
              ? `=IFERROR(${cashCollectedRef}-${feesRef},"")`
              : "";
          }
        },
        {
          label: "Member Credit Issued",
          entry: "AUTO",
          source: "Membership purchase credit value + member ledger credit entries",
          methodology: "Adds Local Line membership purchase credit value to CSA member-ledger credits that are not already represented as order product sales.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.memberCreditIssued || 0)
        },
        {
          label: "Actual Dollars Received for Credit",
          entry: "AUTO",
          source: "Membership purchase income + member ledger cashReceivedCents metadata",
          methodology: "Reports cash received for member-credit purchases separately from the face value of credits issued.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.actualDollarsReceivedForCredit || 0)
        },
        {
          label: "Member Bank Balance Change",
          entry: "AUTO",
          source: "Difference between Local Line customer credit snapshots",
          methodology: "Calculated only when two Local Line customer export balance snapshots exist; otherwise left blank.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => {
            const value = weeklyKpiMap[w.start]?.memberBankBalanceChange;
            return value === null || typeof value === "undefined" ? null : Number(value);
          },
          formula: ({ columnName, metricSheetRowsByLabel, weekIndex }) => {
            const balanceRow = metricSheetRowsByLabel.get("Member Bank Balance");
            if (!balanceRow || weekIndex <= 0) return "";
            const currentBalanceRef = `${columnName}${balanceRow}`;
            const firstWeekColumnName = getSheetColumnName(DASHBOARD_WEEK_START_COLUMN_INDEX);
            const previousWeekColumnName = getSheetColumnName(DASHBOARD_WEEK_START_COLUMN_INDEX + weekIndex - 1);
            const previousBalancesRange = `${firstWeekColumnName}${balanceRow}:${previousWeekColumnName}${balanceRow}`;
            return `=IFERROR(IF(${currentBalanceRef}="","",${currentBalanceRef}-LOOKUP(2,1/(${previousBalancesRange}<>""),${previousBalancesRange})),"")`;
          }
        },
        {
          label: "Member Bank Balance",
          entry: "AUTO",
          source: "Local Line customers export Store Credit total",
          methodology: "Total store-credit liability from the full Local Line customer export, captured as a weekly snapshot during dashboard publish.",
          valueType: "currency",
          summary: "latest",
          auto: (w) => {
            const value = weeklyKpiMap[w.start]?.memberBankBalance;
            return value === null || typeof value === "undefined" ? null : Number(value);
          }
        },
        {
          label: "Retail Sales",
          entry: "AUTO",
          source: "Local DB",
          valueType: "currency",
          bold: true,
          summary: "sum",
          auto: (w) => getRetailSales(w)
        }
      ]
    },
    {
      section: "COGS",
      rows: [
        {
          label: "Average % product markup",
          entry: "AUTO",
          source: "Local DB reporting cache",
          valueType: "percent",
          auto: (w) => {
            const purchase = getPurchaseCost(w);
            const retail = Number(vendorWeeklyMap[w.start]?.retailSales || 0);
            if (!purchase) return null;
            return ((retail - purchase) / purchase) * 100;
          },
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const retailSalesRef = getMetricCellRef(metricSheetRowsByLabel, "Retail Sales", columnName);
            const purchaseCostRef = getMetricCellRef(metricSheetRowsByLabel, "Purchase Cost", columnName);
            return retailSalesRef && purchaseCostRef
              ? `=IFERROR((${retailSalesRef}-${purchaseCostRef})/${purchaseCostRef},"")`
              : "";
          }
        },
        {
          label: "Purchase Cost",
          entry: "AUTO",
          source: "Local DB reporting cache",
          valueType: "currency",
          bold: true,
          summary: "sum",
          auto: (w) => getPurchaseCost(w)
        }
      ]
    },
    {
      section: "GROSS PROFIT",
      rows: [
        {
          label: "GPPR %",
          entry: "AUTO",
          source: "Gross Profit Total / Retail Sales",
          valueType: "percent",
          auto: (w) => {
            const retailSales = getRetailSales(w);
            if (!retailSales) return null;
            return (getGrossProfit(w) / retailSales) * 100;
          },
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const grossProfitRef = getMetricCellRef(metricSheetRowsByLabel, "Gross Profit Total", columnName);
            const retailSalesRef = getMetricCellRef(metricSheetRowsByLabel, "Retail Sales", columnName);
            return grossProfitRef && retailSalesRef
              ? `=IFERROR(${grossProfitRef}/${retailSalesRef},"")`
              : "";
          }
        },
        {
          label: "Gross Profit Total",
          entry: "AUTO",
          source: "Retail Sales - Purchase Cost",
          valueType: "currency",
          bold: true,
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const retailSalesRow = metricSheetRowsByLabel.get("Retail Sales");
            const purchaseCostRow = metricSheetRowsByLabel.get("Purchase Cost");
            return retailSalesRow && purchaseCostRow
              ? `=${columnName}${retailSalesRow}-${columnName}${purchaseCostRow}`
              : "";
          }
        }
      ]
    },
    {
      section: "EXPENSES",
      rows: [
        ...wageTaskRows,
        {
          label: "Total Wages",
          entry: "AUTO",
          source: "Timesheets DB (FFCSA wages + fringe total)",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(timesheetWeeklyMap[w.start]?.totalWages || 0),
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const refs = getMetricCellRefs(metricSheetRowsByLabel, wageMetricLabels, columnName);
            return refs.length ? `=SUM(${refs.join(",")})` : "";
          }
        },
        {
          label: "% Wages to Retail Sales",
          entry: "AUTO",
          source: "Timesheets total wages / dashboard retail sales",
          valueType: "percent",
          auto: (w) => {
            const wages = Number(timesheetWeeklyMap[w.start]?.totalWages || 0);
            const retailSales = getRetailSales(w);
            if (!retailSales) return null;
            return (wages / retailSales) * 100;
          },
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const wagesRef = getMetricCellRef(metricSheetRowsByLabel, "Total Wages", columnName);
            const retailSalesRef = getMetricCellRef(metricSheetRowsByLabel, "Retail Sales", columnName);
            return wagesRef && retailSalesRef
              ? `=IFERROR(${wagesRef}/${retailSalesRef},"")`
              : "";
          }
        },
        {
          label: "% Pack Wages to Retail Sales",
          entry: "AUTO",
          source: "Selected Timesheets task wages / dashboard retail sales",
          valueType: "percent",
          note: packWageNote,
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const retailSalesRow = metricSheetRowsByLabel.get("Retail Sales");
            const refs = packWageMetricLabels
              .map((label) => metricSheetRowsByLabel.get(label))
              .filter(Boolean)
              .map((rowNumber) => columnName + rowNumber);
            return refs.length && retailSalesRow
              ? `=IFERROR(SUM(${refs.join(",")})/${columnName}${retailSalesRow},"")`
              : "";
          }
        },
        {
          label: "Payment Processing Fees",
          entry: "AUTO",
          source: "Local Line order payment_fees + payment_tax",
          methodology: "Uses Local Line payment_fees and payment_tax from paid open orders. If Local Line reports zero or omits these fields, this row stays zero instead of estimating processor fees.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => getPaymentProcessingFees(w)
        },
        {
          label: "Bonus Credit Expense",
          entry: "AUTO",
          source: "Member credit issued - actual dollars received",
          methodology: "Shows the bonus/manual credit portion, such as employee double-credit rules, separately from cash received.",
          valueType: "currency",
          summary: "sum",
          auto: (w) => Number(weeklyKpiMap[w.start]?.bonusCreditExpense || 0),
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const creditIssuedRef = getMetricCellRef(metricSheetRowsByLabel, "Member Credit Issued", columnName);
            const cashReceivedRef = getMetricCellRef(metricSheetRowsByLabel, "Actual Dollars Received for Credit", columnName);
            return creditIssuedRef && cashReceivedRef
              ? `=MAX(0,${creditIssuedRef}-${cashReceivedRef})`
              : "";
          }
        },
        {
          label: "Utilities",
          entry: "AUTO",
          source: "Fixed weekly dashboard assumption",
          valueType: "currency",
          note: DASHBOARD_FIXED_EXPENSE_NOTE,
          summary: "sum",
          auto: () => DASHBOARD_WEEKLY_UTILITIES
        },
        {
          label: "$ Products Given",
          entry: "MANUAL",
          source: "Manual / TODO automation",
          summary: "sum",
          rowLabel: ["$ Products Given", "$ Product Credits Given"]
        },
        {
          label: "Delivery Cost",
          entry: "MANUAL",
          source: "Manual (copied from existing dashboard values by row label)",
          note: DASHBOARD_MANUAL_DELIVERY_EXPENSE_NOTE,
          summary: "sum",
          rowLabel: ["Delivery Cost", "Delivery Expenses"]
        },
        {
          label: "Building Depreciation & Lease",
          entry: "MANUAL",
          source: "Manual",
          summary: "sum",
          rowLabel: [
            "Building Depreciation & Lease",
            "Building Depreciation and Lease",
            "Lease Charges"
          ]
        },
        {
          label: "Other FFCSA operating costs",
          entry: "MANUAL",
          source: "Manual",
          summary: "sum",
          rowLabel: ["Other FFCSA operating costs", "Other FFCSA operating costs Ops"]
        },
        {
          label: "Total Expenses",
          entry: "AUTO",
          source: "SUM(all EXPENSES currency/manual rows, excluding percentage rows)",
          valueType: "currency",
          bold: true,
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const refs = totalExpenseMetricLabels
              .map((label) => metricSheetRowsByLabel.get(label))
              .filter(Boolean)
              .map((rowNumber) => `${columnName}${rowNumber}`);
            return refs.length ? `=SUM(${refs.join(",")})` : "";
          }
        }
      ]
    },
    {
      section: "NET PROFIT",
      rows: [
        {
          label: "Net Profit",
          entry: "AUTO",
          source: "Retail Sales - Purchase Cost - Total Expenses",
          valueType: "currency",
          bold: true,
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const retailSalesRow = metricSheetRowsByLabel.get("Retail Sales");
            const purchaseCostRow = metricSheetRowsByLabel.get("Purchase Cost");
            const totalExpensesRow = metricSheetRowsByLabel.get("Total Expenses");
            return retailSalesRow && purchaseCostRow && totalExpensesRow
              ? `=${columnName}${retailSalesRow}-${columnName}${purchaseCostRow}-${columnName}${totalExpensesRow}`
              : "";
          }
        },
        {
          label: "Net Profit % of Revenue",
          entry: "AUTO",
          source: "Net Profit / Retail Sales",
          valueType: "percent",
          formula: ({ columnName, metricSheetRowsByLabel }) => {
            const netProfitRow = metricSheetRowsByLabel.get("Net Profit");
            const retailSalesRow = metricSheetRowsByLabel.get("Retail Sales");
            return netProfitRow && retailSalesRow
              ? `=IFERROR(${columnName}${netProfitRow}/${columnName}${retailSalesRow},"")`
              : "";
          }
        }
      ]
    },
    {
      section: "ACCOUNTING / QBO RECONCILIATION",
      rows: [
        {
          label: "QBO Total Income",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          methodology: "Fetched from the FFCSA QBO Profit and Loss report for the same date spans represented by the dashboard summary columns. Live values are cached locally and reused when QBO is temporarily unavailable.",
          valueType: "currency",
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "income")
        },
        {
          label: "QBO Cost of Goods Sold",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          valueType: "currency",
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "cogs")
        },
        {
          label: "QBO Gross Profit",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "grossProfit")
        },
        {
          label: "QBO Total Expenses",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          valueType: "currency",
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "expenses")
        },
        {
          label: "QBO Net Income",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "netIncome")
        },
        {
          label: "QBO Expense Adjustment / Unmapped Expenses",
          entry: "AUTO",
          source: "QBO Total Expenses - Dashboard Total Expenses",
          methodology: "Shows the expense gap that is in QBO but not represented by dashboard expense rows. Use this as an adjustment row until those expenses are mapped to explicit dashboard lines.",
          valueType: "currency",
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const qboExpensesRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Total Expenses", columnName);
            const dashboardExpensesRef = getMetricCellRef(metricSheetRowsByLabel, "Total Expenses", columnName);
            return qboExpensesRef && dashboardExpensesRef
              ? `=IF(OR(${qboExpensesRef}="",${dashboardExpensesRef}=""),"",${qboExpensesRef}-${dashboardExpensesRef})`
              : "";
          }
        },
        {
          label: "Dashboard Adjusted Net Profit",
          entry: "AUTO",
          source: "Dashboard Net Profit - QBO Expense Adjustment",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const dashboardNetProfitRef = getMetricCellRef(metricSheetRowsByLabel, "Net Profit", columnName);
            const adjustmentRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "QBO Expense Adjustment / Unmapped Expenses",
              columnName
            );
            return dashboardNetProfitRef && adjustmentRef
              ? `=IF(OR(${dashboardNetProfitRef}="",${adjustmentRef}=""),"",${dashboardNetProfitRef}-${adjustmentRef})`
              : "";
          }
        },
        {
          label: "Dashboard vs QBO Net Income Difference",
          entry: "AUTO",
          source: "Dashboard Adjusted Net Profit - QBO Net Income",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const adjustedDashboardRef = getMetricCellRef(metricSheetRowsByLabel, "Dashboard Adjusted Net Profit", columnName);
            const qboNetIncomeRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Net Income", columnName);
            return adjustedDashboardRef && qboNetIncomeRef
              ? `=IF(OR(${adjustedDashboardRef}="",${qboNetIncomeRef}=""),"",${adjustedDashboardRef}-${qboNetIncomeRef})`
              : "";
          }
        }
      ]
    },
    {
      section: "STORE CREDIT ACCOUNTING",
      rows: [
        {
          label: "QBO Member Payments",
          entry: "AUTO",
          source: "QuickBooks Online Member Payments account",
          methodology: "Extracts the Member Payments account line from the same QBO P&L date spans used by the QBO reconciliation rows.",
          valueType: "currency",
          summaryOnly: true,
          periodAuto: (period) => getQboMetric(period, "memberPayments")
        },
        {
          label: "Credit Cash Received (Dashboard)",
          entry: "AUTO",
          source: "Actual Dollars Received for Credit",
          valueType: "currency",
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const cashReceivedRef = getMetricCellRef(metricSheetRowsByLabel, "Actual Dollars Received for Credit", columnName);
            return cashReceivedRef ? `=IF(${cashReceivedRef}="","",${cashReceivedRef})` : "";
          }
        },
        {
          label: "Member Credit Issued (Dashboard)",
          entry: "AUTO",
          source: "Member Credit Issued",
          valueType: "currency",
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const creditIssuedRef = getMetricCellRef(metricSheetRowsByLabel, "Member Credit Issued", columnName);
            return creditIssuedRef ? `=IF(${creditIssuedRef}="","",${creditIssuedRef})` : "";
          }
        },
        {
          label: "Store Credit Used (Dashboard)",
          entry: "AUTO",
          source: "Store Credit Used",
          valueType: "currency",
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const creditUsedRef = getMetricCellRef(metricSheetRowsByLabel, "Store Credit Used", columnName);
            return creditUsedRef ? `=IF(${creditUsedRef}="","",${creditUsedRef})` : "";
          }
        },
        {
          label: "Store Credit Net Growth",
          entry: "AUTO",
          source: "Member Credit Issued - Store Credit Used",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const creditIssuedRef = getMetricCellRef(metricSheetRowsByLabel, "Member Credit Issued (Dashboard)", columnName);
            const creditUsedRef = getMetricCellRef(metricSheetRowsByLabel, "Store Credit Used (Dashboard)", columnName);
            return creditIssuedRef && creditUsedRef
              ? `=IF(OR(${creditIssuedRef}="",${creditUsedRef}=""),"",${creditIssuedRef}-${creditUsedRef})`
              : "";
          }
        },
        {
          label: "Member Bank Balance Change (Dashboard)",
          entry: "AUTO",
          source: "Member Bank Balance Change",
          valueType: "currency",
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const balanceChangeRef = getMetricCellRef(metricSheetRowsByLabel, "Member Bank Balance Change", columnName);
            return balanceChangeRef ? `=IF(${balanceChangeRef}="","",${balanceChangeRef})` : "";
          }
        },
        {
          label: "Member Payments vs Credit Cash Difference",
          entry: "AUTO",
          source: "QBO Member Payments - Dashboard credit cash received",
          valueType: "currency",
          bold: true,
          summaryOnly: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const qboMemberPaymentsRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Member Payments", columnName);
            const dashboardCashRef = getMetricCellRef(metricSheetRowsByLabel, "Credit Cash Received (Dashboard)", columnName);
            return qboMemberPaymentsRef && dashboardCashRef
              ? `=IF(OR(${qboMemberPaymentsRef}="",${dashboardCashRef}=""),"",${qboMemberPaymentsRef}-${dashboardCashRef})`
              : "";
          }
        }
      ]
    }
  ];

  const resolvedLayout = addCustomManualRowsToLayout(layout, customManualRows);
  const totalExpenseMetricLabels = getExpenseTotalMetricLabels(resolvedLayout);
  const values = [];
  const metricRows = [];
  const sectionRows = [];
  const metricSheetRowsByLabel = buildMetricSheetRowsByLabel(resolvedLayout);
  const resolvedSummaryPeriods = summaryPeriods.length
    ? summaryPeriods
    : buildDashboardSummaryPeriods(weeks, publishableWeekStarts);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  values.push([
    `FFCSA Dashboard 2026`,
    `Updated ${now}`,
    "",
    "",
    ...resolvedSummaryPeriods.map(() => ""),
    ...weeks.map(() => "")
  ]);
  values.push([
    "Section",
    "Metric",
    "Entry Type",
    "Source",
    ...resolvedSummaryPeriods.map((period) => period.label),
    ...weeks.map((w) => w.label)
  ]);

  const getPeriodRowValue = (row, period, periodIndex) => {
    if (!period?.started) return "";
    const columnName = getSheetColumnName(DASHBOARD_STATIC_COLUMN_COUNT + periodIndex);
    if (typeof row.periodFormula === "function") {
      return row.periodFormula({
        period,
        periodIndex,
        columnName,
        metricSheetRowsByLabel
      });
    }
    if (typeof row.periodAuto === "function") {
      return normalizeAutoValue(row.valueType, row.periodAuto(period, periodIndex));
    }
    if (row.summary === "sum" || (row.entry === "MANUAL" && row.summary !== "blank")) {
      return normalizeAutoValue(
        row.valueType,
        getPeriodRowSum(row, weeks, period, manualValueMap)
      );
    }
    if (row.summary === "latest") {
      return normalizeAutoValue(
        row.valueType,
        getPeriodRowLatestValue(row, weeks, period, manualValueMap)
      );
    }
    if (typeof row.formula === "function" && row.summary !== "blank") {
      return row.formula({
        period,
        periodIndex,
        columnName,
        metricSheetRowsByLabel
      });
    }
    return "";
  };

  for (const group of resolvedLayout) {
    sectionRows.push(values.length);
    values.push([
      group.section,
      "",
      "",
      "",
      ...resolvedSummaryPeriods.map(() => ""),
      ...weeks.map(() => "")
    ]);
    for (const row of group.rows) {
      const sheetRowNumber = values.length + 1;
      const nextRow = ["", row.label, row.entry, row.source];
      for (let index = 0; index < resolvedSummaryPeriods.length; index += 1) {
        nextRow.push(getPeriodRowValue(row, resolvedSummaryPeriods[index], index));
      }
      for (let index = 0; index < weeks.length; index += 1) {
        const week = weeks[index];
        const weekIsPublishable =
          !publishableWeekStarts || publishableWeekStarts.has(week.start);
        if (row.summaryOnly || (!weekIsPublishable && row.entry !== "MANUAL")) {
          nextRow.push("");
          continue;
        }
        if (typeof row.formula === "function") {
          nextRow.push(row.formula({
            week,
            weekIndex: index,
            columnName: getSheetColumnName(DASHBOARD_WEEK_START_COLUMN_INDEX + index),
            metricSheetRowsByLabel
          }));
        } else if (row.entry === "AUTO") {
          nextRow.push(normalizeAutoValue(row.valueType, row.auto ? row.auto(week, index) : null));
        } else {
          nextRow.push(getManualSourceValue(manualValueMap, row.rowLabel || row.label, week.start));
        }
      }
      metricRows.push({
        rowIndex: values.length,
        valueType: row.valueType || null,
        entry: row.entry,
        bold: Boolean(row.bold),
        note: buildMetricMethodologyNote(row)
      });
      values.push(nextRow);
    }
  }

  let packWagesSalesChart = null;
  const retailSalesRowNumber = metricSheetRowsByLabel.get("Retail Sales");
  const packWagesRowNumber = metricSheetRowsByLabel.get("% Pack Wages to Retail Sales");
  const weekStartColumnIndex = DASHBOARD_WEEK_START_COLUMN_INDEX;
  const chartWeekOffset = weeks.findIndex((week) => week.start >= PACK_WAGES_SALES_CHART_MIN_WEEK_START);
  const chartStartColumnIndex = chartWeekOffset >= 0
    ? weekStartColumnIndex + chartWeekOffset
    : values[0]?.length || weekStartColumnIndex;
  const weekEndColumnIndex = values[0]?.length || weekStartColumnIndex;

  if (retailSalesRowNumber && packWagesRowNumber && weekEndColumnIndex > chartStartColumnIndex) {
    const blankRow = ["", "", "", "", ...resolvedSummaryPeriods.map(() => ""), ...weeks.map(() => "")];
    values.push(blankRow);

    packWagesSalesChart = {
      title: PACK_WAGES_SALES_CHART_TITLE,
      weekLabelRowIndex: 1,
      retailSalesRowIndex: retailSalesRowNumber - 1,
      packWagesRowIndex: packWagesRowNumber - 1,
      startColumnIndex: chartStartColumnIndex,
      endColumnIndex: weekEndColumnIndex,
      anchorRowIndex: values.length + 1,
      anchorColumnIndex: 0
    };
  }

  return { values, metricRows, sectionRows, packWagesSalesChart };
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

function buildLocalLineApiUrl(pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(value)) return value;
  return `${getLocalLineBaseUrl()}${value.replace(/^\/+/, "")}`;
}

async function downloadLocalLineJson(pathOrUrl, accessToken, label = "Local Line JSON download") {
  const response = await fetchWithRetry(
    buildLocalLineApiUrl(pathOrUrl),
    { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined },
    label
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function fetchAllLocalLineResults(pathOrUrl, accessToken, label) {
  const results = [];
  let nextUrl = pathOrUrl;
  while (nextUrl) {
    const payload = await downloadLocalLineJson(nextUrl, accessToken, label);
    if (Array.isArray(payload)) {
      results.push(...payload);
      break;
    }
    if (Array.isArray(payload?.results)) {
      results.push(...payload.results);
      nextUrl = payload.next || null;
    } else {
      results.push(payload);
      break;
    }
  }
  return results;
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
  let snapSubscribers = 0;
  let projectedMonthlyRevenue = 0;
  let skippedSubscribers = 0;
  let feedAFriendSubscribers = 0;

  rows.forEach((row) => {
    if (String(row.Status || "").trim().toLowerCase() !== "active") return;
    activeSubscribers += 1;
    if (isSnapSubscriberSnapshotRow(row)) {
      snapSubscribers += 1;
    }
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
    snapSubscribers,
    projectedMonthlyRevenue: Number(projectedMonthlyRevenue.toFixed(2)),
    skippedSubscribers,
    feedAFriendSubscribers
  };
}

function getCustomerStoreCreditAmount(row = {}) {
  return parseCurrencyCell(
    row["Store Credit"] ??
      row["Store credit"] ??
      row["Store credit balance"] ??
      row.store_credit ??
      row.store_credit_balance ??
      0
  );
}

async function fetchLocalLineCustomerCreditSummary() {
  const accessToken = await getLocalLineAccessToken();
  const buffer = await downloadBinaryFile(
    `${getLocalLineBaseUrl()}customers/export/?direct=true`,
    accessToken
  );
  const rows = parseRowsFromBuffer(buffer);
  let totalBalance = 0;
  let nonzeroBalanceCustomerCount = 0;

  rows.forEach((row) => {
    const balance = getCustomerStoreCreditAmount(row);
    totalBalance += balance;
    if (Math.abs(balance) > 0.000001) {
      nonzeroBalanceCustomerCount += 1;
    }
  });

  return {
    customerCount: rows.length,
    nonzeroBalanceCustomerCount,
    totalBalance: round2(totalBalance)
  };
}

async function captureLocalLineCustomerCreditSnapshot(connection, week) {
  if (!week?.start || !week?.end) return null;
  const summary = await fetchLocalLineCustomerCreditSummary();
  const now = new Date();
  await connection.query(
    `
      INSERT INTO local_line_customer_credit_snapshots (
        snapshot_week_start,
        snapshot_week_end,
        customer_count,
        nonzero_balance_customer_count,
        total_balance,
        captured_at,
        summary_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        snapshot_week_end = VALUES(snapshot_week_end),
        customer_count = VALUES(customer_count),
        nonzero_balance_customer_count = VALUES(nonzero_balance_customer_count),
        total_balance = VALUES(total_balance),
        captured_at = VALUES(captured_at),
        summary_json = VALUES(summary_json),
        updated_at = VALUES(updated_at)
    `,
    [
      week.start,
      week.end,
      summary.customerCount,
      summary.nonzeroBalanceCustomerCount,
      summary.totalBalance,
      now,
      stringifyJson({
        source: "localline_live_customer_export",
        capturedAt: now.toISOString(),
        ...summary
      }),
      now,
      now
    ]
  );

  return {
    weekStart: week.start,
    weekEnd: week.end,
    ...summary
  };
}

async function loadCustomerCreditSnapshotForWeek(connection, weekStart) {
  if (!weekStart) return null;
  const [rows] = await connection.query(
    `
      SELECT
        snapshot_week_start AS weekStart,
        snapshot_week_end AS weekEnd,
        customer_count AS customerCount,
        nonzero_balance_customer_count AS nonzeroBalanceCustomerCount,
        total_balance AS totalBalance,
        captured_at AS capturedAt,
        summary_json AS summaryJson
      FROM local_line_customer_credit_snapshots
      WHERE snapshot_week_start = ?
      LIMIT 1
    `,
    [weekStart]
  );
  const row = rows?.[0] || null;
  if (!row) return null;
  return {
    ...row,
    summary: parseSnapshotRawJson(row.summaryJson)
  };
}

function isBackfilledCustomerCreditSnapshot(snapshot) {
  return snapshot?.summary?.source === "legacy_customer_export_backfill";
}

async function loadCurrentSnapPriceListMemberSummary() {
  const snapPriceListId = getSnapPriceListId();
  if (!snapPriceListId) {
    throw new Error("LL_PRICE_LIST_SNAP_ID or DASHBOARD_SNAP_PRICE_LIST_ID must be set to count SNAP subscribers.");
  }

  const accessToken = await getLocalLineAccessToken();
  const members = await fetchAllLocalLineResults(
    `price-lists/${snapPriceListId}/members/?page_size=250`,
    accessToken,
    "Local Line SNAP price-list members"
  );
  const customerKeys = new Set();
  members.forEach((member) => {
    const key = getPriceListMemberCustomerKey(member);
    if (key) customerKeys.add(key);
  });

  return {
    snapPriceListId,
    snapSubscriberCount: customerKeys.size
  };
}

async function updateSnapshotRunSnapSubscriberCount(connection, snapshotWeekEnd, snapSubscriberCount) {
  await connection.query(
    `
      UPDATE local_line_subscription_snapshot_runs
      SET snap_subscriber_count = ?,
          updated_at = ?
      WHERE snapshot_week_end = ?
    `,
    [snapSubscriberCount, new Date(), snapshotWeekEnd]
  );
}

async function refreshLatestSnapshotSnapSubscriberCount(connection) {
  const [rows] = await connection.query(
    `
      SELECT MAX(snapshot_week_end) AS snapshotWeekEnd
      FROM local_line_subscription_snapshot_runs
    `
  );
  const snapshotWeekEnd = rows?.[0]?.snapshotWeekEnd ? String(rows[0].snapshotWeekEnd) : null;
  if (!snapshotWeekEnd) return null;

  const snapSummary = await loadCurrentSnapPriceListMemberSummary();
  await updateSnapshotRunSnapSubscriberCount(
    connection,
    snapshotWeekEnd,
    snapSummary.snapSubscriberCount
  );

  return {
    snapshotWeekEnd,
    ...snapSummary
  };
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

async function fetchSheetRowsByTitle(accessToken, title) {
  const metadata = await sheetsRequest(
    accessToken,
    "GET",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}?fields=sheets(properties(title))`
  );
  const exists = (metadata.sheets || []).some((sheet) => sheet?.properties?.title === title);
  if (!exists) return [];

  const payload = await sheetsRequest(
    accessToken,
    "GET",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${title}!A:ZZ`)}?valueRenderOption=FORMULA`
  );
  return Array.isArray(payload?.values) ? payload.values : [];
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

function extractWeeksFromGeneratedRows(rows = []) {
  const headerIndex = rows.findIndex((row) => {
    const metric = String(row?.[1] || "").trim().toLowerCase();
    const source = String(row?.[3] || "").trim().toLowerCase();
    return metric === "metric" && source.includes("source");
  });
  if (headerIndex < 0) return [];

  const header = rows[headerIndex] || [];
  const weeks = [];
  for (let index = 4; index < header.length; index += 1) {
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

function mergeDashboardWeeks(...weekLists) {
  const byStart = new Map();
  weekLists.forEach((weekList) => {
    (Array.isArray(weekList) ? weekList : []).forEach((week) => {
      const start = String(week?.start || "").trim();
      if (!start) return;
      const existing = byStart.get(start);
      byStart.set(start, existing ? { ...week, ...existing } : week);
    });
  });
  return Array.from(byStart.values()).sort((left, right) =>
    String(left.start || "").localeCompare(String(right.start || ""))
  );
}

function extendWeeksThroughPublishableWeek(weeks, publishableThroughWeekStart) {
  const sourceWeeks = Array.isArray(weeks) ? weeks : [];
  if (!sourceWeeks.length || !publishableThroughWeekStart) {
    return { weeks: sourceWeeks, addedWeeks: [] };
  }

  const knownStarts = new Set(sourceWeeks.map((week) => week.start).filter(Boolean));
  const lastSourceWeekStart = sourceWeeks[sourceWeeks.length - 1]?.start;
  let nextWeekStart = addDaysYmd(lastSourceWeekStart, 7);
  const addedWeeks = [];

  while (
    nextWeekStart &&
    String(nextWeekStart) <= String(publishableThroughWeekStart)
  ) {
    if (!knownStarts.has(nextWeekStart)) {
      const addedWeek = {
        label: formatDashboardWeekLabel(nextWeekStart),
        start: nextWeekStart,
        end: addDaysYmd(nextWeekStart, 6),
        generated: true
      };
      addedWeeks.push(addedWeek);
      knownStarts.add(nextWeekStart);
    }
    nextWeekStart = addDaysYmd(nextWeekStart, 7);
  }

  return { weeks: [...sourceWeeks, ...addedWeeks], addedWeeks };
}

function buildInClause(values = []) {
  return values.map(() => "?").join(", ");
}

async function loadWeeklyOrderMetrics(weeks) {
  const pool = getPool();
  const weekKeys = weeks.map((week) => week.start).filter(Boolean);
  if (!weekKeys.length) return {};

  const retailSalesPredicate = getDashboardRetailSalesPredicate();
  const subscriptionPredicate = getDashboardSubscriptionPredicate();
  const subscriptionCreditGivenExpression = getDashboardSubscriptionCreditGivenExpression();
  const weekSql = buildInClause(weekKeys);
  const storeCreditAmountExpression = `
    COALESCE(
      payment_store_credit_amount,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.payment.store_credit_amount')) AS DECIMAL(10, 2)),
      0
    )
  `;
  const paymentStrategyAmountExpression = `
    COALESCE(
      payment_strategy_amount,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.payment.payment_strategy_amount')) AS DECIMAL(10, 2))
    )
  `;
  const cashCollectedExpression = `
    CASE
      WHEN COALESCE(${paymentStrategyAmountExpression}, 0) > 0
        THEN COALESCE(${paymentStrategyAmountExpression}, 0)
      WHEN COALESCE(${storeCreditAmountExpression}, 0) <= 0
        THEN COALESCE(total, 0)
      ELSE 0
    END
  `;
  const paymentFeeExpression = `
    (
      COALESCE(
        payment_fees,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.payment_fees')) AS DECIMAL(10, 2)),
        0
      )
      +
      COALESCE(
        payment_tax,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.payment_tax')) AS DECIMAL(10, 2)),
        0
      )
    )
  `;

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
          AND ${retailSalesPredicate}
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
        AND ${retailSalesPredicate}
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
        AND ${getDashboardRetailSalesPredicate("reporting_entries")}
        AND reporting_entries.week_start IN (${weekSql})
    `,
    weekKeys
  );
  const [subscriptionRows] = await pool.query(
    `
      SELECT
        week_start AS weekKey,
        COALESCE(SUM(retail_amount), 0) AS subscriptionIncome,
        COALESCE(SUM(${subscriptionCreditGivenExpression}), 0) AS subscriptionCreditGiven
      FROM local_line_order_reporting_entries
      WHERE order_status = 'OPEN'
        AND payment_status = 'PAID'
        AND ${subscriptionPredicate}
        AND week_start IN (${weekSql})
      GROUP BY week_start
    `,
    weekKeys
  );
  const [orderFinanceRows] = await pool.query(
    `
      SELECT
        order_finance.weekKey,
        COALESCE(SUM(order_finance.storeCreditAmount), 0) AS subscriptionCreditUsed,
        COALESCE(SUM(order_finance.cashCollectedAmount), 0) AS cashCollectedOnOrders,
        COALESCE(SUM(order_finance.paymentFeesAmount), 0) AS paymentProcessingFees,
        COUNT(*) AS financeOrderCount,
        COALESCE(SUM(order_finance.hasPaymentFeeData), 0) AS ordersWithPaymentFeeData
      FROM (
        SELECT
          DATE_FORMAT(
            DATE_SUB(
              DATE(COALESCE(fulfillment_date, created_at_remote)),
              INTERVAL WEEKDAY(DATE(COALESCE(fulfillment_date, created_at_remote))) DAY
            ),
            '%Y-%m-%d'
          ) AS weekKey,
          ${storeCreditAmountExpression} AS storeCreditAmount,
          ${cashCollectedExpression} AS cashCollectedAmount,
          ${paymentFeeExpression} AS paymentFeesAmount,
          CASE
            WHEN payment_fees IS NOT NULL
              OR payment_tax IS NOT NULL
              OR JSON_EXTRACT(raw_json, '$.payment_fees') IS NOT NULL
              OR JSON_EXTRACT(raw_json, '$.payment_tax') IS NOT NULL
            THEN 1
            ELSE 0
          END AS hasPaymentFeeData
        FROM local_line_orders
        WHERE status = 'OPEN'
          AND payment_status = 'PAID'
          AND COALESCE(fulfillment_date, created_at_remote) IS NOT NULL
      ) order_finance
      WHERE order_finance.weekKey IN (${weekSql})
      GROUP BY order_finance.weekKey
    `,
    weekKeys
  );
  const ledgerFinanceMap = await loadMemberLedgerFinanceMap(weeks);

  const orderMap = new Map(orderRows.map((row) => [String(row.weekKey), row]));
  const reportingMap = new Map(reportingRows.map((row) => [String(row.weekKey), row]));
  const subscriptionMap = new Map(subscriptionRows.map((row) => [String(row.weekKey), row]));
  const orderFinanceMap = new Map(orderFinanceRows.map((row) => [String(row.weekKey), row]));
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
    const subscriptionRow = subscriptionMap.get(weekKey);
    const orderFinanceRow = orderFinanceMap.get(weekKey);
    const ledgerFinance = ledgerFinanceMap[weekKey] || {};
    const averageOrderSummary = averageOrderAmountMap.get(weekKey);
    const numOrders = Number(orderRow?.orderCount || 0);
    const numGuestOrders = Number(orderRow?.guestOrderCount || 0);
    const lineCount = Number(reportingRow?.lineCount || 0);
    const subscriptionIncome = Number(Number(subscriptionRow?.subscriptionIncome || 0).toFixed(2));
    const subscriptionCreditGiven = Number(
      Number(subscriptionRow?.subscriptionCreditGiven || 0).toFixed(2)
    );
    const ledgerCreditIssued = Number(ledgerFinance.ledgerCreditIssued || 0);
    const ledgerCashReceived = Number(ledgerFinance.ledgerCashReceived || 0);
    const ledgerBonusCredit = Number(ledgerFinance.ledgerBonusCredit || 0);
    const cashCollectedOnOrders = Number(
      Number(orderFinanceRow?.cashCollectedOnOrders || 0).toFixed(2)
    );
    const paymentProcessingFees = Number(
      Number(orderFinanceRow?.paymentProcessingFees || 0).toFixed(2)
    );
    const memberBankBalanceChange = ledgerFinance.memberBankBalanceChange;
    const memberBankBalance = ledgerFinance.memberBankBalance;
    result[weekKey] = {
      numOrders,
      numGuestOrders,
      numSubscriberOrders: Math.max(0, numOrders - numGuestOrders),
      averageItemsPerOrder: numOrders ? Math.round(lineCount / numOrders) : 0,
      averageOrderAmount:
        averageOrderSummary?.count
          ? Number((averageOrderSummary.total / averageOrderSummary.count).toFixed(2))
          : Number(Number(orderRow?.averageOrderAmount || 0).toFixed(2)),
      subscriptionIncome,
      subscriptionCreditGiven,
      subscriptionCreditUsed: Number(
        Number(orderFinanceRow?.subscriptionCreditUsed || 0).toFixed(2)
      ),
      cashCollectedOnOrders,
      paymentProcessingFees,
      netOrderCash: Number(Number(cashCollectedOnOrders - paymentProcessingFees).toFixed(2)),
      memberCreditIssued: Number(
        Number(subscriptionCreditGiven + ledgerCreditIssued).toFixed(2)
      ),
      actualDollarsReceivedForCredit: Number(
        Number(subscriptionIncome + ledgerCashReceived).toFixed(2)
      ),
      bonusCreditExpense: Number(
        Number(Math.max(0, subscriptionCreditGiven - subscriptionIncome) + ledgerBonusCredit).toFixed(2)
      ),
      memberBankBalanceChange:
        memberBankBalanceChange === null || typeof memberBankBalanceChange === "undefined"
          ? null
          : Number(Number(memberBankBalanceChange).toFixed(2)),
      memberBankBalance:
        memberBankBalance === null || typeof memberBankBalance === "undefined"
          ? null
          : Number(Number(memberBankBalance).toFixed(2)),
      financeOrderCount: Number(orderFinanceRow?.financeOrderCount || 0),
      ordersWithPaymentFeeData: Number(orderFinanceRow?.ordersWithPaymentFeeData || 0),
      totalSales: Number(Number(reportingRow?.retailAmount || 0).toFixed(2))
    };
  });

  return result;
}

async function loadMemberLedgerFinanceMap(weeks) {
  const pool = getPool();
  const orderedWeeks = (Array.isArray(weeks) ? weeks : [])
    .filter((week) => week?.start && week?.end)
    .slice()
    .sort((left, right) => String(left.start).localeCompare(String(right.start)));
  if (!orderedWeeks.length) return {};

  const firstWeekStart = orderedWeeks[0].start;
  const lastWeekEnd = orderedWeeks[orderedWeeks.length - 1].end;

  const cashReceivedCentsExpression = `
    CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.cashReceivedCents')) AS SIGNED)
  `;
  const creditIssuedCentsExpression = `
    CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.creditIssuedCents')) AS SIGNED)
  `;
  const bonusCreditCentsExpression = `
    CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.bonusCreditCents')) AS SIGNED)
  `;

  try {
    const [weeklyRows] = await pool.query(
      `
        SELECT
          DATE_FORMAT(
            DATE_SUB(DATE(e.effective_date), INTERVAL WEEKDAY(DATE(e.effective_date)) DAY),
            '%Y-%m-%d'
          ) AS weekKey,
          COALESCE(SUM(
            CASE
              WHEN e.amount_cents > 0
                AND e.entry_type IN ('subscription_deposit', 'dividend_credit', 'localline_credit_import')
              THEN COALESCE(${creditIssuedCentsExpression}, e.amount_cents)
              ELSE 0
            END
          ), 0) AS ledgerCreditIssuedCents,
          COALESCE(SUM(
            CASE
              WHEN e.amount_cents > 0
                AND e.entry_type IN ('subscription_deposit', 'dividend_credit')
              THEN COALESCE(${cashReceivedCentsExpression}, e.amount_cents)
              WHEN e.amount_cents > 0
                AND e.entry_type = 'localline_credit_import'
              THEN COALESCE(${cashReceivedCentsExpression}, 0)
              ELSE 0
            END
          ), 0) AS ledgerCashReceivedCents,
          COALESCE(SUM(
            CASE
              WHEN e.amount_cents > 0
                AND e.entry_type IN ('subscription_deposit', 'dividend_credit', 'localline_credit_import')
              THEN COALESCE(
                ${bonusCreditCentsExpression},
                GREATEST(
                  COALESCE(${creditIssuedCentsExpression}, e.amount_cents)
                    - CASE
                        WHEN e.entry_type IN ('subscription_deposit', 'dividend_credit')
                        THEN COALESCE(${cashReceivedCentsExpression}, e.amount_cents)
                        ELSE COALESCE(${cashReceivedCentsExpression}, 0)
                      END,
                  0
                )
              )
              ELSE 0
            END
          ), 0) AS ledgerBonusCreditCents,
          COUNT(*) AS ledgerEntryCount
        FROM member_ledger_entries e
        JOIN member_ledger_accounts a ON a.id = e.account_id
        WHERE e.effective_date >= ?
          AND e.effective_date < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY weekKey
      `,
      [firstWeekStart, lastWeekEnd]
    );

    const [snapshotRows] = await pool.query(
      `
        SELECT
          snapshot_week_start AS weekKey,
          total_balance AS totalBalance
        FROM local_line_customer_credit_snapshots
        WHERE snapshot_week_start <= ?
        ORDER BY snapshot_week_start ASC
      `,
      [orderedWeeks[orderedWeeks.length - 1].start]
    );

    const weeklyMap = new Map(weeklyRows.map((row) => [String(row.weekKey), row]));
    const snapshotMap = new Map(snapshotRows.map((row) => [String(row.weekKey), Number(row.totalBalance)]));
    const result = {};

    orderedWeeks.forEach((week) => {
      const row = weeklyMap.get(String(week.start)) || {};
      const snapshotBalance = snapshotMap.has(String(week.start))
        ? Number(snapshotMap.get(String(week.start)))
        : null;
      const previousSnapshot = snapshotRows
        .filter((snapshotRow) => String(snapshotRow.weekKey) < String(week.start))
        .slice(-1)[0];
      const previousSnapshotBalance =
        previousSnapshot && Number.isFinite(Number(previousSnapshot.totalBalance))
          ? Number(previousSnapshot.totalBalance)
          : null;
      const snapshotChange =
        snapshotBalance !== null && previousSnapshotBalance !== null
          ? snapshotBalance - previousSnapshotBalance
          : null;
      result[week.start] = {
        ledgerCreditIssued: Number(Number(row.ledgerCreditIssuedCents || 0) / 100),
        ledgerCashReceived: Number(Number(row.ledgerCashReceivedCents || 0) / 100),
        ledgerBonusCredit: Number(Number(row.ledgerBonusCreditCents || 0) / 100),
        memberBankBalanceChange: snapshotChange === null ? null : round2(snapshotChange),
        memberBankBalance: snapshotBalance === null ? null : round2(snapshotBalance)
      };
    });

    return result;
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return {};
    }
    throw error;
  }
}

async function loadVendorWeeklyMap(weeks) {
  const pool = getPool();
  const weekKeys = weeks.map((week) => week.start).filter(Boolean);
  if (!weekKeys.length) return {};
  const retailSalesPredicate = getDashboardRetailSalesPredicate();

  const [rows] = await pool.query(
    `
      SELECT
        week_start AS weekKey,
        COALESCE(SUM(retail_amount), 0) AS retailSales,
        COALESCE(SUM(purchase_total), 0) AS purchaseCost
      FROM local_line_order_reporting_entries
      WHERE order_status = 'OPEN'
        AND payment_status = 'PAID'
        AND ${retailSalesPredicate}
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
  const serviceAccountJson =
    getDashboardEnv("GOOGLE_SERVICE_ACCOUNT_JSON") ||
    getDashboardEnv("GOOGLE_APPLICATION_CREDENTIALS");
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

async function getOrCreateSheetMetadata(accessToken, spreadsheetId, title) {
  const meta = await sheetsRequest(
    accessToken,
    "GET",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties,charts(chartId,spec/title))`
  );
  const match = (meta.sheets || []).find((sheet) => sheet?.properties?.title === title);
  if (match?.properties?.sheetId || match?.properties?.sheetId === 0) {
    return {
      properties: match.properties,
      charts: match.charts || []
    };
  }
  const created = await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      requests: [{ addSheet: { properties: { title } } }]
    }
  );
  return {
    properties: created?.replies?.[0]?.addSheet?.properties || null,
    charts: []
  };
}

function buildPackWagesSalesChartRequests(sheetId, chartConfig) {
  const sourceRowRange = (rowIndex) => ({
    sheetId,
    startRowIndex: rowIndex,
    endRowIndex: rowIndex + 1,
    startColumnIndex: chartConfig.startColumnIndex,
    endColumnIndex: chartConfig.endColumnIndex
  });

  return [
    {
      addChart: {
        chart: {
          spec: {
            title: chartConfig.title,
            basicChart: {
              chartType: "COMBO",
              legendPosition: "NO_LEGEND",
              headerCount: 0,
              axis: [
                { position: "BOTTOM_AXIS", title: "Week" },
                { position: "LEFT_AXIS", title: "% Pack Wages to Retail Sales" },
                { position: "RIGHT_AXIS", title: "Retail Sales" }
              ],
              domains: [
                {
                  domain: {
                    sourceRange: { sources: [sourceRowRange(chartConfig.weekLabelRowIndex)] }
                  }
                }
              ],
              series: [
                {
                  series: {
                    sourceRange: { sources: [sourceRowRange(chartConfig.retailSalesRowIndex)] }
                  },
                  targetAxis: "RIGHT_AXIS",
                  type: "COLUMN"
                },
                {
                  series: {
                    sourceRange: { sources: [sourceRowRange(chartConfig.packWagesRowIndex)] }
                  },
                  targetAxis: "LEFT_AXIS",
                  type: "LINE",
                  lineStyle: { type: "SOLID", width: 3 },
                  pointStyle: { size: 5, shape: "CIRCLE" }
                }
              ]
            }
          },
          position: {
            overlayPosition: {
              anchorCell: {
                sheetId,
                rowIndex: chartConfig.anchorRowIndex,
                columnIndex: chartConfig.anchorColumnIndex
              },
              offsetXPixels: 0,
              offsetYPixels: 0,
              widthPixels: PACK_WAGES_SALES_CHART_WIDTH_PX,
              heightPixels: PACK_WAGES_SALES_CHART_HEIGHT_PX
            }
          }
        }
      }
    }
  ];
}

async function writeDashboardToSheet(
  accessToken,
  values,
  metricRows,
  sectionRows,
  packWagesSalesChart
) {
  const sheetMetadata = await getOrCreateSheetMetadata(
    accessToken,
    DASHBOARD_SHEET_ID,
    DASHBOARD_TARGET_TITLE
  );
  const sheetProperties = sheetMetadata.properties;
  const sheetId = Number(sheetProperties?.sheetId);
  const maxCols = values[0]?.length || 1;
  const maxRows = values.length || 1;
  const chartGridRowCount = packWagesSalesChart ? packWagesSalesChart.anchorRowIndex + 24 : 0;
  const gridRowCount = Math.max(
    Number(sheetProperties?.gridProperties?.rowCount || 0),
    maxRows,
    chartGridRowCount,
    1
  );
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
          gridProperties: {
            frozenRowCount: 2,
            frozenColumnCount: DASHBOARD_WEEK_START_COLUMN_INDEX,
            rowCount: gridRowCount,
            columnCount: gridColumnCount
          }
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.rowCount,gridProperties.columnCount"
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

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: gridRowCount, startColumnIndex: 1, endColumnIndex: 4 },
      cell: { note: "" },
      fields: "note"
    }
  });

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

    if (metric.note) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 3, endColumnIndex: 4 },
          cell: { note: metric.note },
          fields: "note"
        }
      });
    }

    if (metric.bold) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 0, endColumnIndex: maxCols },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true }
            }
          },
          fields: "userEnteredFormat.textFormat.bold"
        }
      });
    }

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
    { startIndex: 3, pixelSize: 180 },
    { startIndex: 4, pixelSize: 110 },
    { startIndex: 5, pixelSize: 100 },
    { startIndex: 6, pixelSize: 100 },
    { startIndex: 7, pixelSize: 100 },
    { startIndex: 8, pixelSize: 100 }
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
        startIndex: DASHBOARD_WEEK_START_COLUMN_INDEX,
        endIndex: maxCols
      },
      properties: { pixelSize: 92 },
      fields: "pixelSize"
    }
  });

  (sheetMetadata.charts || [])
    .filter((chart) =>
      [PACK_WAGES_SALES_CHART_TITLE, ...PACK_WAGES_SALES_CHART_LEGACY_TITLES]
        .includes(chart?.spec?.title)
    )
    .forEach((chart) => {
      if (Number.isFinite(Number(chart.chartId))) {
        requests.push({ deleteEmbeddedObject: { objectId: Number(chart.chartId) } });
      }
    });

  if (packWagesSalesChart) {
    requests.push(...buildPackWagesSalesChartRequests(sheetId, packWagesSalesChart));
  }

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
  const snapSummary = await loadCurrentSnapPriceListMemberSummary();
  const snapSubscriberCount = snapSummary.snapSubscriberCount;
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
        snapPriceListId: snapSummary.snapPriceListId,
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
      const snapSubscriberCount = Number(summary.snapSubscribers || 0);
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
    const sourceWeeks = extractWeeksFromSource(sourceRows);
    if (!sourceWeeks.length) {
      throw new Error("No dashboard week columns found in the source sheet.");
    }
    const accessToken = await getSheetsAccessToken();
    const targetRows = await fetchSheetRowsByTitle(accessToken, DASHBOARD_TARGET_TITLE);
    const targetWeeks = extractWeeksFromGeneratedRows(targetRows);
    const manualValueMap = mergeManualValueMaps(
      buildManualValueMapFromSourceRows(sourceRows, sourceWeeks),
      buildManualValueMapFromGeneratedRows(targetRows)
    );
    const customManualRows = [
      ...buildCustomManualRowsFromSourceRows(sourceRows),
      ...buildCustomManualRowsFromGeneratedRows(targetRows)
    ];
    const availability = await loadDashboardPublishAvailability();
    const dashboardWeeks = mergeDashboardWeeks(sourceWeeks, targetWeeks);
    const { weeks, addedWeeks } = extendWeeksThroughPublishableWeek(
      dashboardWeeks,
      availability.publishableThroughWeekStart
    );
    const publishableWeekStarts = new Set(
      weeks
        .filter(
          (week) =>
            availability.publishableThroughWeekStart &&
            String(week.start || "") <= String(availability.publishableThroughWeekStart)
        )
        .map((week) => week.start)
    );
    const summaryPeriods = buildDashboardSummaryPeriods(weeks, publishableWeekStarts);
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

    try {
      await refreshLatestSnapshotSnapSubscriberCount(connection);
    } catch (error) {
      dashboardWarnings.push(
        `Could not refresh SNAP price-list member count; using cached value. ${error?.message || error}`
      );
    }

    const publishableWeeks = weeks.filter((week) => publishableWeekStarts.has(week.start));
    const latestPublishableWeek = publishableWeeks[publishableWeeks.length - 1] || null;
    if (latestPublishableWeek) {
      try {
        const existingCustomerCreditSnapshot = await loadCustomerCreditSnapshotForWeek(
          connection,
          latestPublishableWeek.start
        );
        if (!isBackfilledCustomerCreditSnapshot(existingCustomerCreditSnapshot)) {
          await captureLocalLineCustomerCreditSnapshot(connection, latestPublishableWeek);
        }
      } catch (error) {
        dashboardWarnings.push(
          `Could not refresh Local Line member-bank balance snapshot; leaving unsnapped weeks blank. ${error?.message || error}`
        );
      }
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
        : addedWeeks.length
          ? `Loaded ${sourceWeeks.length} source weeks and auto-added ${addedWeeks.length} week columns`
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
    reportProgress({
      phaseKey: "compute",
      phaseLabel: "Compute Metrics",
      status: "running",
      percent: 80,
      message: "Loading QBO reconciliation metrics"
    });
    const qboResult = await loadDashboardQboPeriodMetrics(summaryPeriods, { connection });
    dashboardWarnings.push(...(qboResult.warnings || []));

    const { values, metricRows, sectionRows, packWagesSalesChart } = buildDashboardRows(
      weeks,
      manualValueMap,
      weeklyKpiMap,
      vendorWeeklyMap,
      timesheetResult.map || {},
      timesheetResult.taskLabels || [],
      subscriberWeeklyMap,
      publishableWeekStarts,
      summaryPeriods,
      qboResult.map || {},
      customManualRows
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

    await writeDashboardToSheet(
      accessToken,
      values,
      metricRows,
      sectionRows,
      packWagesSalesChart
    );

    const finishedAt = new Date();
    const summary = {
      spreadsheetId: DASHBOARD_SHEET_ID,
      targetTitle: DASHBOARD_TARGET_TITLE,
      sourceGid: DASHBOARD_SOURCE_GID,
      weekCount: weeks.length,
      sourceWeekCount: sourceWeeks.length,
      existingTargetWeekCount: targetWeeks.length,
      autoAddedWeekCount: addedWeeks.length,
      autoAddedWeeks: addedWeeks.map((week) => ({
        label: week.label,
        start: week.start,
        end: week.end
      })),
      publishableWeekCount: publishableWeekStarts.size,
      summaryPeriods: summaryPeriods.map((period) => ({
        key: period.key,
        label: period.label,
        start: period.start,
        end: period.end,
        started: period.started
      })),
      qboStatus: qboResult.source,
      rowCount: values.length,
      latestWeekStart: availability.publishableThroughWeekStart || null,
      latestWeekEnd: availability.publishableThroughWeekStart
        ? addDaysYmd(availability.publishableThroughWeekStart, 6)
        : null,
      latestSourceWeekStart: sourceWeeks[sourceWeeks.length - 1]?.start || null,
      latestSourceWeekEnd: sourceWeeks[sourceWeeks.length - 1]?.end || null,
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
