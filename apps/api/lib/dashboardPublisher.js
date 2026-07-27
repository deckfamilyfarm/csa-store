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
const DASHBOARD_V2_TARGET_TITLE =
  getDashboardEnv("DASHBOARD_V2_TARGET_TITLE") || `${DASHBOARD_TARGET_TITLE}v2`;
const DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE =
  getDashboardEnv("DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE") ||
  "Dashboard-auto-employee-credits26";
const DASHBOARD_CREDITS_SOURCE_TITLE =
  getDashboardEnv("DASHBOARD_CREDITS_SOURCE_TITLE") || "Credits";
const DASHBOARD_EMPLOYEE_CREDITS_YEAR =
  Number.parseInt(getDashboardEnv("DASHBOARD_EMPLOYEE_CREDITS_YEAR", "2026"), 10) || 2026;
const DASHBOARD_STORE_CREDIT_SYNC_YEAR =
  Number.parseInt(
    getDashboardEnv("DASHBOARD_STORE_CREDIT_SYNC_YEAR", String(DASHBOARD_EMPLOYEE_CREDITS_YEAR)),
    10
  ) || DASHBOARD_EMPLOYEE_CREDITS_YEAR;
const DASHBOARD_STORE_CREDIT_SYNC_PAGE_SIZE =
  Math.max(25, Number.parseInt(getDashboardEnv("DASHBOARD_STORE_CREDIT_SYNC_PAGE_SIZE", "100"), 10) || 100);
const DASHBOARD_STORE_CREDIT_SYNC_CONCURRENCY =
  Math.max(1, Number.parseInt(getDashboardEnv("DASHBOARD_STORE_CREDIT_SYNC_CONCURRENCY", "8"), 10) || 8);
const DASHBOARD_EMPLOYEE_CREDIT_PRICE_LIST_ID =
  Number(getDashboardEnv("DASHBOARD_EMPLOYEE_CREDIT_PRICE_LIST_ID", "2719")) || 2719;
const DASHBOARD_EMPLOYEE_CREDIT_PACKAGE_IDS = parseDashboardIdList(
  getDashboardEnv("DASHBOARD_EMPLOYEE_CREDIT_PACKAGE_IDS", "632658,632662,632661")
);
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
const DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT =
  Math.max(
    0,
    Number.parseFloat(getDashboardEnv("DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT", "50")) || 50
  );
const DASHBOARD_TOM_CULHANE_CASH_RECEIVED_EMAIL = normalizeDashboardText(
  getDashboardEnv("DASHBOARD_TOM_CULHANE_CASH_RECEIVED_EMAIL", "thomasabcxyz@yahoo.com")
);
const DASHBOARD_TOM_CULHANE_CASH_RECEIVED_NAME = normalizeDashboardText(
  getDashboardEnv("DASHBOARD_TOM_CULHANE_CASH_RECEIVED_NAME", "Tom Culhane")
);
const DASHBOARD_TOM_CULHANE_CASH_RECEIVED_AMOUNT =
  Number.parseFloat(getDashboardEnv("DASHBOARD_TOM_CULHANE_CASH_RECEIVED_AMOUNT", "500")) || 500;
const DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS = [
  {
    key: "jarDepositReturnCredit",
    label: "Manual Credit - Jar / Deposit Returns",
    source: "Local Line MANUAL_CREDIT note bucket",
    methodology: "Local Line manual credit additions whose note points to jar, bottle, deposit, or container returns, capped to the remaining ledger pool after authoritative Credits-tab categories are removed."
  },
  {
    key: "productItemCredit",
    label: "Manual Credit - Product / Item Credits",
    source: "Local Line MANUAL_CREDIT note bucket",
    methodology: "Local Line manual credit additions with a specific product or item note, capped to the remaining ledger pool after authoritative Credits-tab categories and clearer note buckets are removed."
  },
  {
    key: "productIssueRefundCredit",
    label: "Manual Credit - Product Issue / Refunds",
    source: "Local Line MANUAL_CREDIT note bucket",
    methodology: "Local Line manual credit additions whose note points to refunds, missing items, quality issues, cancellations, reimbursements, shorts, or undelivered products, capped to the remaining ledger pool after authoritative Credits-tab categories are removed."
  },
  {
    key: "paymentTradeAdminCredit",
    label: "Manual Credit - Payment / Trade / Admin Notes",
    source: "Local Line MANUAL_CREDIT note bucket",
    methodology: "Local Line manual credit additions whose note points to payments, trades, employee/admin approvals, invoices, checks, cash, gifts, influencer/farm-stay items, or similar administrative notes, capped to the remaining ledger pool after authoritative Credits-tab categories are removed."
  },
  {
    key: "blankManualCredit",
    label: "Manual Credit - Blank / Unlabeled",
    source: "Local Line MANUAL_CREDIT note bucket",
    methodology: "Local Line manual credit additions with no note, capped to the remaining ledger pool after authoritative Credits-tab categories and clearer note buckets are removed."
  }
];
const DASHBOARD_MANUAL_CREDIT_NOTE_BUCKET_ALLOCATION_ORDER = [
  "jarDepositReturnCredit",
  "productIssueRefundCredit",
  "productItemCredit",
  "paymentTradeAdminCredit",
  "blankManualCredit"
];
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
const DASHBOARD_MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

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

function normalizeDashboardText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ");
}

function slugifyDashboardKey(value, fallback = "uncategorized") {
  const slug = normalizeDashboardText(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function titleCaseDashboardLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      if (/^(DFF|FFCSA|CSA|SNAP|QBO|LL)$/i.test(word)) return word.toUpperCase();
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function formatMysqlDateTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 19).replace("T", " ");
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

function buildDashboardWeekPeriods(weeks = [], publishableWeekStarts = null) {
  return getPublishableDashboardWeeks(weeks, publishableWeekStarts).map((week) => ({
    key: `week:${week.start}`,
    label: week.label || formatDashboardWeekLabel(week.start),
    year: getYearFromWeekStart(week.start),
    start: week.start,
    end: week.end,
    started: Boolean(week.start && week.end),
    weekStarts: new Set([week.start])
  }));
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
          source: "SUM(product order-line retail amount)",
          methodology:
            "Formula: SUM(local_line_order_reporting_entries.retail_amount) for paid open Local Line reporting lines where the order line is not a Membership / membership purchase row. This is product value delivered, not cash received, so it intentionally does not equal Cash Collected on Orders + Store Credit Used.",
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

function getDashboardMonthStartYmd(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-01` : "";
}

function getDashboardMonthEndYmd(monthStart) {
  const date = parseYmd(monthStart);
  if (!date) return monthStart;
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return formatYmd(date);
}

function formatDashboardMonthLabel(monthStart) {
  const date = parseYmd(monthStart);
  if (!date) return String(monthStart || "");
  const monthLabel = DASHBOARD_MONTH_LABELS[date.getUTCMonth()] || String(date.getUTCMonth() + 1);
  return `${monthLabel} ${date.getUTCFullYear()}`;
}

function formatDashboardHeaderLabel(value) {
  const label = String(value || "");
  return /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(label)
    ? `'${label}`
    : label;
}

function getDashboardMonthlyReportYear(weeks = [], publishableWeekStarts = null) {
  const publishableWeeks = getPublishableDashboardWeeks(weeks, publishableWeekStarts);
  const candidate =
    publishableWeeks[publishableWeeks.length - 1]?.end ||
    weeks[weeks.length - 1]?.end ||
    weeks[0]?.end ||
    getTodayYmd();
  const year = Number(String(candidate || "").slice(0, 4));
  return Number.isFinite(year) ? year : new Date().getUTCFullYear();
}

function getLatestCompleteCalendarMonthEndYmd(referenceDate = new Date()) {
  const startOfCurrentMonth = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1)
  );
  startOfCurrentMonth.setUTCDate(0);
  return formatYmd(startOfCurrentMonth);
}

function buildDashboardMonthColumns(weeks = [], publishableWeekStarts = null) {
  const year = getDashboardMonthlyReportYear(weeks, publishableWeekStarts);
  const publishableWeeks = getPublishableDashboardWeeks(weeks, publishableWeekStarts);
  const latestPublishableEnd = publishableWeeks[publishableWeeks.length - 1]?.end || null;
  const latestCompleteMonthEnd = getMinimumYmd([
    latestPublishableEnd,
    getLatestCompleteCalendarMonthEndYmd()
  ]);

  return Array.from({ length: 12 }, (_unused, index) => {
    const monthStart = `${year}-${String(index + 1).padStart(2, "0")}-01`;
    const monthEnd = getDashboardMonthEndYmd(monthStart);
    if (!latestCompleteMonthEnd || String(monthEnd) > String(latestCompleteMonthEnd)) {
      return null;
    }
    return {
      key: `${year}:m${String(index + 1).padStart(2, "0")}`,
      label: formatDashboardMonthLabel(monthStart),
      start: monthStart,
      end: monthEnd,
      year,
      month: index + 1,
      started: true,
      weekStarts: new Set([monthStart])
    };
  }).filter(Boolean);
}

function buildPublishableDashboardMonthStarts(weeks = [], publishableWeekStarts = null) {
  return new Set(
    getPublishableDashboardWeeks(weeks, publishableWeekStarts)
      .map((week) => getDashboardMonthStartYmd(week.start))
      .filter(Boolean)
  );
}

function addDashboardMonthlyNumber(target, key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  target[key] = round2(Number(target[key] || 0) + numeric);
  return true;
}

function buildMonthlyDashboardKpiMap(weeks = [], weeklyKpiMap = {}) {
  const byMonth = new Map();
  const sumFields = [
    "numOrders",
    "numGuestOrders",
    "numSubscriberOrders",
    "guestPurchaseDollars",
    "subscriptionIncome",
    "subscriptionCreditGiven",
    "subscriptionCreditUsed",
    "cashCollectedOnOrders",
    "paymentProcessingFees",
    "memberCreditIssued",
    "actualDollarsReceivedForCredit",
    "bonusCreditExpense",
    "financeOrderCount",
    "ordersWithPaymentFeeData",
    "totalSales"
  ];

  (weeks || []).forEach((week) => {
    const monthStart = getDashboardMonthStartYmd(week.start);
    if (!monthStart) return;
    const source = weeklyKpiMap?.[week.start] || {};
    const summary = byMonth.get(monthStart) || {
      totalItemsWeightedByOrder: 0,
      totalOrderAmountWeightedByOrder: 0,
      hasMemberBankBalanceChange: false,
      latestMemberBankBalance: null
    };
    sumFields.forEach((field) => {
      addDashboardMonthlyNumber(summary, field, source[field]);
    });

    const orderCount = Number(source.numOrders || 0);
    if (Number.isFinite(orderCount) && orderCount > 0) {
      const averageItems = Number(source.averageItemsPerOrder);
      const averageOrderAmount = Number(source.averageOrderAmount);
      if (Number.isFinite(averageItems)) {
        summary.totalItemsWeightedByOrder += averageItems * orderCount;
      }
      if (Number.isFinite(averageOrderAmount)) {
        summary.totalOrderAmountWeightedByOrder += averageOrderAmount * orderCount;
      }
    }

    const memberBankBalanceChange = Number(source.memberBankBalanceChange);
    if (Number.isFinite(memberBankBalanceChange)) {
      summary.memberBankBalanceChange = round2(
        Number(summary.memberBankBalanceChange || 0) + memberBankBalanceChange
      );
      summary.hasMemberBankBalanceChange = true;
    }
    const memberBankBalance = Number(source.memberBankBalance);
    if (Number.isFinite(memberBankBalance)) {
      summary.latestMemberBankBalance = round2(memberBankBalance);
    }

    byMonth.set(monthStart, summary);
  });

  return Object.fromEntries(
    Array.from(byMonth.entries()).map(([monthStart, summary]) => {
      const numOrders = Number(summary.numOrders || 0);
      return [
        monthStart,
        {
          ...summary,
          averageItemsPerOrder: numOrders
            ? Math.round(summary.totalItemsWeightedByOrder / numOrders)
            : 0,
          averageOrderAmount: numOrders
            ? round2(summary.totalOrderAmountWeightedByOrder / numOrders)
            : 0,
          netOrderCash: round2(
            Number(summary.cashCollectedOnOrders || 0) -
              Number(summary.paymentProcessingFees || 0)
          ),
          memberBankBalanceChange: summary.hasMemberBankBalanceChange
            ? round2(summary.memberBankBalanceChange || 0)
            : null,
          memberBankBalance: summary.latestMemberBankBalance
        }
      ];
    })
  );
}

function buildMonthlyDashboardVendorMap(weeks = [], vendorWeeklyMap = {}) {
  const byMonth = new Map();
  (weeks || []).forEach((week) => {
    const monthStart = getDashboardMonthStartYmd(week.start);
    if (!monthStart) return;
    const source = vendorWeeklyMap?.[week.start] || {};
    const summary = byMonth.get(monthStart) || {};
    addDashboardMonthlyNumber(summary, "retailSales", source.retailSales);
    addDashboardMonthlyNumber(summary, "purchaseCost", source.purchaseCost);
    byMonth.set(monthStart, summary);
  });
  return Object.fromEntries(byMonth.entries());
}

function buildMonthlyDashboardTimesheetMap(weeks = [], timesheetWeeklyMap = {}) {
  const byMonth = new Map();
  (weeks || []).forEach((week) => {
    const monthStart = getDashboardMonthStartYmd(week.start);
    if (!monthStart) return;
    const source = timesheetWeeklyMap?.[week.start] || {};
    const summary = byMonth.get(monthStart) || { tasks: {} };
    addDashboardMonthlyNumber(summary, "totalWages", source.totalWages);
    Object.entries(source.tasks || {}).forEach(([taskLabel, value]) => {
      addDashboardMonthlyNumber(summary.tasks, taskLabel, value);
    });
    byMonth.set(monthStart, summary);
  });
  return Object.fromEntries(byMonth.entries());
}

function buildMonthlyDashboardSubscriberMap(weeks = [], subscriberWeeklyMap = {}) {
  const byMonth = new Map();
  (weeks || []).forEach((week) => {
    const monthStart = getDashboardMonthStartYmd(week.start);
    if (!monthStart) return;
    const source = subscriberWeeklyMap?.[week.start] || {};
    const summary = byMonth.get(monthStart) || {};
    addDashboardMonthlyNumber(summary, "newSubscribers", source.newSubscribers);
    addDashboardMonthlyNumber(summary, "exitingSubscribers", source.exitingSubscribers);
    const snapSubscribers = Number(source.snapSubscribers);
    if (Number.isFinite(snapSubscribers)) summary.snapSubscribers = snapSubscribers;
    const totalSubscribers = Number(source.totalSubscribers);
    if (Number.isFinite(totalSubscribers)) summary.totalSubscribers = totalSubscribers;
    byMonth.set(monthStart, summary);
  });
  return Object.fromEntries(byMonth.entries());
}

const DASHBOARD_CREDITS_TYPE_KEYS = new Map([
  ["owners equity", "ownersEquity"],
  ["owner equity", "ownersEquity"],
  ["dff trade", "dffTrade"],
  ["marketing", "marketing"],
  ["dropsite host credit", "dropsiteHostCredit"],
  ["ffcsa employee credit", "ffcsaEmployeeCredit"],
  ["dff employee credit", "dffEmployeeCredit"]
]);

function normalizeDashboardCreditsType(value) {
  return normalizeDashboardText(value);
}

function getDashboardCreditsTypeKey(value) {
  return DASHBOARD_CREDITS_TYPE_KEYS.get(normalizeDashboardCreditsType(value)) || null;
}

