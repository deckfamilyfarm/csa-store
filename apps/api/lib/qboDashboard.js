import { getPool } from "../db.js";
import {
  DEFAULT_QBO_ENTITY_ID,
  buildQboClientConfig,
  getQboEntityId,
  getQboEntityName,
  getQboEnv
} from "./qboConfig.js";
import { QuickBooksClient } from "./quickBooksClient.js";

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeReportLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ");
}

function parseReportNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const numeric = Number(raw.replace(/[(),$]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return negative ? -numeric : numeric;
}

function getReportRows(report) {
  return report?.Rows?.Row || report?.Report?.Rows?.Row || [];
}

function getLastColValue(rowPart) {
  const columns = rowPart?.ColData || [];
  return columns.length ? columns[columns.length - 1]?.value : null;
}

function getReportRowLabel(row) {
  return (
    row?.Header?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    row?.Summary?.ColData?.[0]?.value ||
    ""
  );
}

function getReportRowTotal(row) {
  if (row?.Summary?.ColData?.length) return parseReportNumber(getLastColValue(row.Summary));
  if (row?.ColData?.length) return parseReportNumber(getLastColValue(row));
  if (row?.Header?.ColData?.length) return parseReportNumber(getLastColValue(row.Header));
  return 0;
}

function totalFromSection(section) {
  return parseReportNumber(getLastColValue(section?.Summary));
}

function extractReportLinesTotal(report, labels = []) {
  const targets = new Set(labels.map((label) => normalizeReportLabel(label)).filter(Boolean));
  if (!targets.size) return 0;
  let total = 0;

  const visit = (row) => {
    if (!row) return;
    const label = normalizeReportLabel(getReportRowLabel(row));
    if (targets.has(label)) {
      total += getReportRowTotal(row);
      return;
    }
    const children = row?.Rows?.Row || [];
    children.forEach(visit);
  };

  getReportRows(report).forEach(visit);
  return total;
}

export function parseDashboardPnlReport(report, { entityId = DEFAULT_QBO_ENTITY_ID, entityName = entityId } = {}) {
  let income = 0;
  let cogs = 0;
  let expenses = 0;
  let otherIncome = 0;
  let netIncome = 0;

  for (const row of getReportRows(report)) {
    const header = normalizeReportLabel(row?.Header?.ColData?.[0]?.value);
    if (header.includes("income") && !header.includes("other")) {
      income += totalFromSection(row);
    } else if (header.includes("cost of goods") || header.includes("cost of sales")) {
      cogs += totalFromSection(row);
    } else if (header.includes("expense")) {
      expenses += totalFromSection(row);
    } else if (header.includes("other income")) {
      otherIncome += totalFromSection(row);
    }

    const summaryLabel = normalizeReportLabel(row?.Summary?.ColData?.[0]?.value);
    if (summaryLabel.includes("net income")) {
      netIncome = totalFromSection(row);
    }
  }

  if (!netIncome) {
    netIncome = income - cogs - expenses + otherIncome;
  }

  return {
    entityId,
    entityName,
    income: round2(income),
    cogs: round2(cogs),
    grossProfit: round2(income - cogs),
    expenses: round2(expenses),
    otherIncome: round2(otherIncome),
    netIncome: round2(netIncome),
    memberPayments: round2(extractReportLinesTotal(report, ["Member Payments"]))
  };
}

function fromCacheRow(row) {
  if (!row) return null;
  return {
    entityId: row.entity_id,
    income: Number(row.income || 0),
    cogs: Number(row.cogs || 0),
    grossProfit: Number(row.gross_profit || 0),
    expenses: Number(row.expenses || 0),
    otherIncome: Number(row.other_income || 0),
    netIncome: Number(row.net_income || 0),
    memberPayments: Number(row.member_payments || 0),
    fetchedAt: row.fetched_at || null,
    source: "cache"
  };
}

async function withConnection(connection, callback) {
  if (connection) return callback(connection);
  const pool = getPool();
  const ownedConnection = await pool.getConnection();
  try {
    return await callback(ownedConnection);
  } finally {
    ownedConnection.release();
  }
}

async function loadCachedQboPeriodMetrics(periods = [], { connection = null } = {}) {
  const keys = periods.map((period) => period?.key).filter(Boolean);
  if (!keys.length) return {};
  return withConnection(connection, async (activeConnection) => {
    try {
      const placeholders = keys.map(() => "?").join(",");
      const [rows] = await activeConnection.query(
        `
          SELECT
            period_key,
            entity_id,
            income,
            cogs,
            gross_profit,
            expenses,
            other_income,
            net_income,
            member_payments,
            fetched_at
          FROM dashboard_qbo_period_metrics
          WHERE period_key IN (${placeholders})
        `,
        keys
      );
      return Object.fromEntries(rows.map((row) => [row.period_key, fromCacheRow(row)]));
    } catch (error) {
      if (error?.code === "ER_NO_SUCH_TABLE") return {};
      throw error;
    }
  });
}

async function saveCachedQboPeriodMetric(period, entityId, metrics, report, { connection = null } = {}) {
  if (!period?.key || !period?.start || !period?.end || !metrics) return;
  await withConnection(connection, async (activeConnection) => {
    await activeConnection.query(
      `
        INSERT INTO dashboard_qbo_period_metrics (
          period_key,
          period_label,
          start_date,
          end_date,
          entity_id,
          income,
          cogs,
          gross_profit,
          expenses,
          other_income,
          net_income,
          member_payments,
          raw_json,
          fetched_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          period_label = VALUES(period_label),
          start_date = VALUES(start_date),
          end_date = VALUES(end_date),
          entity_id = VALUES(entity_id),
          income = VALUES(income),
          cogs = VALUES(cogs),
          gross_profit = VALUES(gross_profit),
          expenses = VALUES(expenses),
          other_income = VALUES(other_income),
          net_income = VALUES(net_income),
          member_payments = VALUES(member_payments),
          raw_json = VALUES(raw_json),
          fetched_at = VALUES(fetched_at),
          updated_at = VALUES(updated_at)
      `,
      [
        period.key,
        period.label || period.key,
        period.start,
        period.end,
        entityId,
        metrics.income,
        metrics.cogs,
        metrics.grossProfit,
        metrics.expenses,
        metrics.otherIncome,
        metrics.netIncome,
        metrics.memberPayments,
        JSON.stringify(report || {})
      ]
    );
  });
}

export async function loadDashboardQboPeriodMetrics(periods = [], { connection = null } = {}) {
  const activePeriods = periods.filter(
    (period) => period?.key && period?.start && period?.end && period.started !== false
  );
  if (!activePeriods.length) return { map: {}, warnings: [], source: "empty" };

  const entityId = getQboEntityId();
  const cachedMetrics = await loadCachedQboPeriodMetrics(activePeriods, { connection }).catch(() => ({}));
  const qboEnabled = String(getQboEnv("DASHBOARD_QBO_ENABLED", "true")).toLowerCase() !== "false";
  if (!qboEnabled) {
    return {
      map: cachedMetrics,
      warnings: Object.keys(cachedMetrics).length
        ? ["QBO dashboard metrics are disabled; using cached QBO reconciliation values."]
        : ["QBO dashboard metrics are disabled; reconciliation rows are blank."],
      source: "disabled"
    };
  }

  const { config, missingEnv } = buildQboClientConfig(entityId);
  if (!config) {
    const missing = missingEnv.map((key) => `QBO_${entityId}_${key}`).join(", ");
    return {
      map: cachedMetrics,
      warnings: Object.keys(cachedMetrics).length
        ? [`QBO dashboard metrics are using cached values because live config is missing: ${missing}.`]
        : [`QBO dashboard metrics are blank because live config is missing: ${missing}.`],
      source: "cache"
    };
  }

  const client = new QuickBooksClient(config);
  const map = {};
  const warnings = [];

  for (const period of activePeriods) {
    try {
      const report = await client.fetchProfitAndLoss(period.start, period.end);
      const metrics = parseDashboardPnlReport(report, {
        entityId,
        entityName: getQboEntityName(entityId)
      });
      map[period.key] = { ...metrics, source: "live" };
      try {
        await saveCachedQboPeriodMetric(period, entityId, metrics, report, { connection });
      } catch (cacheError) {
        warnings.push(
          `QBO ${period.label || period.key} live metrics loaded but cache update failed: ${cacheError?.message || cacheError}`
        );
      }
    } catch (error) {
      if (cachedMetrics[period.key]) {
        map[period.key] = cachedMetrics[period.key];
        warnings.push(
          `QBO ${period.label || period.key} metrics used cached values because live fetch failed: ${error?.message || error}`
        );
      } else {
        warnings.push(
          `QBO ${period.label || period.key} metrics are blank because live fetch failed: ${error?.message || error}`
        );
      }
    }
  }

  return { map, warnings, source: warnings.length ? "partial" : "live" };
}