function formatDashboardCurrencyText(value) {
  const number = Number(value || 0);
  const absolute = Math.abs(number);
  const formatted = `$${absolute.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
  return number < 0 ? `-${formatted}` : formatted;
}

function classifyDashboardCreditsTypeForMemberBank(value) {
  const normalized = normalizeDashboardCreditsType(value);
  const display = titleCaseDashboardLabel(value);
  if (!normalized) return null;
  const exactLabels = new Map([
    ["owners equity", "Manual Credit - Owners Equity"],
    ["owner equity", "Manual Credit - Owners Equity"],
    ["entered", "Manual Credit - Entered Credits"],
    ["dff trade", "Manual Credit - DFF Trade"],
    ["marketing", "Manual Credit - Marketing"],
    ["dropsite host credit", "Manual Credit - Dropsite Host Credit"],
    ["ffcsa employee credit", "Manual Credit - FFCSA Employee Credit"],
    ["dff employee credit", "Manual Credit - DFF Employee Credit"]
  ]);
  const exactSortOrders = new Map([
    ["entered", 10],
    ["dropsite host credit", 20],
    ["marketing", 30],
    ["dff trade", 40],
    ["dff employee credit", 50],
    ["ffcsa employee credit", 60],
    ["owners equity", 70],
    ["owner equity", 70]
  ]);
  const labelSuffix = display.endsWith("Credit") || display.endsWith("Credits")
    ? display
    : `${display} Credits`;
  const label = exactLabels.get(normalized) || `Manual Credit - ${labelSuffix}`;
  const sortOrder = exactSortOrders.get(normalized) || 100;
  if (normalized.includes("snap")) {
    return { key: "snapCredits", label: "Manual Credit - SNAP Credits", sortOrder: 10, sourceTypeLabel: display };
  }
  if (
    normalized.includes("jar") ||
    normalized.includes("bottle") ||
    normalized.includes("deposit") ||
    normalized.includes("container return")
  ) {
    return {
      key: "jarReturnCredits",
      label: "Manual Credit - Jar Return Credits",
      sortOrder: 20,
      sourceTypeLabel: display
    };
  }
  if (
    normalized.includes("product return") ||
    normalized.includes("product credit") ||
    normalized.includes("missing") ||
    normalized.includes("not received") ||
    normalized.includes("refund") ||
    normalized.includes("reimburse") ||
    normalized.includes("cancel") ||
    normalized.includes("quality") ||
    normalized.includes("wrong item") ||
    normalized.includes("damaged")
  ) {
    return {
      key: "productReturnIssueCredits",
      label: "Manual Credit - Product Return / Issue Credits",
      sortOrder: 30,
      sourceTypeLabel: display
    };
  }
  return {
    key: `creditType_${slugifyDashboardKey(normalized)}`,
    label,
    sortOrder,
    sourceTypeLabel: display
  };
}

function normalizeDashboardCreditsName(value) {
  return String(value || "").trim();
}

function addDashboardCreditsCategoryName(monthSummary, categoryKey, name, value) {
  if (!categoryKey || !name || !Number(value)) return;
  const namesByCategory = monthSummary.memberBankCreditCategoryNames || {};
  const categoryNames = namesByCategory[categoryKey] || {};
  categoryNames[name] = round2(Number(categoryNames[name] || 0) + Number(value || 0));
  namesByCategory[categoryKey] = categoryNames;
  monthSummary.memberBankCreditCategoryNames = namesByCategory;
}

function addDashboardMemberBankCreditCategory(monthSummary, typeLabel, value) {
  const category = classifyDashboardCreditsTypeForMemberBank(typeLabel);
  if (!category) return;
  const categories = monthSummary.memberBankCreditCategories || {};
  const existing = categories[category.key] || {
    label: category.label,
    sourceTypeLabel: category.sourceTypeLabel || typeLabel,
    amount: 0,
    sortOrder: category.sortOrder
  };
  existing.amount = round2(Number(existing.amount || 0) + Number(value || 0));
  existing.label = category.label;
  existing.sourceTypeLabel = existing.sourceTypeLabel || category.sourceTypeLabel || typeLabel;
  existing.sortOrder = Math.min(Number(existing.sortOrder || category.sortOrder), category.sortOrder);
  categories[category.key] = existing;
  monthSummary.memberBankCreditCategories = categories;
}

function parseDashboardCreditsMonthHeader(value, year = DASHBOARD_EMPLOYEE_CREDITS_YEAR) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  if (!normalized || normalized === "total") return null;
  const aliases = new Map([
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["sept", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12]
  ]);
  const month = aliases.get(normalized);
  if (!month) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function buildDashboardCreditsMonthlyMap(rows = [], year = DASHBOARD_EMPLOYEE_CREDITS_YEAR) {
  const headerIndex = rows.findIndex((row) => {
    const first = String(row?.[0] || "").trim().toLowerCase();
    const second = String(row?.[1] || "").trim().toLowerCase();
    return first === "type" && second === "name";
  });
  if (headerIndex < 0) return {};

  const header = rows[headerIndex] || [];
  const monthColumns = header
    .map((value, columnIndex) => {
      const monthStart = parseDashboardCreditsMonthHeader(value, year);
      return monthStart ? { monthStart, columnIndex } : null;
    })
    .filter(Boolean);
  if (!monthColumns.length) return {};

  const monthlyMap = {};
	  rows.slice(headerIndex + 1).forEach((row) => {
	    const typeLabel = String(row?.[0] || "").trim();
	    const typeKey = getDashboardCreditsTypeKey(typeLabel);
	    const category = classifyDashboardCreditsTypeForMemberBank(typeLabel);
	    const name = normalizeDashboardCreditsName(row?.[1]);
	    if (!typeLabel) return;
	    monthColumns.forEach(({ monthStart, columnIndex }) => {
	      const value = parseDashboardNumber(row?.[columnIndex]);
	      if (value === null) return;
	      const monthSummary = monthlyMap[monthStart] || {};
      if (typeKey) {
        monthSummary[typeKey] = round2(Number(monthSummary[typeKey] || 0) + value);
	      }
	      addDashboardMemberBankCreditCategory(monthSummary, typeLabel, value);
	      if (category) {
	        addDashboardCreditsCategoryName(monthSummary, category.key, name, value);
	      }
	      monthlyMap[monthStart] = monthSummary;
	    });
	  });

  return monthlyMap;
}

function getCreditsMemberBankCategoryAmount(creditsMonthlyMap = {}, monthStart, categoryKey) {
  return Number(
    creditsMonthlyMap?.[monthStart]?.memberBankCreditCategories?.[categoryKey]?.amount || 0
  );
}

function getCreditsMemberBankCategoryTotal(creditsMonthlyMap = {}, monthStart) {
  return round2(
    Object.values(creditsMonthlyMap?.[monthStart]?.memberBankCreditCategories || {})
      .reduce((sum, category) => sum + Number(category?.amount || 0), 0)
  );
}

function getManualCreditResidualBeforeNoteBuckets({
  creditsMonthlyMap = {},
  storeCreditMonthlyMap = {},
  monthStart
} = {}) {
  return round2(
    Number(storeCreditMonthlyMap?.[monthStart]?.manualCreditTotal || 0) -
      Number(storeCreditMonthlyMap?.[monthStart]?.automatedSubscriptionCredit || 0) -
      Number(storeCreditMonthlyMap?.[monthStart]?.snapCredit || 0) -
      Number(storeCreditMonthlyMap?.[monthStart]?.tomCulhaneCashReceived || 0) -
      Number(getCreditsMemberBankCategoryTotal(creditsMonthlyMap, monthStart) || 0)
  );
}

function getAdjustedManualCreditNoteBucketValues({
  creditsMonthlyMap = {},
  storeCreditMonthlyMap = {},
  monthStart
} = {}) {
  const rawValues = Object.fromEntries(
    DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS.map((bucket) => [
      bucket.key,
      Number(storeCreditMonthlyMap?.[monthStart]?.[bucket.key] || 0)
    ])
  );
  let remainingResidual = Math.max(
    0,
    getManualCreditResidualBeforeNoteBuckets({
      creditsMonthlyMap,
      storeCreditMonthlyMap,
      monthStart
    })
  );
  const adjustedValues = Object.fromEntries(
    DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS.map((bucket) => [bucket.key, 0])
  );

  DASHBOARD_MANUAL_CREDIT_NOTE_BUCKET_ALLOCATION_ORDER.forEach((bucketKey) => {
    if (remainingResidual <= 0) return;
    const bucketValue = Math.max(0, Number(rawValues[bucketKey] || 0));
    const applied = Math.min(bucketValue, remainingResidual);
    adjustedValues[bucketKey] = round2(applied);
    remainingResidual = round2(remainingResidual - applied);
  });

  return adjustedValues;
}

function getAdjustedManualCreditNoteBucketValue({
  creditsMonthlyMap = {},
  storeCreditMonthlyMap = {},
  monthStart,
  bucketKey
} = {}) {
  const adjustedValues = getAdjustedManualCreditNoteBucketValues({
    creditsMonthlyMap,
    storeCreditMonthlyMap,
    monthStart
  });
  return Number(adjustedValues[bucketKey] || 0);
}

function getUncategorizedManualCreditValue({
  creditsMonthlyMap = {},
  storeCreditMonthlyMap = {},
  monthStart
} = {}) {
  const adjustedNoteBucketValues = getAdjustedManualCreditNoteBucketValues({
    creditsMonthlyMap,
    storeCreditMonthlyMap,
    monthStart
  });
  const adjustedNoteBucketTotal = Object.values(adjustedNoteBucketValues)
    .reduce((sum, value) => sum + Number(value || 0), 0);
  return round2(
    getManualCreditResidualBeforeNoteBuckets({
      creditsMonthlyMap,
      storeCreditMonthlyMap,
      monthStart
    }) - adjustedNoteBucketTotal
  );
}

function collectDashboardMemberBankCreditCategoryRows(creditsMonthlyMap = {}, { monthStarts = null } = {}) {
  const byKey = new Map();
  const includedMonthStarts = monthStarts ? new Set(monthStarts) : null;
  Object.entries(creditsMonthlyMap || {}).forEach(([monthStart, monthSummary]) => {
    if (includedMonthStarts && !includedMonthStarts.has(monthStart)) return;
    Object.entries(monthSummary?.memberBankCreditCategories || {}).forEach(([key, category]) => {
      if (!Number(category?.amount)) return;
      const existing = byKey.get(key) || {
        key,
        label: category.label,
        sourceTypeLabel: category.sourceTypeLabel,
        sortOrder: Number(category.sortOrder || 100),
        total: 0,
        names: new Map()
      };
      existing.total = round2(existing.total + Number(category.amount || 0));
      existing.label = category.label || existing.label;
      existing.sourceTypeLabel = existing.sourceTypeLabel || category.sourceTypeLabel;
      existing.sortOrder = Math.min(existing.sortOrder, Number(category.sortOrder || 100));
      Object.entries(monthSummary?.memberBankCreditCategoryNames?.[key] || {}).forEach(([name, amount]) => {
        if (!name || !Number(amount)) return;
        existing.names.set(name, round2(Number(existing.names.get(name) || 0) + Number(amount || 0)));
      });
      byKey.set(key, existing);
    });
  });
  return Array.from(byKey.values()).map((category) => ({
    ...category,
    names: Array.from(category.names.entries())
      .map(([name, amount]) => ({ name, amount }))
      .sort((left, right) => {
        const amountDiff = Math.abs(Number(right.amount || 0)) - Math.abs(Number(left.amount || 0));
        if (amountDiff) return amountDiff;
        return String(left.name || "").localeCompare(String(right.name || ""));
      })
  })).sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return String(left.label || "").localeCompare(String(right.label || ""));
  });
}

function formatDashboardCreditsNameBreakdown(names = [], { maxNames = 18 } = {}) {
  const filtered = (names || []).filter((item) => item?.name && Number(item.amount));
  if (!filtered.length) return "";
  const visible = filtered.slice(0, maxNames);
  const remaining = filtered.slice(maxNames);
  const visibleText = visible
    .map((item) => `${item.name} (${formatDashboardCurrencyText(item.amount)})`)
    .join("; ");
  const remainingTotal = round2(
    remaining.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );
  const remainingText = remaining.length
    ? `; ${remaining.length} other name${remaining.length === 1 ? "" : "s"} (${formatDashboardCurrencyText(remainingTotal)})`
    : "";
  return `Credits-tab names for shown months: ${visibleText}${remainingText}.`;
}

function buildMonthlyDashboardManualValueMap(manualValueMap = new Map(), weeks = []) {
  const allowedWeekStarts = new Set((weeks || []).map((week) => week.start).filter(Boolean));
  const byLabelAndMonth = new Map();

  for (const [label, rowValues] of manualValueMap.entries()) {
    for (const [weekStart, value] of rowValues.entries()) {
      if (!allowedWeekStarts.has(weekStart)) continue;
      if (value === null || typeof value === "undefined" || String(value).trim() === "") continue;
      const monthStart = getDashboardMonthStartYmd(weekStart);
      if (!monthStart) continue;
      const labelSummary = byLabelAndMonth.get(label) || new Map();
      const monthSummary = labelSummary.get(monthStart) || { total: 0, numericCount: 0, latestText: "" };
      const numeric = parseDashboardNumber(value);
      if (numeric === null) {
        monthSummary.latestText = value;
      } else {
        monthSummary.total += numeric;
        monthSummary.numericCount += 1;
      }
      labelSummary.set(monthStart, monthSummary);
      byLabelAndMonth.set(label, labelSummary);
    }
  }

  const monthlyManualValueMap = new Map();
  for (const [label, monthMap] of byLabelAndMonth.entries()) {
    for (const [monthStart, summary] of monthMap.entries()) {
      setManualValue(
        monthlyManualValueMap,
        label,
        monthStart,
        summary.numericCount ? round2(summary.total) : summary.latestText,
        { overwrite: true }
      );
    }
  }
  return monthlyManualValueMap;
}

function buildMonthlyDashboardInputs({
  weeks = [],
  publishableWeekStarts = null,
  manualValueMap = new Map(),
  weeklyKpiMap = {},
  vendorWeeklyMap = {},
  timesheetWeeklyMap = {},
  subscriberWeeklyMap = {}
} = {}) {
  const months = buildDashboardMonthColumns(weeks, publishableWeekStarts);
  return {
    months,
    publishableMonthStarts: buildPublishableDashboardMonthStarts(weeks, publishableWeekStarts),
    manualValueMap: buildMonthlyDashboardManualValueMap(manualValueMap, weeks),
    weeklyKpiMap: buildMonthlyDashboardKpiMap(weeks, weeklyKpiMap),
    vendorWeeklyMap: buildMonthlyDashboardVendorMap(weeks, vendorWeeklyMap),
    timesheetWeeklyMap: buildMonthlyDashboardTimesheetMap(weeks, timesheetWeeklyMap),
    subscriberWeeklyMap: buildMonthlyDashboardSubscriberMap(weeks, subscriberWeeklyMap)
  };
}

function sumPeriodWeekValues(weeks = [], period, getValue) {
  let total = 0;
  let hasValue = false;
  weeks.forEach((week, index) => {
    if (!isWeekInDashboardSummaryPeriod(week, period)) return;
    const numeric = Number(getValue(week, index));
    if (!Number.isFinite(numeric)) return;
    total += numeric;
    hasValue = true;
  });
  return hasValue ? total : null;
}

function sumPeriodManualValues(weeks = [], period, manualValueMap, rowLabel) {
  return sumPeriodWeekValues(weeks, period, (week) =>
    parseDashboardNumber(getManualSourceValue(manualValueMap, rowLabel, week.start))
  );
}

function latestPeriodWeekValue(weeks = [], period, getValue) {
  for (let index = weeks.length - 1; index >= 0; index -= 1) {
    const week = weeks[index];
    if (!isWeekInDashboardSummaryPeriod(week, period)) continue;
    const numeric = Number(getValue(week, index));
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function buildStartedDashboardSummaryPeriods(weeks = [], publishableWeekStarts = null) {
  return buildDashboardSummaryPeriods(weeks, publishableWeekStarts).filter(
    (period) => period.key?.endsWith(":total") || period.started
  );
}

function buildDashboardV2SummaryPeriods(months = [], publishableMonthStarts = null) {
  return buildStartedDashboardSummaryPeriods(months, publishableMonthStarts).map((period) => ({
    ...period,
    key: `v2:${period.key}`,
    fallbackKey: period.key?.endsWith(":total") ? null : period.key
  }));
}

function dedupeDashboardPeriods(periods = []) {
  const byKey = new Map();
  periods.forEach((period) => {
    if (!period?.key) return;
    if (!byKey.has(period.key)) byKey.set(period.key, period);
  });
  return [...byKey.values()];
}

function getDashboardQboMetric(qboPeriodMap = {}, period, metricKey) {
  const metrics = qboPeriodMap?.[period?.key] || qboPeriodMap?.[period?.fallbackKey] || null;
  const value = metrics?.[metricKey];
  return value === null || typeof value === "undefined" ? null : Number(value);
}

function collectQboExpenseLineLabels(qboPeriodMap = {}) {
  const labels = new Set();
  Object.values(qboPeriodMap || {}).forEach((metrics) => {
    (metrics?.expenseLines || []).forEach((line) => {
      if (!line?.label || line.isPayroll) return;
      if (!Number(line.total || 0)) return;
      labels.add(String(line.label));
    });
  });
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function collectQboIncomeLineLabels(qboPeriodMap = {}) {
  const labels = new Set();
  Object.values(qboPeriodMap || {}).forEach((metrics) => {
    (metrics?.incomeLines || []).forEach((line) => {
      if (!line?.label) return;
      if (!Number(line.total || 0)) return;
      labels.add(String(line.label));
    });
  });
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function getQboExpenseLineValue(qboPeriodMap = {}, period, label) {
  const metrics = qboPeriodMap?.[period?.key] || qboPeriodMap?.[period?.fallbackKey] || null;
  const value = metrics?.expenseLineMap?.[label];
  return value === null || typeof value === "undefined" ? null : Number(value);
}

function getQboIncomeLineValue(qboPeriodMap = {}, period, label) {
  const metrics = qboPeriodMap?.[period?.key] || qboPeriodMap?.[period?.fallbackKey] || null;
  const value = metrics?.incomeLineMap?.[label];
  return value === null || typeof value === "undefined" ? null : Number(value);
}

function buildDashboardV2Rows({
  months = [],
  summaryPeriods = [],
  manualValueMap,
  monthlyKpiMap = {},
  monthlyVendorMap = {},
  monthlyTimesheetMap = {},
  monthlySubscriberMap = {},
  creditsMonthlyMap = {},
  storeCreditMonthlyMap = {},
  qboPeriodMap = {},
  generatedAt = new Date()
} = {}) {
  const periods = [...summaryPeriods, ...months];
  const incomeLineLabels = collectQboIncomeLineLabels(qboPeriodMap);
  const expenseLineLabels = collectQboExpenseLineLabels(qboPeriodMap);
  const getPeriodSum = (period, getValue) => sumPeriodWeekValues(months, period, getValue);
  const getPeriodLatest = (period, getValue) => latestPeriodWeekValue(months, period, getValue);
  const getPeriodFirst = (period, getValue) => {
    for (const month of months) {
      if (!isWeekInDashboardSummaryPeriod(month, period)) continue;
      const value = getValue(month);
      if (value !== null && typeof value !== "undefined" && value !== "") return value;
    }
    return null;
  };
  const getCreditPeriodSum = (period, creditKey) =>
    getPeriodSum(period, (month) => creditsMonthlyMap[month.start]?.[creditKey]);
  const creditsTabManualCreditCategories = collectDashboardMemberBankCreditCategoryRows(
    creditsMonthlyMap,
    { monthStarts: months.map((month) => month.start) }
  );
  const getCreditsTabNameBreakdownNote = (typeLabel) => {
    const normalizedType = normalizeDashboardCreditsType(typeLabel);
    const category = creditsTabManualCreditCategories.find(
      (item) => normalizeDashboardCreditsType(item.sourceTypeLabel) === normalizedType
    );
    return category ? formatDashboardCreditsNameBreakdown(category.names) : "";
  };
  const creditsTabManualCreditCategoryRows = creditsTabManualCreditCategories.map((category) => ({
    label: category.label,
    entry: "AUTO",
    source: `Credits tab Type = ${category.sourceTypeLabel || category.label.replace(/^Manual Credit - /, "")}`,
    methodology: "Authoritative manual-credit classification from the Credits worksheet. Local Line remains the source of truth for total ledger movement; Local Line note buckets only classify the remaining movement after these Credits-tab rows are removed.",
    note: formatDashboardCreditsNameBreakdown(category.names),
    valueType: "currency",
    periodAuto: (period) =>
      getPeriodSum(period, (month) =>
        getCreditsMemberBankCategoryAmount(creditsMonthlyMap, month.start, category.key)
      )
  }));
  const creditsTabManualCreditComponentLabels = creditsTabManualCreditCategoryRows.length
    ? creditsTabManualCreditCategoryRows.map((row) => row.label)
    : ["Manual Credit - Credits Tab Total"];
  const memberBankLedgerComponentLabels = [
    "Manual Credit - Automated Subscription Credits",
    "Manual Credit - SNAP Payments",
    "Manual Credit - Tom Culhane Cash Received",
    ...creditsTabManualCreditComponentLabels,
    ...DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS.map((bucket) => bucket.label),
    "Manual Credit - Uncategorized",
    "Manual Debits",
    "Member Credit Used on Orders"
  ];
  const formulaSumRows = (metricSheetRowsByLabel, labels, columnName) => {
    const refs = labels
      .map((label) => getMetricCellRef(metricSheetRowsByLabel, label, columnName))
      .filter(Boolean);
    return refs.length ? `=IF(COUNTA(${refs.join(",")})=0,"",${refs.join("+")})` : "";
  };
  const formulaDivide = (metricSheetRowsByLabel, numeratorLabel, denominatorLabel, columnName) => {
    const numeratorRef = getMetricCellRef(metricSheetRowsByLabel, numeratorLabel, columnName);
    const denominatorRef = getMetricCellRef(metricSheetRowsByLabel, denominatorLabel, columnName);
    return numeratorRef && denominatorRef
      ? `=IFERROR(${numeratorRef}/${denominatorRef},"")`
      : "";
  };

  const incomeLineRows = incomeLineLabels.map((label) => ({
    label: `QBO Revenue - ${label}`,
    entry: "AUTO",
    source: "QBO income account line",
    valueType: "currency",
    periodAuto: (period) => getQboIncomeLineValue(qboPeriodMap, period, label)
  }));
  const expenseLineRows = expenseLineLabels.map((label) => ({
    label: `QBO Expense - ${label}`,
    entry: "AUTO",
    source: "QBO expense account line",
    valueType: "currency",
    periodAuto: (period) => getQboExpenseLineValue(qboPeriodMap, period, label)
  }));
  const expenseComponentLabels = [
    "QBO Payroll Expenses",
    ...expenseLineRows.map((row) => row.label)
  ];

  const layout = [
    {
      section: "GIVENS",
      rows: [
        {
          label: "Errors/week",
          entry: "MANUAL",
          source: "Manual QA",
          rowLabel: "Errors/week",
          valueType: "int",
          periodAuto: (period) => sumPeriodManualValues(months, period, manualValueMap, "Errors/week")
        },
        {
          label: "Positive responses/week",
          entry: "MANUAL",
          source: "Manual QA",
          rowLabel: "Positive responses/week",
          valueType: "int",
          periodAuto: (period) =>
            sumPeriodManualValues(months, period, manualValueMap, "Positive responses/week")
        },
        {
          label: "New Subscribers",
          entry: "AUTO",
          source: "Subscriber export Created dates",
          valueType: "int",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => monthlySubscriberMap[month.start]?.newSubscribers)
        },
        {
          label: "Exiting Subscribers",
          entry: "AUTO",
          source: "Subscriber export Cancelled Date values",
          valueType: "int",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => monthlySubscriberMap[month.start]?.exitingSubscribers)
        },
        {
          label: "SNAP subscribers",
          entry: "AUTO",
          source: "Local Line SNAP price-list members",
          valueType: "int",
          periodAuto: (period) =>
            getPeriodLatest(period, (month) => monthlySubscriberMap[month.start]?.snapSubscribers)
        },
        {
          label: "Total Subscribers",
          entry: "AUTO",
          source: "Subscriber export active as of month end + Local Line SNAP price-list members",
          valueType: "int",
          periodAuto: (period) =>
            getPeriodLatest(period, (month) => monthlySubscriberMap[month.start]?.totalSubscribers)
        }
      ]
    },
    {
      section: "REVENUE",
      rows: [
        {
          label: "QBO Revenue",
          entry: "AUTO",
          source: "QBO Total Income",
          methodology: "QuickBooks Online Total Income; this is the accounting revenue line used as the dashboard source of truth.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "income")
        },
        {
          label: "LL Revenue",
          entry: "AUTO",
          source: "Local Line retail sales from paid product order lines",
          methodology: "Local Line sold revenue; used as an operational comparison against QBO accounting revenue.",
          valueType: "currency",
          bold: true,
          italic: true,
          periodAuto: (period) =>
            getPeriodSum(period, (month) => monthlyKpiMap[month.start]?.totalSales)
        },
        {
          label: "Revenue Difference",
          entry: "AUTO",
          source: "LL Revenue - QBO Revenue",
          methodology: "Difference between Local Line sold revenue and QBO accounting revenue. Use this to spot timing, account mapping, or sales/import differences.",
          valueType: "currency",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const llRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "LL Revenue", columnName);
            const qboRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Revenue", columnName);
            return llRevenueRef && qboRevenueRef
              ? `=IF(OR(${llRevenueRef}="",${qboRevenueRef}=""),"",${llRevenueRef}-${qboRevenueRef})`
              : "";
          }
        },
        {
          label: "Manual Credit - Credits Tab Total",
          entry: "AUTO",
          source: "Credits tab Type totals",
          methodology: "Total manual-credit value from the Credits tab. These credits are also classified elsewhere in the dashboard as expenses, trade, employee benefits, or owner-equity adjustments; this line keeps the issued credit counted as revenue while the offsetting business purpose is accounted for in those sections.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) =>
            getPeriodSum(period, (month) => getCreditsMemberBankCategoryTotal(creditsMonthlyMap, month.start))
        },
        {
          label: "Total Revenue",
          entry: "AUTO",
          source: "QBO Revenue + Manual Credit - Credits Tab Total + Manual Credit - Tom Culhane Cash Received",
          methodology: "Total Revenue starts with QBO Total Income and adds manual-credit revenue tracked outside normal QBO income: Credits-tab manual credits and Tom Culhane cash received.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const qboRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Revenue", columnName);
            const manualCreditsFromCreditsTabRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Manual Credit - Credits Tab Total",
              columnName
            );
            const tomCulhaneCashReceivedRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Manual Credit - Tom Culhane Cash Received",
              columnName
            );
            return qboRevenueRef && manualCreditsFromCreditsTabRef && tomCulhaneCashReceivedRef
              ? `=IF(COUNTA(${qboRevenueRef},${manualCreditsFromCreditsTabRef},${tomCulhaneCashReceivedRef})=0,"",${qboRevenueRef}+${manualCreditsFromCreditsTabRef}+${tomCulhaneCashReceivedRef})`
              : "";
          }
        }
      ]
    },
    {
      section: "MEMBER BANK",
      rows: [
        {
          label: "Member Bank Opening Balance",
          entry: "AUTO",
          source: "Local Line customer Store Credit balance snapshot",
          methodology: "Opening balance is the latest Local Line customer Store Credit balance snapshot on or before the first day of the period.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodFirst(period, (month) => storeCreditMonthlyMap[month.start]?.openingBalance)
        },
        {
          label: "Manual Credit - Automated Subscription Credits",
          entry: "AUTO",
          source: "Local Line store-credit transactions: MANUAL_CREDIT note = automated monthly subscription addition",
          methodology: "Actual Local Line credit transactions created by the subscription automation.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => storeCreditMonthlyMap[month.start]?.automatedSubscriptionCredit)
        },
        {
          label: "Manual Credit - SNAP Payments",
          entry: "AUTO",
          source: `Local Line MANUAL_CREDIT for SNAP price-list/tag customers over $${DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT}`,
          methodology: "Manual store-credit additions for customers whose Local Line customer export has Price Lists or Tags containing SNAP. Clear SNAP notes are also included, while produce notes such as snap peas are excluded.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => storeCreditMonthlyMap[month.start]?.snapCredit)
        },
        {
          label: "Manual Credit - Tom Culhane Cash Received",
          entry: "AUTO",
          source: `Local Line MANUAL_CREDIT for Tom Culhane at $${DASHBOARD_TOM_CULHANE_CASH_RECEIVED_AMOUNT}`,
          methodology: "Cash received from Tom Culhane and loaded as Local Line store credit. A matching Owners Equity Cash Credits line below NOI offsets this so the cash handling does not inflate final Net Profit.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => storeCreditMonthlyMap[month.start]?.tomCulhaneCashReceived)
        },
        ...creditsTabManualCreditCategoryRows,
        ...DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS.map((bucket) => ({
          label: bucket.label,
          entry: "AUTO",
          source: bucket.source,
          methodology: bucket.methodology,
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) =>
              getAdjustedManualCreditNoteBucketValue({
                creditsMonthlyMap,
                storeCreditMonthlyMap,
                monthStart: month.start,
                bucketKey: bucket.key
              })
            )
        })),
        {
          label: "Manual Credit - Uncategorized",
          entry: "AUTO",
          source: "Local Line MANUAL_CREDIT minus known member-bank credit buckets",
          methodology: "Remaining manual credit movement after automated, SNAP, Tom Culhane cash, Credits-tab detail, and adjusted Local Line note buckets are removed. This should be close to zero.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) =>
              getUncategorizedManualCreditValue({
                creditsMonthlyMap,
                storeCreditMonthlyMap,
                monthStart: month.start
              })
            )
        },
        {
          label: "Manual Debits",
          entry: "AUTO",
          source: "Local Line store-credit transactions: MANUAL_DEBIT",
          methodology: "Signed Local Line manual debits. These reduce member-bank balance.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => storeCreditMonthlyMap[month.start]?.manualDebitTotal)
        },
        {
          label: "Member Credit Used on Orders",
          entry: "AUTO",
          source: "Local Line store-credit transactions: ORDER_DEBIT",
          methodology: "Signed Local Line order debits. These reduce member-bank balance and are the source of truth for credit used on orders.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => storeCreditMonthlyMap[month.start]?.orderDebitTotal)
        },
        {
          label: "Member Bank Ledger Net Movement",
          entry: "AUTO",
          source: "Manual-credit component rows + Manual Debits + Member Credit Used on Orders",
          methodology: "Signed Local Line ledger movement for the period after automated, SNAP, Tom Culhane cash, Credits-tab manual credits, adjusted Local Line note buckets, remaining uncategorized manual credits, manual debits, and order debits are separated.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaSumRows(metricSheetRowsByLabel, memberBankLedgerComponentLabels, columnName)
        },
        {
          label: "Member Bank Closing Balance",
          entry: "AUTO",
          source: "Local Line customer Store Credit balance snapshot",
          methodology: "Closing balance is the latest Local Line customer Store Credit balance snapshot on or before the day after the period end.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodLatest(period, (month) => storeCreditMonthlyMap[month.start]?.closingBalance)
        },
        {
          label: "Member Bank Balance Change",
          entry: "AUTO",
          source: "Member Bank Closing Balance - Member Bank Opening Balance",
          methodology: "Actual balance change from Local Line customer Store Credit snapshots.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const openingRef = getMetricCellRef(metricSheetRowsByLabel, "Member Bank Opening Balance", columnName);
            const closingRef = getMetricCellRef(metricSheetRowsByLabel, "Member Bank Closing Balance", columnName);
            return openingRef && closingRef
              ? `=IF(OR(${openingRef}="",${closingRef}=""),"",${closingRef}-${openingRef})`
              : "";
          }
        },
        {
          label: "Unreconciled Balance Difference",
          entry: "AUTO",
          source: "Member Bank Balance Change - Member Bank Ledger Net Movement",
          methodology: "Snapshot-vs-ledger drift. This should stay very small; February 2026 was about -$2.15 in the Local Line audit.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const balanceChangeRef = getMetricCellRef(metricSheetRowsByLabel, "Member Bank Balance Change", columnName);
            const ledgerMovementRef = getMetricCellRef(metricSheetRowsByLabel, "Member Bank Ledger Net Movement", columnName);
            return balanceChangeRef && ledgerMovementRef
              ? `=IF(OR(${balanceChangeRef}="",${ledgerMovementRef}=""),"",${balanceChangeRef}-${ledgerMovementRef})`
              : "";
          }
        }
      ]
    },
    {
      section: "REVENUE DETAIL",
      rows: [
        {
          label: "Guest Purchase Dollars",
          entry: "AUTO",
          source: "Local Line guest price-list retail dollars",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) => monthlyKpiMap[month.start]?.guestPurchaseDollars)
        },
        {
          label: "Local Revenue Dollars",
          entry: "AUTO",
          source: "LL Revenue",
          valueType: "currency",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const llRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "LL Revenue", columnName);
            return llRevenueRef
              ? `=IF(${llRevenueRef}="","",${llRevenueRef})`
              : "";
          }
        },
        {
          label: "Local Purchase Dollars",
          entry: "AUTO",
          source: "ABS(Member Credit Used on Orders) + Guest Purchase Dollars",
          valueType: "currency",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const memberPurchasesRef = getMetricCellRef(metricSheetRowsByLabel, "Member Credit Used on Orders", columnName);
            const guestPurchasesRef = getMetricCellRef(metricSheetRowsByLabel, "Guest Purchase Dollars", columnName);
            return memberPurchasesRef && guestPurchasesRef
              ? `=IF(COUNTA(${memberPurchasesRef},${guestPurchasesRef})=0,"",ABS(${memberPurchasesRef})+${guestPurchasesRef})`
              : "";
          }
        },
        ...incomeLineRows
      ]
    },
    {
      section: "COGS",
      rows: [
        {
          label: "QBO Purchase Cost",
          entry: "AUTO",
          source: "QBO Cost of Goods Sold",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "cogs")
        },
        {
          label: "LL Purchase Cost",
          entry: "AUTO",
          source: "Local Line purchase cost from paid product order lines",
          valueType: "currency",
          bold: true,
          italic: true,
          periodAuto: (period) =>
            getPeriodSum(period, (month) => monthlyVendorMap[month.start]?.purchaseCost)
        },
        {
          label: "Purchasing Efficiency",
          entry: "AUTO",
          source: "LL Purchase Cost / QBO Purchase Cost",
          methodology: "Shows how much product cost was sold in Local Line compared with product cost purchased in QBO for the same period. Ideally this is 100%; lower numbers indicate less efficient purchasing. This line is more accurate across more months because purchase timing and sales timing do not always land in the same month.",
          valueType: "percent",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "LL Purchase Cost", "QBO Purchase Cost", columnName)
        }
      ]
    },
    {
      section: "GROSS PROFIT",
      rows: [
        {
          label: "Gross Profit",
          entry: "AUTO",
          source: "Total Revenue - QBO Purchase Cost",
          methodology: "Adjusted Gross Profit uses Total Revenue, including Credits tab trade revenue, minus QBO Purchase Cost / COGS.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const totalRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "Total Revenue", columnName);
            const qboPurchaseCostRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Purchase Cost", columnName);
            return totalRevenueRef && qboPurchaseCostRef
              ? `=IF(OR(${totalRevenueRef}="",${qboPurchaseCostRef}=""),"",${totalRevenueRef}-${qboPurchaseCostRef})`
              : "";
          }
        },
        {
          label: "QBO Gross Profit",
          entry: "AUTO",
          source: "QBO Gross Profit",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "grossProfit")
        },
        {
          label: "LL Gross Profit",
          entry: "AUTO",
          source: "LL Revenue - LL Purchase Cost",
          valueType: "currency",
          bold: true,
          italic: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const llRevenueRef = getMetricCellRef(metricSheetRowsByLabel, "LL Revenue", columnName);
            const llPurchaseCostRef = getMetricCellRef(metricSheetRowsByLabel, "LL Purchase Cost", columnName);
            return llRevenueRef && llPurchaseCostRef
              ? `=IF(OR(${llRevenueRef}="",${llPurchaseCostRef}=""),"",${llRevenueRef}-${llPurchaseCostRef})`
              : "";
          }
        },
        {
          label: "QBO GPPR %",
          entry: "AUTO",
          source: "QBO Gross Profit / QBO Revenue",
          valueType: "percent",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Gross Profit", "QBO Revenue", columnName)
        }
      ]
    },
    {
      section: "EXPENSES",
      rows: [
        {
          label: "QBO Payroll Employee Expenses",
          entry: "AUTO",
          source: "QBO Payroll Expenses regular employee category",
          methodology: "Regular employee payroll from QBO, including the Payroll Expenses category and employee bonus rows, excluding the Payroll Expenses Owner category.",
          valueType: "currency",
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "payrollEmployeeExpense")
        },
        {
          label: "QBO Payroll Employer Expenses",
          entry: "AUTO",
          source: "QBO Payroll Expenses Owner category",
          methodology: "Employer/owner payroll from QBO Payroll Expenses Owner, including Owner Wages and Owner Payroll Taxes.",
          valueType: "currency",
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "payrollEmployerExpense")
        },
        {
          label: "QBO Payroll Expenses",
          entry: "AUTO",
          source: "QBO Payroll Employee Expenses + QBO Payroll Employer Expenses",
          valueType: "currency",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const employeePayrollRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "QBO Payroll Employee Expenses",
              columnName
            );
            const employerPayrollRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "QBO Payroll Employer Expenses",
              columnName
            );
            return employeePayrollRef && employerPayrollRef
              ? `=IF(COUNTA(${employeePayrollRef},${employerPayrollRef})=0,"",${employeePayrollRef}+${employerPayrollRef})`
              : "";
          }
        },
        {
          label: "QBO Payroll % of Gross Profit",
          entry: "AUTO",
          source: "QBO Payroll Employee Expenses / Gross Profit",
          methodology: "Uses employee payroll only as the numerator, not employer payroll taxes/fees.",
          valueType: "percent",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Payroll Employee Expenses", "Gross Profit", columnName)
        },
        {
          label: "Marketing Trade Expense",
          entry: "AUTO",
          source: "Credits tab Type = Marketing",
          methodology: "Monthly total from the Credits tab for Marketing rows; treated as a trade expense in the adjusted dashboard profit story.",
          valueType: "currency",
          periodAuto: (period) => getCreditPeriodSum(period, "marketing")
        },
        {
          label: "Dropsite Host Credit",
          entry: "AUTO",
          source: "Credits tab Type = Dropsite Host Credit",
          methodology: "Monthly total from the Credits tab for Dropsite Host Credit rows; treated as a trade expense in the adjusted dashboard profit story.",
          valueType: "currency",
          periodAuto: (period) => getCreditPeriodSum(period, "dropsiteHostCredit")
        },
        {
          label: "Employee Benefit Trades",
          entry: "AUTO",
          source: "Credits tab Type = FFCSA Employee Credit",
          methodology: "Monthly total from the Credits tab for FFCSA Employee Credit rows; treated as an employee benefit trade expense in the adjusted dashboard profit story.",
          valueType: "currency",
          periodAuto: (period) => getCreditPeriodSum(period, "ffcsaEmployeeCredit")
        },
        ...expenseLineRows,
        {
          label: "QBO Expenses",
          entry: "AUTO",
          source: "QBO payroll expenses + QBO non-labor expense lines",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const refs = expenseComponentLabels
              .map((label) => getMetricCellRef(metricSheetRowsByLabel, label, columnName))
              .filter(Boolean);
            return refs.length ? `=IF(COUNTA(${refs.join(",")})=0,"",SUM(${refs.join(",")}))` : "";
          }
        },
        {
          label: "Total Expenses",
          entry: "AUTO",
          source: "QBO Expenses + Marketing Trade Expense + Dropsite Host Credit + Employee Benefit Trades",
          methodology: "Total Expenses starts with QBO Expenses and adds Credits tab trade expense rows for Marketing, Dropsite Host Credit, and FFCSA Employee Credit / Employee Benefit Trades.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const qboExpensesRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Expenses", columnName);
            const marketingTradeExpenseRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Marketing Trade Expense",
              columnName
            );
            const dropsiteHostCreditRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Dropsite Host Credit",
              columnName
            );
            const employeeBenefitTradesRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Employee Benefit Trades",
              columnName
            );
            return qboExpensesRef && marketingTradeExpenseRef && dropsiteHostCreditRef && employeeBenefitTradesRef
              ? `=IF(COUNTA(${qboExpensesRef},${marketingTradeExpenseRef},${dropsiteHostCreditRef},${employeeBenefitTradesRef})=0,"",${qboExpensesRef}+${marketingTradeExpenseRef}+${dropsiteHostCreditRef}+${employeeBenefitTradesRef})`
              : "";
          }
        }
      ]
    },
    {
      section: "NET OPERATING INCOME",
      rows: [
        {
          label: "Net Operating Income",
          entry: "AUTO",
          source: "Gross Profit - Total Expenses",
          methodology: "Adjusted NOI uses adjusted Gross Profit minus Total Expenses, including Credits tab trade expense rows.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const grossProfitRef = getMetricCellRef(metricSheetRowsByLabel, "Gross Profit", columnName);
            const totalExpensesRef = getMetricCellRef(metricSheetRowsByLabel, "Total Expenses", columnName);
            return grossProfitRef && totalExpensesRef
              ? `=IF(OR(${grossProfitRef}="",${totalExpensesRef}=""),"",${grossProfitRef}-${totalExpensesRef})`
              : "";
          }
        },
        {
          label: "QBO Net Operating Income",
          entry: "AUTO",
          source: "QBO Net Operating Income",
          methodology: "QBO Net Operating Income after revenue, COGS, and operating expenses. Owner payroll is still included in QBO expenses at this point.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "netOperatingIncome")
        }
      ]
    },
    {
      section: "OTHER INCOME / EXPENSES",
      rows: [
        {
          label: "QBO Other Income / Expenses",
          entry: "AUTO",
          source: "QBO Net Income - QBO Net Operating Income",
          methodology: "Net total of QBO other income and other expenses below operating income.",
          valueType: "currency",
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "otherIncomeExpenses")
        },
        {
          label: "QBO Payroll Expenses Owner Addback",
          entry: "AUTO",
          source: "QBO Payroll Expenses Owner",
          methodology: "Adds back QBO Payroll Expenses Owner, including Owner Wages and Owner Payroll Taxes, so owner payroll is not treated as an operating deduction in the final dashboard profit line.",
          valueType: "currency",
          periodAuto: (period) => getDashboardQboMetric(qboPeriodMap, period, "ownerPayrollExpense")
        },
        {
          label: "Owners Equity Credits",
          entry: "AUTO",
          source: "Credits tab Type = Owners Equity",
          methodology: "Monthly total from the Credits tab for Owners Equity rows; treated as an income adjustment added back below Net Operating Income.",
          valueType: "currency",
          periodAuto: (period) => getCreditPeriodSum(period, "ownersEquity")
        },
        {
          label: "Owners Equity Cash Credits",
          entry: "AUTO",
          source: "Offset for Manual Credit - Tom Culhane Cash Received",
          methodology: "Negative offset for Tom Culhane cash received that was used for owners equity. This balances the manual-credit revenue line so those cash loads do not inflate final Net Profit.",
          valueType: "currency",
          periodAuto: (period) =>
            getPeriodSum(period, (month) =>
              -Number(storeCreditMonthlyMap[month.start]?.tomCulhaneCashReceived || 0)
            )
        },
        {
          label: "Total Other Income / Expenses",
          entry: "AUTO",
          source: "QBO Other Income / Expenses + QBO Payroll Expenses Owner Addback + Owners Equity Credits + Owners Equity Cash Credits",
          methodology: "This is the total income-adjustment/add-back pool below NOI. QBO other income/expenses, owner payroll addback, and Owners Equity Credits are added back; Owners Equity Cash Credits offsets Tom Culhane cash received.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const ownersEquityCreditsRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Owners Equity Credits",
              columnName
            );
            const otherIncomeExpensesRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "QBO Other Income / Expenses",
              columnName
            );
            const ownerPayrollAddbackRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "QBO Payroll Expenses Owner Addback",
              columnName
            );
            const ownersEquityCashCreditsRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Owners Equity Cash Credits",
              columnName
            );
            return ownersEquityCreditsRef && otherIncomeExpensesRef && ownerPayrollAddbackRef && ownersEquityCashCreditsRef
              ? `=IF(COUNTA(${otherIncomeExpensesRef},${ownerPayrollAddbackRef},${ownersEquityCreditsRef},${ownersEquityCashCreditsRef})=0,"",${otherIncomeExpensesRef}+${ownerPayrollAddbackRef}+${ownersEquityCreditsRef}+${ownersEquityCashCreditsRef})`
              : "";
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
          source: "Net Operating Income + Total Other Income / Expenses",
          methodology: "Net Profit uses the adjusted dashboard story: Total Revenue minus QBO Purchase Cost equals Gross Profit; Total Expenses are subtracted to get NOI; Total Other Income / Expenses is then added back to NOI.",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const netOperatingIncomeRef = getMetricCellRef(metricSheetRowsByLabel, "Net Operating Income", columnName);
            const totalOtherIncomeExpensesRef = getMetricCellRef(
              metricSheetRowsByLabel,
              "Total Other Income / Expenses",
              columnName
            );
            return netOperatingIncomeRef && totalOtherIncomeExpensesRef
              ? `=IF(OR(${netOperatingIncomeRef}="",${totalOtherIncomeExpensesRef}=""),"",${netOperatingIncomeRef}+${totalOtherIncomeExpensesRef})`
              : "";
          }
        },
        {
          label: "Net Profit as % of Revenue",
          entry: "AUTO",
          source: "Net Profit / Total Revenue",
          valueType: "percent",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "Net Profit", "Total Revenue", columnName)
        }
      ]
    }
  ];

  const values = [];
  const metricRows = [];
  const sectionRows = [];
  const metricSheetRowsByLabel = buildMetricSheetRowsByLabel(layout);
  const now = generatedAt.toISOString().replace("T", " ").slice(0, 19);

  values.push([
    "FFCSA Dashboard 2026 v2",
    `Updated ${now}`,
    "",
    "",
    ...periods.map(() => "")
  ]);
  values.push([
    "Section",
    "Metric",
    "Entry Type",
    "Source",
    ...periods.map((period) => formatDashboardHeaderLabel(period.label))
  ]);

  for (const group of layout) {
    sectionRows.push(values.length);
    values.push([group.section, "", "", "", ...periods.map(() => "")]);
    for (const row of group.rows) {
      const nextRow = ["", row.label, row.entry, row.source];
      for (let index = 0; index < periods.length; index += 1) {
        const period = periods[index];
        const columnName = getSheetColumnName(DASHBOARD_STATIC_COLUMN_COUNT + index);
        if (typeof row.periodFormula === "function") {
          nextRow.push(
            row.periodFormula({
              period,
              periodIndex: index,
              columnName,
              metricSheetRowsByLabel
            })
          );
        } else if (typeof row.periodAuto === "function") {
          nextRow.push(normalizeAutoValue(row.valueType, row.periodAuto(period, index)));
        } else {
          nextRow.push("");
        }
      }
      metricRows.push({
        rowIndex: values.length,
        valueType: row.valueType || null,
        entry: row.entry,
        bold: Boolean(row.bold),
        italic: Boolean(row.italic),
        note: buildMetricMethodologyNote(row)
      });
      values.push(nextRow);
    }
  }

  return {
    values,
    metricRows,
    sectionRows,
    packWagesSalesChart: null,
    periodCount: periods.length,
    monthCount: months.length
  };
}

function buildQboDashboardRows({
  weeks = [],
  manualValueMap,
  weeklyKpiMap = {},
  timesheetWeeklyMap = {},
  subscriberWeeklyMap = {},
  summaryPeriods = [],
  qboPeriodMap = {},
  qboWeeklyMap = {},
  generatedAt = new Date()
} = {}) {
  const resolvedSummaryPeriods = summaryPeriods.length
    ? summaryPeriods
    : buildDashboardSummaryPeriods(weeks);
  const resolvedQboWeeklyMap = qboWeeklyMap || qboPeriodMap || {};
  const getQboMetricFromMap = (map, period, metricKey) => {
    const metrics = map?.[period?.key] || null;
    const value = metrics?.[metricKey];
    return value === null || typeof value === "undefined" ? null : Number(value);
  };
  const getQboMetric = (period, metricKey) => getQboMetricFromMap(qboPeriodMap, period, metricKey);
  const getQboWeekMetric = (week, metricKey) =>
    getQboMetricFromMap(resolvedQboWeeklyMap, { key: `week:${week.start}` }, metricKey);
  const formulaDivide = (metricSheetRowsByLabel, numeratorLabel, denominatorLabel, columnName) => {
    const numeratorRef = getMetricCellRef(metricSheetRowsByLabel, numeratorLabel, columnName);
    const denominatorRef = getMetricCellRef(metricSheetRowsByLabel, denominatorLabel, columnName);
    return numeratorRef && denominatorRef
      ? `=IFERROR(${numeratorRef}/${denominatorRef},"")`
      : "";
  };

  const layout = [
    {
      section: "GIVENS",
      rows: [
        {
          label: "Errors/week",
          entry: "MANUAL",
          source: "Manual QA",
          rowLabel: "Errors/week",
          valueType: "int",
          periodAuto: (period) => sumPeriodManualValues(weeks, period, manualValueMap, "Errors/week")
        },
        {
          label: "Positive responses/week",
          entry: "MANUAL",
          source: "Manual QA",
          rowLabel: "Positive responses/week",
          valueType: "int",
          periodAuto: (period) =>
            sumPeriodManualValues(weeks, period, manualValueMap, "Positive responses/week")
        },
        {
          label: "New Subscribers",
          entry: "AUTO",
          source: "Subscriber export Created dates",
          valueType: "int",
          periodAuto: (period) =>
            sumPeriodWeekValues(weeks, period, (week) =>
              subscriberWeeklyMap[week.start]?.newSubscribers
            ),
          weekAuto: (week) => subscriberWeeklyMap[week.start]?.newSubscribers
        },
        {
          label: "Exiting Subscribers",
          entry: "AUTO",
          source: "Subscriber export Cancelled Date values",
          valueType: "int",
          periodAuto: (period) =>
            sumPeriodWeekValues(weeks, period, (week) =>
              subscriberWeeklyMap[week.start]?.exitingSubscribers
            ),
          weekAuto: (week) => subscriberWeeklyMap[week.start]?.exitingSubscribers
        },
        {
          label: "SNAP subscribers",
          entry: "AUTO",
          source: "Local Line SNAP price-list members",
          methodology: "Counts distinct customers currently assigned to the Local Line SNAP price list. The SNAP price list is read from LL_PRICE_LIST_SNAP_ID, or DASHBOARD_SNAP_PRICE_LIST_ID when set, and refreshed during subscriber sync and dashboard publish.",
          valueType: "int",
          periodAuto: (period) =>
            latestPeriodWeekValue(weeks, period, (week) =>
              subscriberWeeklyMap[week.start]?.snapSubscribers
            ),
          weekAuto: (week) => subscriberWeeklyMap[week.start]?.snapSubscribers
        },
        {
          label: "Total Subscribers",
          entry: "AUTO",
          source: "Subscriber export active as of week end + Local Line SNAP price-list members",
          methodology: "Adds active subscribers from the Local Line subscription snapshot for the week end to the current Local Line SNAP price-list member count.",
          valueType: "int",
          periodAuto: (period) =>
            latestPeriodWeekValue(weeks, period, (week) =>
              subscriberWeeklyMap[week.start]?.totalSubscribers
            ),
          weekAuto: (week) => subscriberWeeklyMap[week.start]?.totalSubscribers
        }
      ]
    },
    {
      section: "FORMULAS",
      rows: [
        {
          label: "Revenue",
          entry: "FORMULA",
          source: "QBO Revenue = QuickBooks Online Total Income. Member-bank movement is tracked separately and is not added into revenue.",
          boxed: true
        },
        {
          label: "COGS",
          entry: "FORMULA",
          source: "QBO Product Purchases / COGS = QuickBooks Online Cost of Goods Sold.",
          boxed: true
        },
        {
          label: "Gross Profit",
          entry: "FORMULA",
          source: "QBO Gross Profit = QBO Revenue - QBO Product Purchases / COGS.",
          boxed: true
        },
        {
          label: "Gross Margin %",
          entry: "FORMULA",
          source: "QBO Gross Margin % = QBO Gross Profit / QBO Revenue.",
          boxed: true
        },
        {
          label: "% Wages to Gross Profit",
          entry: "FORMULA",
          source: "% Wages to Gross Profit = Timesheet Wages / QBO Gross Profit.",
          boxed: true
        },
        {
          label: "Net Margin %",
          entry: "FORMULA",
          source: "QBO Net Margin % = QBO Net Income / QBO Revenue.",
          boxed: true
        }
      ]
    },
    {
      section: "REVENUE",
      rows: [
        {
          label: "QBO Revenue",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          methodology: "QBO Total Income for the same summary period.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getQboMetric(period, "income"),
          weekAuto: (week) => getQboWeekMetric(week, "income")
        },
        {
          label: "QBO Member Payments",
          entry: "AUTO",
          source: "QuickBooks Online Member Payments account",
          methodology: "Extracts the Member Payments account line from the QBO P&L.",
          valueType: "currency",
          periodAuto: (period) => getQboMetric(period, "memberPayments"),
          weekAuto: (week) => getQboWeekMetric(week, "memberPayments")
        },
        {
          label: "Member Payments % of Revenue",
          entry: "AUTO",
          source: "QBO Member Payments / QBO Revenue",
          valueType: "percent",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Member Payments", "QBO Revenue", columnName),
          weekFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Member Payments", "QBO Revenue", columnName)
        }
      ]
    },
    {
      section: "COGS",
      rows: [
        {
          label: "QBO Product Purchases / COGS",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          methodology: "QBO Cost of Goods Sold, currently Product Purchases.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getQboMetric(period, "cogs"),
          weekAuto: (week) => getQboWeekMetric(week, "cogs")
        }
      ]
    },
    {
      section: "GROSS PROFIT",
      rows: [
        {
          label: "QBO Gross Profit",
          entry: "AUTO",
          source: "QBO Revenue - QBO Product Purchases / COGS",
          valueType: "currency",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const revenueRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Revenue", columnName);
            const cogsRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Product Purchases / COGS", columnName);
            return revenueRef && cogsRef ? `=IFERROR(${revenueRef}-${cogsRef},"")` : "";
          },
          weekFormula: ({ columnName, metricSheetRowsByLabel }) => {
            const revenueRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Revenue", columnName);
            const cogsRef = getMetricCellRef(metricSheetRowsByLabel, "QBO Product Purchases / COGS", columnName);
            return revenueRef && cogsRef ? `=IFERROR(${revenueRef}-${cogsRef},"")` : "";
          }
        },
        {
          label: "QBO Gross Margin %",
          entry: "AUTO",
          source: "QBO Gross Profit / QBO Revenue",
          valueType: "percent",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Gross Profit", "QBO Revenue", columnName),
          weekFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Gross Profit", "QBO Revenue", columnName)
        }
      ]
    },
    {
      section: "EXPENSES",
      rows: [
        {
          label: "QBO Operating Expenses",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          methodology: "QBO Total Expenses for the same summary period.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getQboMetric(period, "expenses"),
          weekAuto: (week) => getQboWeekMetric(week, "expenses")
        },
        {
          label: "Timesheet Wages",
          entry: "AUTO",
          source: "Timesheets DB (FFCSA wages + fringe total)",
          valueType: "currency",
          periodAuto: (period) =>
            sumPeriodWeekValues(weeks, period, (week) =>
              Number(timesheetWeeklyMap[week.start]?.totalWages || 0)
            ),
          weekAuto: (week) => Number(timesheetWeeklyMap[week.start]?.totalWages || 0)
        },
        {
          label: "% Wages to Gross Profit",
          entry: "AUTO",
          source: "Timesheet Wages / QBO Gross Profit",
          valueType: "percent",
          bold: true,
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "Timesheet Wages", "QBO Gross Profit", columnName),
          weekFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "Timesheet Wages", "QBO Gross Profit", columnName)
        }
      ]
    },
    {
      section: "MEMBER BANK",
      rows: [
        {
          label: "Member Bank Growth",
          entry: "AUTO",
          source: "Local Line member-bank balance change; tracked separately from QBO revenue.",
          methodology: "Calculated from Local Line customer store-credit balance snapshots. This row shows liability growth/change and is intentionally not included in QBO Revenue.",
          valueType: "currency",
          boxed: true,
          periodAuto: (period) =>
            sumPeriodWeekValues(weeks, period, (week) =>
              weeklyKpiMap[week.start]?.memberBankBalanceChange
            ),
          weekAuto: (week) => weeklyKpiMap[week.start]?.memberBankBalanceChange
        },
        {
          label: "Member Bank Value",
          entry: "AUTO",
          source: "Local Line member-bank balance value; tracked separately from QBO revenue.",
          methodology: "Total store-credit liability from Local Line customer balance snapshots. Summary columns use the latest value in the period.",
          valueType: "currency",
          boxed: true,
          periodAuto: (period) =>
            latestPeriodWeekValue(weeks, period, (week) =>
              weeklyKpiMap[week.start]?.memberBankBalance
            ),
          weekAuto: (week) => weeklyKpiMap[week.start]?.memberBankBalance
        }
      ]
    },
    {
      section: "NET INCOME",
      rows: [
        {
          label: "QBO Net Income",
          entry: "AUTO",
          source: "QuickBooks Online cash-basis Profit and Loss",
          methodology: "QBO Net Income from the P&L. This remains sourced from QBO instead of recomputed so other income or account-specific QBO behavior is preserved.",
          valueType: "currency",
          bold: true,
          periodAuto: (period) => getQboMetric(period, "netIncome"),
          weekAuto: (week) => getQboWeekMetric(week, "netIncome")
        },
        {
          label: "QBO Net Margin %",
          entry: "AUTO",
          source: "QBO Net Income / QBO Revenue",
          valueType: "percent",
          periodFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Net Income", "QBO Revenue", columnName),
          weekFormula: ({ columnName, metricSheetRowsByLabel }) =>
            formulaDivide(metricSheetRowsByLabel, "QBO Net Income", "QBO Revenue", columnName)
        }
      ]
    }
  ];

  const values = [];
  const metricRows = [];
  const sectionRows = [];
  const metricSheetRowsByLabel = buildMetricSheetRowsByLabel(layout);
  const weekStartColumnIndex = DASHBOARD_STATIC_COLUMN_COUNT + resolvedSummaryPeriods.length;
  const now = generatedAt.toISOString().replace("T", " ").slice(0, 19);
  values.push([
    "FFCSA QBO Dashboard 2026",
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
    ...weeks.map((week) => week.label)
  ]);

  const getPeriodRowValue = (row, period, periodIndex) => {
    if (!period?.started) return "";
    const columnName = getSheetColumnName(4 + periodIndex);
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
    return "";
  };
  const getWeekRowValue = (row, week, weekIndex) => {
    const columnName = getSheetColumnName(weekStartColumnIndex + weekIndex);
    if (typeof row.weekFormula === "function") {
      return row.weekFormula({
        week,
        weekIndex,
        columnName,
        metricSheetRowsByLabel
      });
    }
    if (typeof row.weekAuto === "function") {
      return normalizeAutoValue(row.valueType, row.weekAuto(week, weekIndex));
    }
    if (typeof row.weekValue === "function") {
      return row.weekValue(week, weekIndex);
    }
    if (row.entry === "MANUAL") {
      return getManualSourceValue(manualValueMap, row.rowLabel || row.label, week.start);
    }
    return "";
  };

  for (const group of layout) {
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
      const nextRow = ["", row.label, row.entry, row.source];
      for (let index = 0; index < resolvedSummaryPeriods.length; index += 1) {
        nextRow.push(getPeriodRowValue(row, resolvedSummaryPeriods[index], index));
      }
      for (let index = 0; index < weeks.length; index += 1) {
        nextRow.push(getWeekRowValue(row, weeks[index], index));
      }
      metricRows.push({
        rowIndex: values.length,
        valueType: row.valueType || null,
        entry: row.entry,
        bold: Boolean(row.bold),
        note: buildMetricMethodologyNote(row),
        boxed: Boolean(row.boxed)
      });
      values.push(nextRow);
    }
  }

  return {
    values,
    metricRows,
    sectionRows,
    packWagesSalesChart: null,
    weekStartColumnIndex
  };
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

function getCustomerExportCustomerId(row = {}) {
  const value =
    row["Customer ID"] ??
    row["Customer Id"] ??
    row["Customer id"] ??
    row.customer_id ??
    row.id ??
    "";
  const normalized = String(value || "").trim();
  return normalized || null;
}

function getCustomerExportEmail(row = {}) {
  const email = String(row.Email ?? row.email ?? "").trim().toLowerCase();
  return email || null;
}

function getCustomerExportName(row = {}) {
  const name = String(row.Customer ?? row.customer ?? row.name ?? "").trim();
  return name || null;
}

function getCustomerExportSnapFields(row = {}) {
  return [
    row["Price Lists"],
    row["Price List"],
    row.price_lists,
    row.priceLists,
    row.Tags,
    row.tags
  ];
}

function isSnapCustomerExportRow(row = {}) {
  return getCustomerExportSnapFields(row)
    .map((value) => {
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            const text = item?.name ?? item?.price_list ?? item?.priceList ?? item;
            return String(text || "");
          })
          .join(" ");
      }
      return String(value || "");
    })
    .some((value) => normalizeDashboardText(value).includes("snap"));
}

function buildStoreCreditSnapCustomerLookup(customers = []) {
  const lookup = {
    ids: new Set(),
    emails: new Set(),
    names: new Set()
  };
  customers.forEach((customer) => {
    if (!customer?.isSnapCustomer) return;
    if (customer.customerId) lookup.ids.add(String(customer.customerId));
    if (customer.email) lookup.emails.add(String(customer.email).trim().toLowerCase());
    if (customer.customerName) lookup.names.add(normalizeDashboardText(customer.customerName));
  });
  return lookup;
}

function isStoreCreditSnapCustomer(customer = {}, snapCustomerLookup = {}) {
  const customerId = String(customer.customerId || "").trim();
  if (customerId && snapCustomerLookup.ids?.has(customerId)) return true;
  const email = String(customer.email || "").trim().toLowerCase();
  if (email && snapCustomerLookup.emails?.has(email)) return true;
  const name = normalizeDashboardText(customer.customerName);
  return Boolean(name && snapCustomerLookup.names?.has(name));
}

async function fetchLocalLineCustomerCreditRows() {
  const accessToken = await getLocalLineAccessToken();
  const buffer = await downloadBinaryFile(
    `${getLocalLineBaseUrl()}customers/export/?direct=true`,
    accessToken
  );
  return parseRowsFromBuffer(buffer);
}

async function fetchLocalLineCustomerCreditSummary() {
  const rows = await fetchLocalLineCustomerCreditRows();
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

function getStoreCreditTransactionId(transaction = {}) {
  const value =
    transaction.id ??
    transaction.uuid ??
    transaction.reference ??
    transaction.transaction_id ??
    null;
  return value === null || typeof value === "undefined" || value === "" ? null : String(value);
}

function getStoreCreditTransactionDateRaw(transaction = {}) {
  return (
    transaction.created_at ||
    transaction.createdAt ||
    transaction.transaction_date ||
    transaction.transactionDate ||
    transaction.effective_date ||
    transaction.effectiveDate ||
    ""
  );
}

function getStoreCreditTransactionType(transaction = {}) {
  return String(
    transaction.transaction_type ||
      transaction.transactionType ||
      transaction.type ||
      "UNKNOWN"
  ).trim().toUpperCase();
}

function getStoreCreditTransactionAmount(transaction = {}) {
  return round2(
    Number(
      transaction.amount ??
        transaction.amount_total ??
        transaction.amountTotal ??
        0
    ) || 0
  );
}

function getStoreCreditTransactionBalance(transaction = {}) {
  const value =
    transaction.store_credit_balance ??
    transaction.storeCreditBalance ??
    transaction.balance ??
    transaction.current_balance ??
    transaction.currentBalance ??
    null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round2(numeric) : null;
}

function getStoreCreditTransactionOrderId(transaction = {}) {
  const value =
    transaction.order ??
    transaction.order_id ??
    transaction.orderId ??
    transaction.local_line_order_id ??
    null;
  return value === null || typeof value === "undefined" || value === "" ? null : String(value);
}

function getStoreCreditTransactionNote(transaction = {}) {
  const note = String(transaction.note ?? transaction.description ?? "").trim();
  return note || null;
}

function isSnapPaymentStoreCreditNote(note) {
  const normalized = normalizeDashboardText(note);
  if (!normalized || normalized.includes("snap peas") || normalized.includes("sugar snap")) {
    return false;
  }
  return /\bsnap\b/.test(normalized);
}

function shouldClassifyAsSnapStoreCredit(transaction = {}, options = {}) {
  const amount = Math.abs(getStoreCreditTransactionAmount(transaction));
  if (amount <= DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT) return false;
  if (isStoreCreditSnapCustomer(options.customer, options.snapCustomerLookup)) return true;
  return isSnapPaymentStoreCreditNote(getStoreCreditTransactionNote(transaction));
}

function classifyManualCreditNoteBucket(note) {
  const normalized = normalizeDashboardText(note);
  if (!normalized) {
    return {
      key: "blankManualCredit",
      label: "Manual Credit - Blank / Unlabeled"
    };
  }
  if (
    normalized.includes("jar") ||
    normalized.includes("bottle") ||
    normalized.includes("deposit") ||
    normalized.includes("container")
  ) {
    return {
      key: "jarDepositReturnCredit",
      label: "Manual Credit - Jar / Deposit Returns"
    };
  }
  if (normalized.includes("host")) {
    return {
      key: "hostCredit",
      label: "Manual Credit - Host Credits"
    };
  }
  if (
    /refund|return|missing|not received|credit for|wrong|damaged|quality|cancel|reimburse|short|out of stock|not delivered|broken/.test(
      normalized
    )
  ) {
    return {
      key: "productIssueRefundCredit",
      label: "Manual Credit - Product Issue / Refunds"
    };
  }
  if (
    /farm stay|camp|influencer|trade|gift|nancy|employee|approved|cash payment|store credit|payment|invoice|monthly credit|landing page|successful charge|sent by check|charge|cash|check/.test(
      normalized
    )
  ) {
    return {
      key: "paymentTradeAdminCredit",
      label: "Manual Credit - Payment / Trade / Admin Notes"
    };
  }
  return {
    key: "productItemCredit",
    label: "Manual Credit - Product / Item Credits"
  };
}

function isTomCulhaneCashReceivedTransaction(customer = {}, transaction = {}) {
  const amount = Number(getStoreCreditTransactionAmount(transaction));
  if (Math.abs(amount - DASHBOARD_TOM_CULHANE_CASH_RECEIVED_AMOUNT) > 0.005) return false;
  const email = normalizeDashboardText(customer.email);
  if (email && email === DASHBOARD_TOM_CULHANE_CASH_RECEIVED_EMAIL) return true;
  const name = normalizeDashboardText(customer.customerName);
  return Boolean(name && name === DASHBOARD_TOM_CULHANE_CASH_RECEIVED_NAME);
}

function classifyLocalLineStoreCreditTransaction(transaction = {}, options = {}) {
  const type = getStoreCreditTransactionType(transaction);
  const note = normalizeDashboardText(getStoreCreditTransactionNote(transaction));
  if (type === "MANUAL_CREDIT" && note === "automated monthly subscription addition") {
    return {
      key: "automatedSubscriptionCredit",
      label: "Manual Credit - Automated Subscription Credits"
    };
  }
  if (type === "MANUAL_CREDIT" && isTomCulhaneCashReceivedTransaction(options.customer, transaction)) {
    return {
      key: "tomCulhaneCashReceived",
      label: "Manual Credit - Tom Culhane Cash Received"
    };
  }
  if (type === "MANUAL_CREDIT" && shouldClassifyAsSnapStoreCredit(transaction, options)) {
    return {
      key: "snapCredit",
      label: "Manual Credit - SNAP Payments"
    };
  }
  if (type === "MANUAL_CREDIT") {
    return classifyManualCreditNoteBucket(getStoreCreditTransactionNote(transaction));
  }
  if (type === "MANUAL_DEBIT") {
    return {
      key: "manualDebit",
      label: "Manual Debits"
    };
  }
  if (type === "ORDER_DEBIT") {
    return {
      key: "orderDebit",
      label: "Member Credit Used on Orders"
    };
  }
  return {
    key: slugifyDashboardKey(type, "otherStoreCreditActivity"),
    label: titleCaseDashboardLabel(type)
  };
}

function buildStoreCreditCustomerFromExportRow(row = {}) {
  const customerId = getCustomerExportCustomerId(row);
  if (!customerId) return null;
  return {
    customerId,
    customerName: getCustomerExportName(row),
    email: getCustomerExportEmail(row),
    storeCreditBalance: getCustomerStoreCreditAmount(row),
    isSnapCustomer: isSnapCustomerExportRow(row),
    rawJson: stringifyJson(row)
  };
}

function buildStoreCreditTransactionRecord(customer, transaction, runId, options = {}) {
  const transactionId = getStoreCreditTransactionId(transaction);
  if (!transactionId) return null;
  const rawDate = getStoreCreditTransactionDateRaw(transaction);
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const transactionDate = String(rawDate || "").slice(0, 10) || toYmdFromDateish(parsedDate);
  const transactionMonth = transactionDate ? `${transactionDate.slice(0, 7)}-01` : null;
  const category = classifyLocalLineStoreCreditTransaction(transaction, {
    ...options,
    customer
  });
  return {
    transactionId,
    customerId: customer.customerId,
    customerName: customer.customerName,
    email: customer.email,
    transactionAt:
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? formatMysqlDateTime(parsedDate) : null,
    transactionDate,
    transactionMonth,
    transactionType: getStoreCreditTransactionType(transaction),
    categoryKey: category.key,
    categoryLabel: category.label,
    amount: getStoreCreditTransactionAmount(transaction),
    storeCreditBalance: getStoreCreditTransactionBalance(transaction),
    orderId: getStoreCreditTransactionOrderId(transaction),
    note: getStoreCreditTransactionNote(transaction),
    rawJson: stringifyJson(transaction),
    lastSyncedRunId: runId
  };
}

function chunkDashboardRows(rows = [], size = 200) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

async function insertStoreCreditSyncRun(connection, {
  year,
  startDate,
  endExclusiveDate
}) {
  const now = new Date();
  const [result] = await connection.query(
    `
      INSERT INTO local_line_store_credit_sync_runs (
        sync_year,
        start_date,
        end_exclusive_date,
        status,
        started_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?)
    `,
    [year, startDate, endExclusiveDate, now, now, now]
  );
  return Number(result?.insertId || 0);
}

async function updateStoreCreditSyncRun(connection, runId, values = {}) {
  if (!runId) return;
  const now = new Date();
  await connection.query(
    `
      UPDATE local_line_store_credit_sync_runs
      SET status = ?,
          customer_count = ?,
          transaction_count = ?,
          manual_credit_total = ?,
          manual_debit_total = ?,
          order_debit_total = ?,
          summary_json = ?,
          error_message = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [
      values.status || "completed",
      Number(values.customerCount || 0),
      Number(values.transactionCount || 0),
      round2(values.manualCreditTotal || 0),
      round2(values.manualDebitTotal || 0),
      round2(values.orderDebitTotal || 0),
      values.summaryJson ?? null,
      values.errorMessage ?? null,
      values.finishedAt ?? now,
      now,
      runId
    ]
  );
}

async function loadStoreCreditCustomerCursors(connection) {
  const [rows] = await connection.query(
    `
      SELECT
        customer_id AS customerId,
        last_transaction_id AS lastTransactionId,
        last_transaction_at AS lastTransactionAt
      FROM local_line_store_credit_customer_cursors
    `
  );
  return new Map((rows || []).map((row) => [String(row.customerId), row]));
}

async function upsertStoreCreditBalanceSnapshotRows(connection, {
  snapshotDate,
  customers,
  runId,
  capturedAt = new Date()
}) {
  if (!snapshotDate || !customers.length) return;
  await connection.query(
    `DELETE FROM local_line_store_credit_balance_snapshots WHERE snapshot_date = ?`,
    [snapshotDate]
  );
  for (const chunk of chunkDashboardRows(customers, 200)) {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = [];
    chunk.forEach((customer) => {
      values.push(
        snapshotDate,
        customer.customerId,
        customer.customerName,
        customer.email,
        customer.storeCreditBalance,
        customer.rawJson,
        runId || null,
        capturedAt,
        capturedAt,
        capturedAt
      );
    });
    await connection.query(
      `
        INSERT INTO local_line_store_credit_balance_snapshots (
          snapshot_date,
          customer_id,
          customer_name,
          email,
          store_credit_balance,
          raw_json,
          run_id,
          captured_at,
          created_at,
          updated_at
        ) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          customer_name = VALUES(customer_name),
          email = VALUES(email),
          store_credit_balance = VALUES(store_credit_balance),
          raw_json = VALUES(raw_json),
          run_id = VALUES(run_id),
          captured_at = VALUES(captured_at),
          updated_at = VALUES(updated_at)
      `,
      values
    );
  }
}

async function upsertStoreCreditTransactions(connection, records = []) {
  const validRecords = records.filter((record) => record?.transactionId);
  if (!validRecords.length) return;
  for (const chunk of chunkDashboardRows(validRecords, 200)) {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = [];
    const now = new Date();
    chunk.forEach((record) => {
      values.push(
        record.transactionId,
        record.customerId,
        record.customerName,
        record.email,
        record.transactionAt,
        record.transactionDate,
        record.transactionMonth,
        record.transactionType,
        record.categoryKey,
        record.categoryLabel,
        record.amount,
        record.storeCreditBalance,
        record.orderId,
        record.note,
        record.rawJson,
        record.lastSyncedRunId || null,
        now,
        now
      );
    });
    await connection.query(
      `
        INSERT INTO local_line_store_credit_transactions (
          transaction_id,
          customer_id,
          customer_name,
          email,
          transaction_at,
          transaction_date,
          transaction_month,
          transaction_type,
          category_key,
          category_label,
          amount,
          store_credit_balance,
          order_id,
          note,
          raw_json,
          last_synced_run_id,
          created_at,
          updated_at
        ) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          customer_id = VALUES(customer_id),
          customer_name = VALUES(customer_name),
          email = VALUES(email),
          transaction_at = VALUES(transaction_at),
          transaction_date = VALUES(transaction_date),
          transaction_month = VALUES(transaction_month),
          transaction_type = VALUES(transaction_type),
          category_key = VALUES(category_key),
          category_label = VALUES(category_label),
          amount = VALUES(amount),
          store_credit_balance = VALUES(store_credit_balance),
          order_id = VALUES(order_id),
          note = VALUES(note),
          raw_json = VALUES(raw_json),
          last_synced_run_id = VALUES(last_synced_run_id),
          updated_at = VALUES(updated_at)
      `,
      values
    );
  }
}

async function upsertStoreCreditCustomerCursor(connection, {
  customer,
  latestRecord = null,
  fetchedCount = 0,
  error = null
}) {
  const now = new Date();
  await connection.query(
    `
      INSERT INTO local_line_store_credit_customer_cursors (
        customer_id,
        customer_name,
        email,
        last_transaction_id,
        last_transaction_at,
        last_synced_at,
        transaction_count,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        customer_name = VALUES(customer_name),
        email = VALUES(email),
        last_transaction_id = COALESCE(VALUES(last_transaction_id), last_transaction_id),
        last_transaction_at = COALESCE(VALUES(last_transaction_at), last_transaction_at),
        last_synced_at = VALUES(last_synced_at),
        transaction_count = transaction_count + VALUES(transaction_count),
        last_error = VALUES(last_error),
        updated_at = VALUES(updated_at)
    `,
    [
      customer.customerId,
      customer.customerName,
      customer.email,
      latestRecord?.transactionId || null,
      latestRecord?.transactionAt || null,
      now,
      Number(fetchedCount || 0),
      error ? String(error?.message || error) : null,
      now,
      now
    ]
  );
}

async function fetchStoreCreditTransactionsForCustomer(customer, accessToken, {
  startDate,
  endExclusiveDate,
  latestImportedAt = null,
  runId,
  snapCustomerLookup = null
}) {
  const latestImportedTime = latestImportedAt ? new Date(latestImportedAt).getTime() : null;
  const records = [];
  let page = 1;
  let keepGoing = true;

  while (keepGoing && page <= 100) {
    const payload = await downloadLocalLineJson(
      `customers/${encodeURIComponent(customer.customerId)}/store-credit-transaction/?page=${page}&page_size=${DASHBOARD_STORE_CREDIT_SYNC_PAGE_SIZE}`,
      accessToken,
      `Local Line store-credit transactions for customer ${customer.customerId}`
    );
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (!results.length) break;

    let allRowsOlderThanSyncStart = true;
    let allRowsAlreadyImported = Boolean(latestImportedTime);
    for (const transaction of results) {
      const rawDate = getStoreCreditTransactionDateRaw(transaction);
      const transactionDate = toYmdFromDateish(rawDate);
      const transactionTime = rawDate ? new Date(rawDate).getTime() : NaN;
      if (!transactionDate) {
        allRowsOlderThanSyncStart = false;
      } else if (transactionDate >= startDate) {
        allRowsOlderThanSyncStart = false;
      }

      if (!Number.isFinite(transactionTime)) {
        allRowsAlreadyImported = false;
        continue;
      }
      const shouldImportForCursor = !latestImportedTime || transactionTime >= latestImportedTime;
      if (shouldImportForCursor) {
        allRowsAlreadyImported = false;
      }
      if (
        shouldImportForCursor &&
        transactionDate &&
        transactionDate >= startDate &&
        transactionDate < endExclusiveDate
      ) {
        const record = buildStoreCreditTransactionRecord(customer, transaction, runId, {
          snapCustomerLookup
        });
        if (record) records.push(record);
      }
    }

    if (allRowsOlderThanSyncStart || allRowsAlreadyImported || !payload?.next) break;
    page += 1;
  }

  return records;
}

async function refreshStoreCreditTransactionCategories(connection, {
  year,
  snapCustomerLookup = {},
  runId = null
}) {
  const startDate = `${year}-01-01`;
  const endExclusiveDate = `${year + 1}-01-01`;
  const now = new Date();
  await connection.query(
    `
      UPDATE local_line_store_credit_transactions
      SET category_key = CASE
            WHEN LOWER(TRIM(COALESCE(note, ''))) = 'automated monthly subscription addition'
              THEN 'automatedSubscriptionCredit'
            ELSE 'manualCredit'
          END,
          category_label = CASE
            WHEN LOWER(TRIM(COALESCE(note, ''))) = 'automated monthly subscription addition'
              THEN 'Manual Credit - Automated Subscription Credits'
            ELSE 'Manual Credit - Uncategorized'
          END,
          last_synced_run_id = COALESCE(?, last_synced_run_id),
          updated_at = ?
      WHERE transaction_type = 'MANUAL_CREDIT'
        AND transaction_month >= ?
        AND transaction_month < ?
    `,
    [runId || null, now, startDate, endExclusiveDate]
  );

  const predicates = [];
  const values = [
    "snapCredit",
    "Manual Credit - SNAP Payments",
    runId || null,
    now,
    DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT,
    startDate,
    endExclusiveDate
  ];
  const snapCustomerIds = Array.from(snapCustomerLookup.ids || []).filter(Boolean);
  const snapCustomerEmails = Array.from(snapCustomerLookup.emails || []).filter(Boolean);
  const snapCustomerNames = Array.from(snapCustomerLookup.names || []).filter(Boolean);

  if (snapCustomerIds.length) {
    predicates.push(`customer_id IN (${buildInClause(snapCustomerIds)})`);
    values.push(...snapCustomerIds);
  }
  if (snapCustomerEmails.length) {
    predicates.push(`LOWER(COALESCE(email, '')) IN (${buildInClause(snapCustomerEmails)})`);
    values.push(...snapCustomerEmails);
  }
  if (snapCustomerNames.length) {
    predicates.push(`LOWER(TRIM(COALESCE(customer_name, ''))) IN (${buildInClause(snapCustomerNames)})`);
    values.push(...snapCustomerNames);
  }
  predicates.push(
    `(LOWER(COALESCE(note, '')) REGEXP '(^|[[:space:][:punct:]])snap([[:space:][:punct:]]|$)'
      AND LOWER(COALESCE(note, '')) NOT REGEXP 'snap peas|sugar snap')`
  );

  const [result] = await connection.query(
    `
      UPDATE local_line_store_credit_transactions
      SET category_key = ?,
          category_label = ?,
          last_synced_run_id = COALESCE(?, last_synced_run_id),
          updated_at = ?
      WHERE transaction_type = 'MANUAL_CREDIT'
        AND COALESCE(category_key, '') <> 'automatedSubscriptionCredit'
        AND amount > ?
        AND transaction_month >= ?
        AND transaction_month < ?
        AND (${predicates.join(" OR ")})
    `,
    values
  );

  const [tomResult] = await connection.query(
    `
      UPDATE local_line_store_credit_transactions
      SET category_key = ?,
          category_label = ?,
          last_synced_run_id = COALESCE(?, last_synced_run_id),
          updated_at = ?
      WHERE transaction_type = 'MANUAL_CREDIT'
        AND COALESCE(category_key, '') <> 'automatedSubscriptionCredit'
        AND ABS(amount - ?) < 0.005
        AND transaction_month >= ?
        AND transaction_month < ?
        AND (
          LOWER(COALESCE(email, '')) = ?
          OR LOWER(TRIM(COALESCE(customer_name, ''))) = ?
        )
    `,
    [
      "tomCulhaneCashReceived",
      "Manual Credit - Tom Culhane Cash Received",
      runId || null,
      now,
      DASHBOARD_TOM_CULHANE_CASH_RECEIVED_AMOUNT,
      startDate,
      endExclusiveDate,
      DASHBOARD_TOM_CULHANE_CASH_RECEIVED_EMAIL,
      DASHBOARD_TOM_CULHANE_CASH_RECEIVED_NAME
    ]
  );

  const [noteBucketResult] = await connection.query(
    `
      UPDATE local_line_store_credit_transactions
      SET category_key = CASE
            WHEN TRIM(COALESCE(note, '')) = ''
              THEN 'blankManualCredit'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'jar|bottle|deposit|container'
              THEN 'jarDepositReturnCredit'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'host'
              THEN 'hostCredit'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'refund|return|missing|not received|credit for|wrong|damaged|quality|cancel|reimburse|short|out of stock|not delivered|broken'
              THEN 'productIssueRefundCredit'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'farm stay|camp|influencer|trade|gift|nancy|employee|approved|cash payment|store credit|payment|invoice|monthly credit|landing page|successful charge|sent by check|charge|cash|check'
              THEN 'paymentTradeAdminCredit'
            ELSE 'productItemCredit'
          END,
          category_label = CASE
            WHEN TRIM(COALESCE(note, '')) = ''
              THEN 'Manual Credit - Blank / Unlabeled'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'jar|bottle|deposit|container'
              THEN 'Manual Credit - Jar / Deposit Returns'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'host'
              THEN 'Manual Credit - Host Credits'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'refund|return|missing|not received|credit for|wrong|damaged|quality|cancel|reimburse|short|out of stock|not delivered|broken'
              THEN 'Manual Credit - Product Issue / Refunds'
            WHEN LOWER(COALESCE(note, '')) REGEXP 'farm stay|camp|influencer|trade|gift|nancy|employee|approved|cash payment|store credit|payment|invoice|monthly credit|landing page|successful charge|sent by check|charge|cash|check'
              THEN 'Manual Credit - Payment / Trade / Admin Notes'
            ELSE 'Manual Credit - Product / Item Credits'
          END,
          last_synced_run_id = COALESCE(?, last_synced_run_id),
          updated_at = ?
      WHERE transaction_type = 'MANUAL_CREDIT'
        AND category_key = 'manualCredit'
        AND transaction_month >= ?
        AND transaction_month < ?
    `,
    [runId || null, now, startDate, endExclusiveDate]
  );

  return {
    snapCustomerCount: snapCustomerIds.length,
    snapManualCreditMinAmount: DASHBOARD_SNAP_MANUAL_CREDIT_MIN_AMOUNT,
    snapManualCreditRowsClassified: Number(result?.affectedRows || 0),
    tomCulhaneCashReceivedRowsClassified: Number(tomResult?.affectedRows || 0),
    noteBucketRowsClassified: Number(noteBucketResult?.affectedRows || 0)
  };
}

async function rebuildStoreCreditMonthlyRollups(connection, { year, runId }) {
  const startDate = `${year}-01-01`;
  const endExclusiveDate = `${year + 1}-01-01`;
  await connection.query(
    `
      DELETE FROM local_line_store_credit_monthly_rollups
      WHERE month_start >= ? AND month_start < ?
    `,
    [startDate, endExclusiveDate]
  );
  await connection.query(
    `
      INSERT INTO local_line_store_credit_monthly_rollups (
        month_start,
        transaction_type,
        category_key,
        category_label,
        transaction_count,
        amount,
        latest_run_id,
        updated_at
      )
      SELECT
        transaction_month,
        COALESCE(transaction_type, 'UNKNOWN'),
        COALESCE(category_key, 'uncategorized'),
        MAX(COALESCE(category_label, 'Uncategorized')),
        COUNT(*),
        ROUND(COALESCE(SUM(amount), 0), 2),
        ?,
        ?
      FROM local_line_store_credit_transactions
      WHERE transaction_month >= ? AND transaction_month < ?
      GROUP BY transaction_month, COALESCE(transaction_type, 'UNKNOWN'), COALESCE(category_key, 'uncategorized')
    `,
    [runId || null, new Date(), startDate, endExclusiveDate]
  );
}

async function syncLocalLineStoreCreditTransactionsForYear(connection, {
  year = DASHBOARD_STORE_CREDIT_SYNC_YEAR,
  reportProgress = () => {}
} = {}) {
  const startDate = `${year}-01-01`;
  const endExclusiveDate = addDaysYmd(getTodayYmd(), 1);
  const runId = await insertStoreCreditSyncRun(connection, { year, startDate, endExclusiveDate });
  const startedAt = new Date();

  try {
    const accessToken = await getLocalLineAccessToken();
    const exportRows = await fetchLocalLineCustomerCreditRows();
    const customers = exportRows
      .map((row) => buildStoreCreditCustomerFromExportRow(row))
      .filter(Boolean);
    const snapCustomerLookup = buildStoreCreditSnapCustomerLookup(customers);
    const cursors = await loadStoreCreditCustomerCursors(connection);
    const snapshotDate = getTodayYmd();
    await upsertStoreCreditBalanceSnapshotRows(connection, {
      snapshotDate,
      customers,
      runId,
      capturedAt: startedAt
    });

    let nextIndex = 0;
    let processedCount = 0;
    let fetchedTransactionCount = 0;
    let manualCreditTotal = 0;
    let manualDebitTotal = 0;
    let orderDebitTotal = 0;
    const errors = [];

    const worker = async () => {
      while (nextIndex < customers.length) {
        const customer = customers[nextIndex];
        nextIndex += 1;
        const cursor = cursors.get(customer.customerId);
        try {
          const records = await fetchStoreCreditTransactionsForCustomer(customer, accessToken, {
            startDate,
            endExclusiveDate,
            latestImportedAt: cursor?.lastTransactionAt || null,
            runId,
            snapCustomerLookup
          });
          await upsertStoreCreditTransactions(getPool(), records);
          const newestRecord = records
            .slice()
            .sort((left, right) => String(right.transactionAt || "").localeCompare(String(left.transactionAt || "")))[0] || null;
          await upsertStoreCreditCustomerCursor(getPool(), {
            customer,
            latestRecord: newestRecord,
            fetchedCount: records.length
          });
          fetchedTransactionCount += records.length;
          records.forEach((record) => {
            if (record.transactionType === "MANUAL_CREDIT") {
              manualCreditTotal = round2(manualCreditTotal + Number(record.amount || 0));
            } else if (record.transactionType === "MANUAL_DEBIT") {
              manualDebitTotal = round2(manualDebitTotal + Number(record.amount || 0));
            } else if (record.transactionType === "ORDER_DEBIT") {
              orderDebitTotal = round2(orderDebitTotal + Number(record.amount || 0));
            }
          });
        } catch (error) {
          errors.push({
            customerId: customer.customerId,
            email: customer.email,
            message: error?.message || String(error)
          });
          await upsertStoreCreditCustomerCursor(getPool(), {
            customer,
            fetchedCount: 0,
            error
          });
        } finally {
          processedCount += 1;
          if (processedCount % 100 === 0 || processedCount === customers.length) {
            reportProgress({
              phaseKey: "compute",
              phaseLabel: "Compute Metrics",
              status: "running",
              percent: Math.min(75, Math.round((processedCount / Math.max(customers.length, 1)) * 60)),
              current: processedCount,
              total: customers.length,
              message: `Synced member-bank ledger for ${processedCount}/${customers.length} Local Line customers`
            });
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DASHBOARD_STORE_CREDIT_SYNC_CONCURRENCY, customers.length || 1) }, worker)
    );
    const categoryRefreshSummary = await refreshStoreCreditTransactionCategories(connection, {
      year,
      snapCustomerLookup,
      runId
    });
    await rebuildStoreCreditMonthlyRollups(connection, { year, runId });

    const summary = {
      source: "localline_store_credit_transactions",
      year,
      startDate,
      endExclusiveDate,
      customerCount: customers.length,
      fetchedTransactionCount,
      errors,
      snapshotDate,
      ...categoryRefreshSummary
    };
    await updateStoreCreditSyncRun(connection, runId, {
      status: errors.length ? "completed_with_errors" : "completed",
      customerCount: customers.length,
      transactionCount: fetchedTransactionCount,
      manualCreditTotal,
      manualDebitTotal,
      orderDebitTotal,
      summaryJson: stringifyJson(summary)
    });
    await upsertSyncCursor(connection, `store-credit-ledger-${year}`, {
      cursorValue: endExclusiveDate,
      syncedThroughAt: new Date(`${endExclusiveDate}T00:00:00Z`),
      lastStartedAt: startedAt,
      lastFinishedAt: new Date(),
      lastStatus: errors.length ? "completed_with_errors" : "completed",
      lastMessage: errors.length
        ? `Synced ${fetchedTransactionCount} transactions with ${errors.length} customer errors`
        : `Synced ${fetchedTransactionCount} store-credit transactions`,
      summaryJson: stringifyJson(summary)
    });

    return summary;
  } catch (error) {
    await updateStoreCreditSyncRun(connection, runId, {
      status: "failed",
      errorMessage: error?.message || String(error),
      summaryJson: stringifyJson({ year, startDate, endExclusiveDate })
    });
    await upsertSyncCursor(connection, `store-credit-ledger-${year}`, {
      cursorValue: endExclusiveDate,
      lastStartedAt: startedAt,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Store-credit ledger sync failed"
    });
    throw error;
  }
}

function addStoreCreditMonthlyValue(target, monthStart, key, value) {
  if (!monthStart) return;
  const summary = target[monthStart] || {};
  summary[key] = round2(Number(summary[key] || 0) + Number(value || 0));
  target[monthStart] = summary;
}

function chooseStoreCreditSnapshotOnOrBefore(snapshots = [], ymd) {
  return snapshots
    .filter((snapshot) => snapshot.snapshotDate && String(snapshot.snapshotDate) <= String(ymd))
    .slice(-1)[0] || null;
}

async function loadStoreCreditBalanceSnapshots(connection, year) {
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-10`;
  const snapshots = [];
  const [aggregateRows] = await connection.query(
    `
      SELECT
        snapshot_week_start AS snapshotWeekStart,
        snapshot_week_end AS snapshotWeekEnd,
        total_balance AS totalBalance,
        summary_json AS summaryJson,
        captured_at AS capturedAt
      FROM local_line_customer_credit_snapshots
      WHERE snapshot_week_end >= ? AND snapshot_week_start <= ?
      ORDER BY snapshot_week_start ASC
    `,
    [startDate, endDate]
  );
  (aggregateRows || []).forEach((row) => {
    const summary = parseSnapshotRawJson(row.summaryJson);
    const snapshotDate =
      summary.fileDate ||
      summary.snapshotDate ||
      row.snapshotWeekEnd ||
      row.snapshotWeekStart ||
      null;
    if (!snapshotDate) return;
    snapshots.push({
      snapshotDate: String(snapshotDate),
      totalBalance: Number(row.totalBalance || 0),
      source: summary.source || "local_line_customer_credit_snapshots"
    });
  });

  const [customerSnapshotRows] = await connection.query(
    `
      SELECT
        snapshot_date AS snapshotDate,
        COALESCE(SUM(store_credit_balance), 0) AS totalBalance,
        COUNT(*) AS customerCount
      FROM local_line_store_credit_balance_snapshots
      WHERE snapshot_date >= ? AND snapshot_date <= ?
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `,
    [startDate, endDate]
  );
  (customerSnapshotRows || []).forEach((row) => {
    snapshots.push({
      snapshotDate: String(row.snapshotDate),
      totalBalance: Number(row.totalBalance || 0),
      source: "local_line_store_credit_balance_snapshots",
      customerCount: Number(row.customerCount || 0)
    });
  });

  return snapshots
    .filter((snapshot) => Number.isFinite(Number(snapshot.totalBalance)))
    .sort((left, right) => String(left.snapshotDate).localeCompare(String(right.snapshotDate)));
}

async function loadDashboardStoreCreditMonthlyMap(connection, {
  year = DASHBOARD_STORE_CREDIT_SYNC_YEAR
} = {}) {
  const startDate = `${year}-01-01`;
  const endExclusiveDate = `${year + 1}-01-01`;
  const monthlyMap = {};
  const [rollupRows] = await connection.query(
    `
      SELECT
        month_start AS monthStart,
        transaction_type AS transactionType,
        category_key AS categoryKey,
        category_label AS categoryLabel,
        transaction_count AS transactionCount,
        amount
      FROM local_line_store_credit_monthly_rollups
      WHERE month_start >= ? AND month_start < ?
      ORDER BY month_start ASC, transaction_type ASC, category_key ASC
    `,
    [startDate, endExclusiveDate]
  );
  (rollupRows || []).forEach((row) => {
    const monthStart = String(row.monthStart || "");
    const amount = Number(row.amount || 0);
    const transactionType = String(row.transactionType || "");
    const categoryKey = String(row.categoryKey || "");
    addStoreCreditMonthlyValue(monthlyMap, monthStart, "ledgerNetMovement", amount);
    if (transactionType === "MANUAL_CREDIT") {
      addStoreCreditMonthlyValue(monthlyMap, monthStart, "manualCreditTotal", amount);
      if (categoryKey === "automatedSubscriptionCredit") {
        addStoreCreditMonthlyValue(monthlyMap, monthStart, "automatedSubscriptionCredit", amount);
      } else if (categoryKey === "snapCredit") {
        addStoreCreditMonthlyValue(monthlyMap, monthStart, "snapCredit", amount);
	      } else if (categoryKey === "tomCulhaneCashReceived") {
	        addStoreCreditMonthlyValue(monthlyMap, monthStart, "tomCulhaneCashReceived", amount);
	      } else if (
	        DASHBOARD_MANUAL_CREDIT_NOTE_BUCKETS.some((bucket) => bucket.key === categoryKey)
	      ) {
	        addStoreCreditMonthlyValue(monthlyMap, monthStart, categoryKey, amount);
	      }
    } else if (transactionType === "MANUAL_DEBIT") {
      addStoreCreditMonthlyValue(monthlyMap, monthStart, "manualDebitTotal", amount);
    } else if (transactionType === "ORDER_DEBIT") {
      addStoreCreditMonthlyValue(monthlyMap, monthStart, "orderDebitTotal", amount);
    }
  });

  const snapshots = await loadStoreCreditBalanceSnapshots(connection, year);
  Object.keys(monthlyMap).forEach((monthStart) => {
    const monthEnd = getDashboardMonthEndYmd(monthStart);
    const closingCutoff = addDaysYmd(monthEnd, 1);
    const openingSnapshot = chooseStoreCreditSnapshotOnOrBefore(snapshots, monthStart);
    const closingSnapshot = chooseStoreCreditSnapshotOnOrBefore(snapshots, closingCutoff);
    const summary = monthlyMap[monthStart] || {};
    if (openingSnapshot) {
      summary.openingBalance = round2(openingSnapshot.totalBalance);
      summary.openingBalanceDate = openingSnapshot.snapshotDate;
    }
    if (closingSnapshot) {
      summary.closingBalance = round2(closingSnapshot.totalBalance);
      summary.closingBalanceDate = closingSnapshot.snapshotDate;
    }
    if (openingSnapshot && closingSnapshot) {
      summary.balanceChange = round2(closingSnapshot.totalBalance - openingSnapshot.totalBalance);
      summary.unreconciledBalanceDifference = round2(
        summary.balanceChange - Number(summary.ledgerNetMovement || 0)
      );
    }
    monthlyMap[monthStart] = summary;
  });

  return monthlyMap;
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

async function fetchSheetRowsByTitle(accessToken, title, { valueRenderOption = "FORMULA" } = {}) {
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
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${title}!A:ZZ`)}?valueRenderOption=${encodeURIComponent(valueRenderOption)}`
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
        COALESCE(SUM(
          CASE
            WHEN LOWER(COALESCE(price_list_name, '')) LIKE '%guest%' THEN retail_amount
            ELSE 0
          END
        ), 0) AS guestRetailAmount,
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
      guestPurchaseDollars: Number(Number(reportingRow?.guestRetailAmount || 0).toFixed(2)),
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

function buildClearSheetBordersRequest(sheetId, rowCount, columnCount) {
  const clearBorder = { style: "NONE" };
  return {
    updateBorders: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: Math.max(Number(rowCount) || 1, 1),
        startColumnIndex: 0,
        endColumnIndex: Math.max(Number(columnCount) || 1, 1)
      },
      top: clearBorder,
      bottom: clearBorder,
      left: clearBorder,
      right: clearBorder,
      innerHorizontal: clearBorder,
      innerVertical: clearBorder
    }
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

function getSheetInsertIndexAfterTitle(sheets = [], afterTitle = "") {
  if (!afterTitle) return null;
  const match = (sheets || []).find((sheet) => sheet?.properties?.title === afterTitle);
  const index = Number(match?.properties?.index);
  return Number.isFinite(index) ? index + 1 : null;
}

async function getOrCreateSheetMetadata(accessToken, spreadsheetId, title, { afterTitle = "" } = {}) {
  const meta = await sheetsRequest(
    accessToken,
    "GET",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties,charts(chartId,spec/title))`
  );
  const match = (meta.sheets || []).find((sheet) => sheet?.properties?.title === title);
  if (match?.properties?.sheetId || match?.properties?.sheetId === 0) {
    const desiredIndex = getSheetInsertIndexAfterTitle(meta.sheets || [], afterTitle);
    if (
      desiredIndex !== null &&
      title !== afterTitle &&
      Number(match.properties.index) !== desiredIndex
    ) {
      await sheetsRequest(
        accessToken,
        "POST",
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: match.properties.sheetId,
                  index: desiredIndex
                },
                fields: "index"
              }
            }
          ]
        }
      );
      const movedMeta = await sheetsRequest(
        accessToken,
        "GET",
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties,charts(chartId,spec/title))`
      );
      const movedMatch = (movedMeta.sheets || []).find((sheet) => sheet?.properties?.title === title);
      return {
        properties: movedMatch?.properties || match.properties,
        charts: movedMatch?.charts || match.charts || []
      };
    }
    return {
      properties: match.properties,
      charts: match.charts || []
    };
  }
  const desiredIndex = getSheetInsertIndexAfterTitle(meta.sheets || [], afterTitle);
  const created = await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      requests: [
        {
          addSheet: {
            properties: {
              title,
              ...(desiredIndex === null ? {} : { index: desiredIndex })
            }
          }
        }
      ]
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
  packWagesSalesChart,
  {
    targetTitle = DASHBOARD_TARGET_TITLE,
    placeAfterTitle = "",
    frozenColumnCount = DASHBOARD_WEEK_START_COLUMN_INDEX,
    weekStartColumnIndex = DASHBOARD_WEEK_START_COLUMN_INDEX
  } = {}
) {
  const sheetMetadata = await getOrCreateSheetMetadata(
    accessToken,
    DASHBOARD_SHEET_ID,
    targetTitle,
    { afterTitle: placeAfterTitle }
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
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${targetTitle}!A:ZZ`)}:clear`,
    {}
  );
  await sheetsRequest(
    accessToken,
    "PUT",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${targetTitle}!A1`)}?valueInputOption=USER_ENTERED`,
    {
      range: `${targetTitle}!A1`,
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
            frozenColumnCount: Math.min(frozenColumnCount, maxCols),
            rowCount: gridRowCount,
            columnCount: gridColumnCount
          }
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.rowCount,gridProperties.columnCount"
      }
    },
    buildClearSheetBordersRequest(sheetId, gridRowCount, gridColumnCount),
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
    const entryBackground =
      metric.entry === "AUTO"
        ? hexColor("#D9EAD3")
        : metric.entry === "FORMULA"
          ? hexColor("#D9EAF7")
          : hexColor("#FFF2CC");
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            backgroundColor: entryBackground,
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

    if (metric.boxed) {
      const border = {
        style: "SOLID_THICK",
        width: 1,
        color: hexColor("#1F4E78")
      };
      requests.push(
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: metric.rowIndex,
              endRowIndex: metric.rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: maxCols
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: hexColor("#F3F8FC")
              }
            },
            fields: "userEnteredFormat.backgroundColor"
          }
        },
        {
          updateBorders: {
            range: {
              sheetId,
              startRowIndex: metric.rowIndex,
              endRowIndex: metric.rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: maxCols
            },
            top: border,
            bottom: border,
            left: border,
            right: border
          }
        }
      );
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

    if (metric.italic) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: metric.rowIndex, endRowIndex: metric.rowIndex + 1, startColumnIndex: 0, endColumnIndex: maxCols },
          cell: {
            userEnteredFormat: {
              textFormat: { italic: true }
            }
          },
          fields: "userEnteredFormat.textFormat.italic"
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

  if (weekStartColumnIndex < maxCols) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: weekStartColumnIndex,
          endIndex: maxCols
        },
        properties: { pixelSize: 92 },
        fields: "pixelSize"
      }
    });
  }

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

function buildEmployeeCreditMonthColumns(year = DASHBOARD_EMPLOYEE_CREDITS_YEAR) {
  return DASHBOARD_MONTH_LABELS.map((label, index) => {
    const monthNumber = String(index + 1).padStart(2, "0");
    return {
      key: `${year}-${monthNumber}`,
      label: `${label} ${year}`
    };
  });
}

function normalizeDashboardStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function getEmployeeCreditAmount(row = {}) {
  const retailAmount = toNumber(row.retailAmount);
  if (retailAmount !== null) return round2(retailAmount);
  const purchaseTotal = toNumber(row.purchaseTotal);
  return round2(purchaseTotal || 0);
}

function getEmployeeCreditStatusBucket(row = {}) {
  const orderStatus = normalizeDashboardStatus(row.orderStatus);
  const paymentStatus = normalizeDashboardStatus(row.paymentStatus);
  if (orderStatus === "CANCELLED" || orderStatus === "CANCELED") return "cancelled";
  if (orderStatus === "OPEN" && paymentStatus === "PAID") return "paidOpen";
  if (orderStatus === "DRAFT" && paymentStatus === "UNPAID") return "draftUnpaid";
  return "otherIncluded";
}

async function loadEmployeeCreditOrderRows(connection, year = DASHBOARD_EMPLOYEE_CREDITS_YEAR) {
  const startMonth = `${year}-01`;
  const endMonth = `${year + 1}-01`;
  const packageIds = DASHBOARD_EMPLOYEE_CREDIT_PACKAGE_IDS.map((value) => String(value)).filter(Boolean);
  const packageFilterSql = packageIds.length ? "AND r.package_id IN (?)" : "";
  const params = [
    DASHBOARD_EMPLOYEE_CREDIT_PRICE_LIST_ID,
    startMonth,
    endMonth,
    "Employee%"
  ];
  if (packageIds.length) params.push(packageIds);

  const [rows] = await connection.query(
    `
      SELECT
        r.fulfillment_month AS fulfillmentMonth,
        r.fulfillment_date AS fulfillmentDate,
        r.local_line_order_id AS orderId,
        r.customer_name AS employee,
        r.product_name AS productName,
        r.package_id AS packageId,
        r.package_name AS packageName,
        r.quantity AS quantity,
        r.retail_amount AS retailAmount,
        r.purchase_total AS purchaseTotal,
        o.status AS orderStatus,
        o.payment_status AS paymentStatus
      FROM local_line_order_reporting_entries r
      JOIN local_line_orders o ON o.local_line_order_id = r.local_line_order_id
      WHERE o.price_list_id = ?
        AND r.fulfillment_month >= ?
        AND r.fulfillment_month < ?
        AND r.product_name LIKE ?
        ${packageFilterSql}
      ORDER BY r.fulfillment_month ASC,
        COALESCE(r.customer_name, '') ASC,
        COALESCE(r.product_name, '') ASC,
        r.local_line_order_id ASC
    `,
    params
  );
  return rows || [];
}

function createEmployeeCreditSummaryRow(employee, monthColumns) {
  return {
    employee,
    months: Object.fromEntries(monthColumns.map((month) => [month.key, 0])),
    totalCredit: 0,
    paidOpen: 0,
    draftUnpaid: 0,
    otherIncluded: 0,
    cancelledExcluded: 0,
    lineCount: 0
  };
}

function numberOrBlank(value) {
  return Number(value) ? Number(value) : "";
}

function buildEmployeeCreditsReportValues({
  rows = [],
  year = DASHBOARD_EMPLOYEE_CREDITS_YEAR,
  generatedAt = new Date()
} = {}) {
  const monthColumns = buildEmployeeCreditMonthColumns(year);
  const monthByKey = new Map(monthColumns.map((month) => [month.key, month]));
  const values = [];

  const summaryByEmployee = new Map();
  const sortedRows = [...rows].sort((a, b) => {
    const monthCompare = String(a.fulfillmentMonth || "").localeCompare(String(b.fulfillmentMonth || ""));
    if (monthCompare) return monthCompare;
    const employeeCompare = String(a.employee || "").localeCompare(String(b.employee || ""));
    if (employeeCompare) return employeeCompare;
    return Number(a.orderId || 0) - Number(b.orderId || 0);
  });

  sortedRows.forEach((row) => {
    const employee = String(row.employee || "Unknown").trim() || "Unknown";
    const month = monthByKey.get(String(row.fulfillmentMonth || ""));
    const amount = getEmployeeCreditAmount(row);
    const bucket = getEmployeeCreditStatusBucket(row);
    const includedAmount = bucket === "cancelled" ? 0 : amount;
    const summary =
      summaryByEmployee.get(employee) || createEmployeeCreditSummaryRow(employee, monthColumns);
    summary.lineCount += 1;
    if (month && includedAmount) {
      summary.months[month.key] = round2(summary.months[month.key] + includedAmount);
      summary.totalCredit = round2(summary.totalCredit + includedAmount);
    }
    if (bucket === "paidOpen") summary.paidOpen = round2(summary.paidOpen + amount);
    if (bucket === "draftUnpaid") summary.draftUnpaid = round2(summary.draftUnpaid + amount);
    if (bucket === "otherIncluded") summary.otherIncluded = round2(summary.otherIncluded + amount);
    if (bucket === "cancelled") summary.cancelledExcluded = round2(summary.cancelledExcluded + amount);
    summaryByEmployee.set(employee, summary);
  });

  const summaryRows = [...summaryByEmployee.values()].sort((a, b) =>
    a.employee.localeCompare(b.employee)
  );
  const totalSummary = createEmployeeCreditSummaryRow("TOTAL", monthColumns);
  summaryRows.forEach((row) => {
    monthColumns.forEach((month) => {
      totalSummary.months[month.key] = round2(totalSummary.months[month.key] + row.months[month.key]);
    });
    totalSummary.totalCredit = round2(totalSummary.totalCredit + row.totalCredit);
    totalSummary.paidOpen = round2(totalSummary.paidOpen + row.paidOpen);
    totalSummary.draftUnpaid = round2(totalSummary.draftUnpaid + row.draftUnpaid);
    totalSummary.otherIncluded = round2(totalSummary.otherIncluded + row.otherIncluded);
    totalSummary.cancelledExcluded = round2(totalSummary.cancelledExcluded + row.cancelledExcluded);
    totalSummary.lineCount += row.lineCount;
  });

  const sectionRows = [];
  const headerRows = [];
  const summaryHeaderRowIndex = values.length;
  headerRows.push(summaryHeaderRowIndex);
  values.push([
    "Employee",
    ...monthColumns.map((month) => month.label),
    "Total Credit"
  ]);
  const summaryDataStartRowIndex = values.length;
  [...summaryRows, totalSummary].forEach((row) => {
    values.push([
      row.employee,
      ...monthColumns.map((month) => numberOrBlank(row.months[month.key])),
      numberOrBlank(row.totalCredit)
    ]);
  });
  const summaryDataEndRowIndex = values.length;
  const summaryTotalRowIndex = summaryDataEndRowIndex - 1;

  return {
    values,
    sectionRows,
    headerRows,
    rowCount: values.length,
    dataLineCount: sortedRows.length,
    employeeCount: summaryRows.length,
    includedCreditTotal: totalSummary.totalCredit,
    cancelledExcludedTotal: totalSummary.cancelledExcluded,
    summary: {
      headerRowIndex: summaryHeaderRowIndex,
      dataStartRowIndex: summaryDataStartRowIndex,
      dataEndRowIndex: summaryDataEndRowIndex,
      totalRowIndex: summaryTotalRowIndex,
      currencyStartColumnIndex: 1,
      currencyEndColumnIndex: monthColumns.length + 2
    }
  };
}

async function buildEmployeeCreditsReport(connection, { generatedAt = new Date() } = {}) {
  const rows = await loadEmployeeCreditOrderRows(connection, DASHBOARD_EMPLOYEE_CREDITS_YEAR);
  return buildEmployeeCreditsReportValues({
    rows,
    year: DASHBOARD_EMPLOYEE_CREDITS_YEAR,
    generatedAt
  });
}

function pushEmployeeCreditNumberFormatRequest(
  requests,
  sheetId,
  {
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex,
    type = "CURRENCY",
    pattern = "$#,##0.00"
  }
) {
  if (
    !Number.isFinite(startRowIndex) ||
    !Number.isFinite(endRowIndex) ||
    !Number.isFinite(startColumnIndex) ||
    !Number.isFinite(endColumnIndex) ||
    endRowIndex <= startRowIndex ||
    endColumnIndex <= startColumnIndex
  ) {
    return;
  }
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
      cell: {
        userEnteredFormat: {
          numberFormat: { type, pattern }
        }
      },
      fields: "userEnteredFormat.numberFormat"
    }
  });
}

async function writeEmployeeCreditsReportToSheet(
  accessToken,
  report,
  {
    targetTitle = DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE,
    placeAfterTitle = DASHBOARD_V2_TARGET_TITLE
  } = {}
) {
  const values = report?.values || [["Employee Credit Report"]];
  const sheetMetadata = await getOrCreateSheetMetadata(
    accessToken,
    DASHBOARD_SHEET_ID,
    targetTitle,
    { afterTitle: placeAfterTitle }
  );
  const sheetProperties = sheetMetadata.properties;
  const sheetId = Number(sheetProperties?.sheetId);
  const maxRows = Math.max(values.length, 1);
  const maxCols = Math.max(...values.map((row) => row.length), 1);
  const gridRowCount = Math.max(Number(sheetProperties?.gridProperties?.rowCount || 0), maxRows, 1);
  const gridColumnCount = Math.max(Number(sheetProperties?.gridProperties?.columnCount || 0), maxCols, 1);

  await sheetsRequest(
    accessToken,
    "POST",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${targetTitle}!A:ZZ`)}:clear`,
    {}
  );
  await sheetsRequest(
    accessToken,
    "PUT",
    `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_SHEET_ID}/values/${encodeURIComponent(`${targetTitle}!A1`)}?valueInputOption=USER_ENTERED`,
    {
      range: `${targetTitle}!A1`,
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
            frozenRowCount: Math.min((report?.summary?.headerRowIndex ?? 0) + 1, maxRows),
            frozenColumnCount: Math.min(1, maxCols),
            rowCount: gridRowCount,
            columnCount: gridColumnCount
          }
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.rowCount,gridProperties.columnCount"
      }
    },
    buildClearSheetBordersRequest(sheetId, gridRowCount, gridColumnCount),
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
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)"
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#1F4E78"),
            textFormat: { foregroundColor: hexColor("#FFFFFF"), bold: true, fontSize: 12 }
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)"
      }
    }
  ];

  (report?.sectionRows || []).forEach((rowIndex) => {
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

  (report?.headerRows || []).forEach((rowIndex) => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor("#2F75B5"),
            textFormat: { foregroundColor: hexColor("#FFFFFF"), bold: true },
            horizontalAlignment: "CENTER"
          }
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"
      }
    });
  });

  if (Number.isFinite(report?.summary?.totalRowIndex)) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: report.summary.totalRowIndex,
          endRowIndex: report.summary.totalRowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: maxCols
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: hexColor("#EAF2F8")
          }
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)"
      }
    });
  }

  pushEmployeeCreditNumberFormatRequest(requests, sheetId, {
    startRowIndex: report.summary.dataStartRowIndex,
    endRowIndex: report.summary.dataEndRowIndex,
    startColumnIndex: report.summary.currencyStartColumnIndex,
    endColumnIndex: report.summary.currencyEndColumnIndex
  });

  [
    { startIndex: 0, pixelSize: 170 },
    { startIndex: 1, pixelSize: 110 },
    { startIndex: 2, pixelSize: 180 },
    { startIndex: 3, pixelSize: 260 },
    { startIndex: 4, pixelSize: 110 },
    { startIndex: 5, pixelSize: 110 },
    { startIndex: 6, pixelSize: 90 },
    { startIndex: 7, pixelSize: 105 },
    { startIndex: 8, pixelSize: 105 },
    { startIndex: 9, pixelSize: 115 },
    { startIndex: 10, pixelSize: 115 },
    { startIndex: 11, pixelSize: 125 },
    { startIndex: 12, pixelSize: 105 },
    { startIndex: 13, pixelSize: 110 },
    { startIndex: 14, pixelSize: 110 },
    { startIndex: 15, pixelSize: 110 },
    { startIndex: 16, pixelSize: 120 },
    { startIndex: 17, pixelSize: 130 },
    { startIndex: 18, pixelSize: 70 }
  ].forEach((column) => {
    if (column.startIndex >= maxCols) return;
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: column.startIndex,
          endIndex: Math.min(column.startIndex + 1, maxCols)
        },
        properties: { pixelSize: column.pixelSize },
        fields: "pixelSize"
      }
    });
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
    const creditsRows = await fetchSheetRowsByTitle(accessToken, DASHBOARD_CREDITS_SOURCE_TITLE, {
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    const creditsMonthlyMap = buildDashboardCreditsMonthlyMap(
      creditsRows,
      DASHBOARD_EMPLOYEE_CREDITS_YEAR
    );
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

    try {
      reportProgress({
        phaseKey: "prepare",
        phaseLabel: "Prepare Dashboard",
        status: "running",
        percent: 80,
        message: `Syncing ${DASHBOARD_STORE_CREDIT_SYNC_YEAR} Local Line member-bank ledger`
      });
      const storeCreditSyncSummary = await syncLocalLineStoreCreditTransactionsForYear(connection, {
        year: DASHBOARD_STORE_CREDIT_SYNC_YEAR,
        reportProgress
      });
      if (storeCreditSyncSummary?.errors?.length) {
        dashboardWarnings.push(
          `Local Line member-bank ledger synced with ${storeCreditSyncSummary.errors.length} customer errors; cached data was still updated.`
        );
      }
    } catch (error) {
      dashboardWarnings.push(
        `Could not refresh Local Line member-bank transaction ledger; using cached values. ${error?.message || error}`
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

    const [weeklyKpiMap, vendorWeeklyMap, subscriberWeeklyMap, timesheetResult, storeCreditMonthlyMap] = await Promise.all([
      loadWeeklyOrderMetrics(weeks),
      loadVendorWeeklyMap(weeks),
      buildSubscriberWeeklyMap(weeks),
      buildTimesheetWeeklyMap(weeks),
      loadDashboardStoreCreditMonthlyMap(connection, { year: DASHBOARD_STORE_CREDIT_SYNC_YEAR })
    ]);
    const monthlyDashboardInputs = buildMonthlyDashboardInputs({
      weeks,
      publishableWeekStarts,
      manualValueMap,
      weeklyKpiMap,
      vendorWeeklyMap,
      timesheetWeeklyMap: timesheetResult.map || {},
      subscriberWeeklyMap
    });
    const monthlySummaryPeriods = buildDashboardV2SummaryPeriods(
      monthlyDashboardInputs.months,
      monthlyDashboardInputs.publishableMonthStarts
    );
    reportProgress({
      phaseKey: "compute",
      phaseLabel: "Compute Metrics",
      status: "running",
      percent: 80,
      message: "Loading QBO reconciliation metrics"
    });
    const qboPeriods = dedupeDashboardPeriods([
      ...summaryPeriods,
      ...monthlySummaryPeriods,
      ...monthlyDashboardInputs.months
    ]);
    const qboResult = await loadDashboardQboPeriodMetrics(qboPeriods, { connection });
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
    const monthlyDashboard = buildDashboardV2Rows({
      months: monthlyDashboardInputs.months,
      summaryPeriods: monthlySummaryPeriods,
      manualValueMap: monthlyDashboardInputs.manualValueMap,
      monthlyKpiMap: monthlyDashboardInputs.weeklyKpiMap,
      monthlyVendorMap: monthlyDashboardInputs.vendorWeeklyMap,
      monthlyTimesheetMap: monthlyDashboardInputs.timesheetWeeklyMap,
      monthlySubscriberMap: monthlyDashboardInputs.subscriberWeeklyMap,
      creditsMonthlyMap,
      storeCreditMonthlyMap,
      qboPeriodMap: qboResult.map || {},
      generatedAt: startedAt
    });
    const employeeCreditsReport = await buildEmployeeCreditsReport(connection, {
      generatedAt: startedAt
    });

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
      packWagesSalesChart,
      { targetTitle: DASHBOARD_TARGET_TITLE }
    );

    reportProgress({
      phaseKey: "publish",
      phaseLabel: "Publish Dashboard",
      status: "running",
      percent: 45,
      message: `Writing ${DASHBOARD_V2_TARGET_TITLE} to Google Sheets`
    });

    await writeDashboardToSheet(
      accessToken,
      monthlyDashboard.values,
      monthlyDashboard.metricRows,
      monthlyDashboard.sectionRows,
      monthlyDashboard.packWagesSalesChart,
      {
        targetTitle: DASHBOARD_V2_TARGET_TITLE,
        placeAfterTitle: DASHBOARD_TARGET_TITLE,
        frozenColumnCount: DASHBOARD_STATIC_COLUMN_COUNT,
        weekStartColumnIndex: DASHBOARD_STATIC_COLUMN_COUNT
      }
    );

    reportProgress({
      phaseKey: "publish",
      phaseLabel: "Publish Dashboard",
      status: "running",
      percent: 80,
      message: `Writing ${DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE} to Google Sheets`
    });

    await writeEmployeeCreditsReportToSheet(accessToken, employeeCreditsReport, {
      targetTitle: DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE,
      placeAfterTitle: DASHBOARD_V2_TARGET_TITLE
    });

    const finishedAt = new Date();
    const summary = {
      spreadsheetId: DASHBOARD_SHEET_ID,
      targetTitle: DASHBOARD_TARGET_TITLE,
      v2TargetTitle: DASHBOARD_V2_TARGET_TITLE,
      employeeCreditsTargetTitle: DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE,
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
      v2RowCount: monthlyDashboard.values.length,
      v2MonthCount: monthlyDashboardInputs.months.length,
      employeeCreditsRowCount: employeeCreditsReport.rowCount,
      employeeCreditsLineCount: employeeCreditsReport.dataLineCount,
      employeeCreditsEmployeeCount: employeeCreditsReport.employeeCount,
      employeeCreditsIncludedCreditTotal: employeeCreditsReport.includedCreditTotal,
      employeeCreditsCancelledExcludedTotal: employeeCreditsReport.cancelledExcludedTotal,
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
        : `Published ${values.length} dashboard rows, ${monthlyDashboard.values.length} monthly v2 rows, and ${employeeCreditsReport.dataLineCount} employee credit lines`,
      summaryJson: stringifyJson(summary),
      updatedAt: finishedAt
    });

    reportProgress({
      phaseKey: "publish",
      phaseLabel: "Publish Dashboard",
      status: "completed",
      percent: 100,
      message: dashboardWarnings.length
        ? `Published ${DASHBOARD_TARGET_TITLE}, ${DASHBOARD_V2_TARGET_TITLE}, and ${DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE} with warnings`
        : `Published ${DASHBOARD_TARGET_TITLE}, ${DASHBOARD_V2_TARGET_TITLE}, and ${DASHBOARD_EMPLOYEE_CREDITS_TARGET_TITLE}`
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
