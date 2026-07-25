import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { getPool } from "../db.js";
import {
  DEFAULT_QBO_ENTITY_ID,
  buildQboClientConfig,
  getQboPathEnv,
  getQboEntityId,
  getQboEntityName,
  getQboEnv
} from "./qboConfig.js";
import { QuickBooksClient } from "./quickBooksClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const DEFAULT_QBO_BACKUP_CSV_PATH = path.resolve(repoRoot, "apps/api/data/qbo/fullfarmcsa.csv");
const QBO_BACKUP_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function isExpenseSection(row) {
  const label = normalizeReportLabel(row?.Header?.ColData?.[0]?.value);
  return label.includes("expense");
}

function isIncomeSection(row) {
  const label = normalizeReportLabel(row?.Header?.ColData?.[0]?.value);
  return label.includes("income") && !label.includes("other");
}

function isPayrollExpenseLabel(value) {
  const label = normalizeReportLabel(value);
  return /\b(payroll|labor|labour|wage|wages|employer taxes|employee bonus)\b/.test(label);
}

function isOwnerPayrollExpenseLabel(value) {
  const label = normalizeReportLabel(value);
  return (
    label === "payroll expenses owner" ||
    label === "owner payroll expenses" ||
    label === "owner payroll" ||
    (label.includes("owner") && /\b(payroll|wage|wages|tax|taxes)\b/.test(label))
  );
}

function extractOwnerPayrollExpense(report) {
  let parentTotal = 0;
  let childTotal = 0;
  let foundParent = false;

  const visit = (row) => {
    if (!row) return;
    const label = getReportRowLabel(row);
    const normalizedLabel = normalizeReportLabel(label);
    const isOwnerParent =
      normalizedLabel === "payroll expenses owner" ||
      normalizedLabel === "owner payroll expenses" ||
      normalizedLabel === "owner payroll";

    if (isOwnerParent) {
      parentTotal += getReportRowTotal(row);
      foundParent = true;
      return;
    }

    if (isOwnerPayrollExpenseLabel(label)) {
      childTotal += getReportRowTotal(row);
    }

    const children = row?.Rows?.Row || [];
    children.forEach(visit);
  };

  getReportRows(report).forEach(visit);
  return round2(foundParent ? parentTotal : childTotal);
}

function extractQboIncomeLines(report) {
  const lines = [];
  for (const section of getReportRows(report)) {
    if (!isIncomeSection(section)) continue;
    for (const row of section?.Rows?.Row || []) {
      const label = getReportRowLabel(row);
      if (!label) continue;
      const total = round2(getReportRowTotal(row));
      if (!total) continue;
      lines.push({ label, total });
    }
  }
  return {
    incomeLines: lines,
    incomeLineMap: Object.fromEntries(lines.map((line) => [line.label, line.total]))
  };
}

function extractQboExpenseLines(report) {
  const lines = [];
  for (const section of getReportRows(report)) {
    if (!isExpenseSection(section)) continue;
    for (const row of section?.Rows?.Row || []) {
      const label = getReportRowLabel(row);
      if (!label) continue;
      const total = round2(getReportRowTotal(row));
      const isPayroll = isPayrollExpenseLabel(label);
      lines.push({
        label,
        total,
        isPayroll,
        isOwnerPayroll: isOwnerPayrollExpenseLabel(label)
      });
    }
  }
  const payrollExpense = round2(
    lines
      .filter((line) => line.isPayroll)
      .reduce((sum, line) => sum + Number(line.total || 0), 0)
  );
  const nonLaborExpense = round2(
    lines
      .filter((line) => !line.isPayroll)
      .reduce((sum, line) => sum + Number(line.total || 0), 0)
  );
  const ownerPayrollExpense = round2(
    lines
      .filter((line) => line.isOwnerPayroll)
      .reduce((sum, line) => sum + Number(line.total || 0), 0)
  );
  const resolvedOwnerPayrollExpense = ownerPayrollExpense || extractOwnerPayrollExpense(report);
  return {
    expenseLines: lines,
    expenseLineMap: Object.fromEntries(lines.map((line) => [line.label, line.total])),
    payrollExpense,
    payrollEmployeeExpense: round2(payrollExpense - resolvedOwnerPayrollExpense),
    payrollEmployerExpense: round2(resolvedOwnerPayrollExpense),
    ownerPayrollExpense: resolvedOwnerPayrollExpense,
    nonLaborExpense
  };
}

function parseRawReport(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

function formatDateYmd(date) {
  return date.toISOString().slice(0, 10);
}

function getMonthEndYmd(monthStart) {
  const match = String(monthStart || "").match(/^(\d{4})-(\d{2})-01$/);
  if (!match) return "";
  return formatDateYmd(new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)));
}

function addMonthsYmd(monthStart, count = 1) {
  const match = String(monthStart || "").match(/^(\d{4})-(\d{2})-01$/);
  if (!match) return "";
  return formatDateYmd(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + count, 1)));
}

function getWholeMonthStartsForPeriod(start, end) {
  const startValue = String(start || "");
  const endValue = String(end || "");
  const endMatch = endValue.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!/^\d{4}-\d{2}-01$/.test(startValue)) return [];
  if (!endMatch) return [];
  if (getMonthEndYmd(`${endMatch[1]}-${endMatch[2]}-01`) !== endValue) return [];

  const months = [];
  let monthStart = startValue;
  while (monthStart && monthStart <= endValue) {
    months.push(monthStart);
    monthStart = addMonthsYmd(monthStart, 1);
    if (months.length > 240) return [];
  }
  return months;
}

function parseQboBackupMonthHeader(value) {
  const raw = String(value || "").trim();
  const labelMatch = raw.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
  const dateMatch = raw.match(/^(\d{1,2})\/1\/(\d{2}|\d{4})$/);
  let monthIndex = -1;
  let year = null;
  if (labelMatch) {
    monthIndex = QBO_BACKUP_MONTH_LABELS.findIndex(
      (label) => label.toLowerCase() === labelMatch[1].toLowerCase()
    );
    year = Number(labelMatch[2]);
  } else if (dateMatch) {
    monthIndex = Number(dateMatch[1]) - 1;
    year = Number(dateMatch[2]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  }
  if (monthIndex < 0 || monthIndex > 11 || !Number.isFinite(year)) return null;
  const monthStart = `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
  return {
    label: `${QBO_BACKUP_MONTH_LABELS[monthIndex]} ${year}`,
    monthStart,
    monthEnd: getMonthEndYmd(monthStart)
  };
}

function normalizeCsvReportLabel(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findCsvReportRow(rows = [], labels = []) {
  const targets = new Set(labels.map((label) => normalizeCsvReportLabel(label)).filter(Boolean));
  return rows.find((row) => targets.has(normalizeCsvReportLabel(row?.[0]))) || null;
}

function getCsvRowValue(row, columnIndex) {
  if (!row) return 0;
  return parseReportNumber(row[columnIndex]);
}

function getCsvRowMonthValues(row, monthColumns = []) {
  return Object.fromEntries(
    monthColumns.map((month) => [month.monthStart, round2(getCsvRowValue(row, month.columnIndex))])
  );
}

function addMonthlyValues(target, source = {}) {
  Object.entries(source || {}).forEach(([monthStart, value]) => {
    target[monthStart] = round2(Number(target[monthStart] || 0) + Number(value || 0));
  });
}

function buildQboBackupMetric({
  entityId,
  entityName,
  source,
  fetchedAt,
  income = 0,
  cogs = 0,
  grossProfit = null,
  expenses = 0,
  otherIncome = 0,
  otherExpenses = 0,
  otherIncomeExpenses = null,
  netOperatingIncome = null,
  netIncome = 0,
  memberPayments = 0,
  payrollExpense = 0,
  payrollEmployeeExpense = 0,
  payrollEmployerExpense = 0,
  ownerPayrollExpense = 0,
  incomeLines = [],
  expenseLines = []
} = {}) {
  const incomeLineMap = Object.fromEntries(
    incomeLines.map((line) => [line.label, round2(line.total)])
  );
  const expenseLineMap = Object.fromEntries(
    expenseLines.map((line) => [line.label, round2(line.total)])
  );
  const nonLaborExpense = round2(
    expenseLines
      .filter((line) => !line.isPayroll)
      .reduce((sum, line) => sum + Number(line.total || 0), 0)
  );
  const hasPayrollSplit = Boolean(Number(payrollEmployeeExpense || 0) || Number(payrollEmployerExpense || 0));
  return {
    entityId,
    entityName,
    income: round2(income),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit === null || typeof grossProfit === "undefined" ? income - cogs : grossProfit),
    expenses: round2(expenses),
    otherIncome: round2(otherIncome),
    otherExpenses: round2(otherExpenses),
    otherIncomeExpenses: round2(
      otherIncomeExpenses === null || typeof otherIncomeExpenses === "undefined"
        ? Number(otherIncome || 0) - Number(otherExpenses || 0)
        : otherIncomeExpenses
    ),
    netOperatingIncome: round2(
      netOperatingIncome === null || typeof netOperatingIncome === "undefined"
        ? Number(income || 0) - Number(cogs || 0) - Number(expenses || 0)
        : netOperatingIncome
    ),
    netIncome: round2(netIncome),
    memberPayments: round2(memberPayments),
    incomeLines: incomeLines.map((line) => ({
      label: line.label,
      total: round2(line.total)
    })),
    incomeLineMap,
    expenseLines: expenseLines.map((line) => ({
      label: line.label,
      total: round2(line.total),
      isPayroll: Boolean(line.isPayroll),
      isOwnerPayroll: Boolean(line.isOwnerPayroll)
    })),
    expenseLineMap,
    payrollExpense: round2(payrollExpense),
    payrollEmployeeExpense: round2(hasPayrollSplit ? payrollEmployeeExpense : payrollExpense),
    payrollEmployerExpense: round2(payrollEmployerExpense),
    ownerPayrollExpense: round2(ownerPayrollExpense),
    nonLaborExpense,
    fetchedAt,
    source
  };
}

function collectQboBackupIncomeLines(rows = [], monthColumns = []) {
  const incomeStartIndex = rows.findIndex((row) => normalizeCsvReportLabel(row?.[0]) === "income");
  const incomeEndIndex = rows.findIndex(
    (row, index) => index > incomeStartIndex && normalizeCsvReportLabel(row?.[0]) === "total for income"
  );
  if (incomeStartIndex < 0 || incomeEndIndex < 0) return [];

  const incomeLines = [];
  for (let index = incomeStartIndex + 1; index < incomeEndIndex; index += 1) {
    const row = rows[index];
    const label = String(row?.[0] || "").trim();
    const normalizedLabel = normalizeCsvReportLabel(label);
    if (!label || normalizedLabel.startsWith("total for ")) continue;

    const values = getCsvRowMonthValues(row, monthColumns);
    const total = round2(Object.values(values).reduce((sum, value) => sum + Number(value || 0), 0));
    if (!total) continue;
    incomeLines.push({ label, values, total });
  }

  return incomeLines;
}

function collectQboBackupExpenseLines(rows = [], monthColumns = []) {
  const expenseStartIndex = rows.findIndex((row) => normalizeCsvReportLabel(row?.[0]) === "expenses");
  const expenseEndIndex = rows.findIndex(
    (row, index) => index > expenseStartIndex && normalizeCsvReportLabel(row?.[0]) === "total for expenses"
  );
  if (expenseStartIndex < 0 || expenseEndIndex < 0) {
    return {
      expenseLines: [],
      extraPayrollValues: {},
      ownerPayrollValues: {},
      employeePayrollValues: {},
      employerPayrollValues: {}
    };
  }

  const expenseLines = [];
  const extraPayrollValues = {};
  const ownerPayrollValues = {};
  const employeePayrollValues = {};
  const employerPayrollValues = {};
  let pendingOwnerPayrollValues = {};
  let inPayrollSection = false;
  let inOwnerPayrollSection = false;
  for (let index = expenseStartIndex + 1; index < expenseEndIndex; index += 1) {
    const row = rows[index];
    const label = String(row?.[0] || "").trim();
    const normalizedLabel = normalizeCsvReportLabel(label);
    if (!label) continue;

    if (inOwnerPayrollSection && normalizedLabel === "total for payroll expenses owner") {
      const values = getCsvRowMonthValues(row, monthColumns);
      addMonthlyValues(ownerPayrollValues, values);
      addMonthlyValues(employerPayrollValues, values);
      addMonthlyValues(extraPayrollValues, values);
      pendingOwnerPayrollValues = {};
      inOwnerPayrollSection = false;
      continue;
    }
    if (normalizedLabel === "payroll expenses") {
      const values = getCsvRowMonthValues(row, monthColumns);
      addMonthlyValues(employeePayrollValues, values);
      inPayrollSection = true;
      continue;
    }
    if (
      normalizedLabel === "payroll expenses owner" ||
      normalizedLabel === "owner payroll expenses" ||
      normalizedLabel === "owner payroll"
    ) {
      inOwnerPayrollSection = true;
      pendingOwnerPayrollValues = {};
      continue;
    }
    if (normalizedLabel === "total for payroll expenses") {
      inPayrollSection = false;
      continue;
    }
    if (inOwnerPayrollSection) {
      const values = getCsvRowMonthValues(row, monthColumns);
      addMonthlyValues(employerPayrollValues, values);
      addMonthlyValues(pendingOwnerPayrollValues, values);
      continue;
    }

    if (inPayrollSection) {
      const values = getCsvRowMonthValues(row, monthColumns);
      if (normalizedLabel === "employee wages" || normalizedLabel === "employer taxes") {
        addMonthlyValues(ownerPayrollValues, values);
        addMonthlyValues(employerPayrollValues, values);
      } else {
        addMonthlyValues(employeePayrollValues, values);
      }
      continue;
    }
    if (normalizedLabel.startsWith("total for ")) continue;

    const values = getCsvRowMonthValues(row, monthColumns);
    const total = round2(Object.values(values).reduce((sum, value) => sum + Number(value || 0), 0));
    if (!total) continue;

    if (isOwnerPayrollExpenseLabel(label)) {
      addMonthlyValues(ownerPayrollValues, values);
      addMonthlyValues(extraPayrollValues, values);
      addMonthlyValues(employerPayrollValues, values);
      continue;
    }

    if (isPayrollExpenseLabel(label)) {
      addMonthlyValues(extraPayrollValues, values);
      addMonthlyValues(employeePayrollValues, values);
      continue;
    }

    expenseLines.push({
      label,
      values,
      total,
      isPayroll: false
    });
  }

  addMonthlyValues(ownerPayrollValues, pendingOwnerPayrollValues);
  addMonthlyValues(employerPayrollValues, pendingOwnerPayrollValues);
  addMonthlyValues(extraPayrollValues, pendingOwnerPayrollValues);

  return {
    expenseLines,
    extraPayrollValues,
    ownerPayrollValues,
    employeePayrollValues,
    employerPayrollValues
  };
}

function readQboBackupCsvMetrics({ entityId, entityName } = {}) {
  const csvPath = getQboPathEnv("DASHBOARD_QBO_BACKUP_CSV_PATH", DEFAULT_QBO_BACKUP_CSV_PATH);
  if (!csvPath || !fs.existsSync(csvPath)) return {};

  const stat = fs.statSync(csvPath);
  const workbook = xlsx.read(fs.readFileSync(csvPath, "utf8"), { type: "string" });
  const worksheet = workbook.Sheets[workbook.SheetNames?.[0]];
  if (!worksheet) return {};

  const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: "" });
  const headerRowIndex = rows.findIndex((row) => row.some((cell) => parseQboBackupMonthHeader(cell)));
  if (headerRowIndex < 0) return {};

  const monthColumns = rows[headerRowIndex]
    .map((cell, columnIndex) => {
      const parsed = parseQboBackupMonthHeader(cell);
      return parsed ? { ...parsed, columnIndex } : null;
    })
    .filter(Boolean);
  if (!monthColumns.length) return {};

  const incomeValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Total for Income"]), monthColumns);
  const cogsValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Total for Cost of Goods Sold"]), monthColumns);
  const grossProfitValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Gross Profit"]), monthColumns);
  const expensesValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Total for Expenses"]), monthColumns);
  const netOperatingIncomeValues = getCsvRowMonthValues(
    findCsvReportRow(rows, ["Net Operating Income"]),
    monthColumns
  );
  const netIncomeValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Net Income"]), monthColumns);
  const memberPaymentsValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Member Payments"]), monthColumns);
  const payrollValues = getCsvRowMonthValues(findCsvReportRow(rows, ["Total for Payroll Expenses"]), monthColumns);
  const rawIncomeLines = collectQboBackupIncomeLines(rows, monthColumns);
  const {
    expenseLines: rawExpenseLines,
    extraPayrollValues,
    ownerPayrollValues,
    employeePayrollValues,
    employerPayrollValues
  } = collectQboBackupExpenseLines(rows, monthColumns);
  addMonthlyValues(payrollValues, extraPayrollValues);

  return Object.fromEntries(
    monthColumns.map((month) => {
      const monthIncomeLines = rawIncomeLines
        .map((line) => ({
          label: line.label,
          total: round2(Number(line.values?.[month.monthStart] || 0))
        }))
        .filter((line) => line.total);
      const monthExpenseLines = rawExpenseLines
        .map((line) => ({
          label: line.label,
          total: round2(Number(line.values?.[month.monthStart] || 0)),
          isPayroll: false
        }))
        .filter((line) => line.total);
      const nonLaborExpense = round2(
        monthExpenseLines.reduce((sum, line) => sum + Number(line.total || 0), 0)
      );
      const expenseRemainder = round2(
        Number(expensesValues[month.monthStart] || 0) -
          Number(payrollValues[month.monthStart] || 0) -
          nonLaborExpense
      );
      if (expenseRemainder) {
        monthExpenseLines.push({
          label: "Other QBO Expenses",
          total: expenseRemainder,
          isPayroll: false
        });
      }

      return [
        month.monthStart,
        buildQboBackupMetric({
          entityId,
          entityName,
          source: "backup-csv",
          fetchedAt: stat.mtime.toISOString(),
          income: incomeValues[month.monthStart],
          cogs: cogsValues[month.monthStart],
          grossProfit: grossProfitValues[month.monthStart],
          expenses: expensesValues[month.monthStart],
          netOperatingIncome:
            netOperatingIncomeValues[month.monthStart] ||
            round2(
              Number(grossProfitValues[month.monthStart] || 0) -
                Number(expensesValues[month.monthStart] || 0)
            ),
          otherIncomeExpenses: round2(
            Number(netIncomeValues[month.monthStart] || 0) -
              Number(
                netOperatingIncomeValues[month.monthStart] ||
                  round2(
                    Number(grossProfitValues[month.monthStart] || 0) -
                      Number(expensesValues[month.monthStart] || 0)
                  )
              )
          ),
          netIncome: netIncomeValues[month.monthStart],
          memberPayments: memberPaymentsValues[month.monthStart],
          payrollExpense: payrollValues[month.monthStart],
          payrollEmployeeExpense: employeePayrollValues[month.monthStart],
          payrollEmployerExpense: employerPayrollValues[month.monthStart],
          ownerPayrollExpense: ownerPayrollValues[month.monthStart],
          incomeLines: monthIncomeLines,
          expenseLines: monthExpenseLines
        })
      ];
    })
  );
}

function aggregateQboMetrics(metricsList = [], { entityId, entityName, source, fetchedAt } = {}) {
  const fields = [
    "income",
    "cogs",
    "grossProfit",
    "expenses",
    "otherIncome",
    "otherExpenses",
    "otherIncomeExpenses",
    "netOperatingIncome",
    "netIncome",
    "memberPayments",
    "payrollExpense",
    "payrollEmployeeExpense",
    "payrollEmployerExpense",
    "ownerPayrollExpense",
    "nonLaborExpense"
  ];
  const aggregate = Object.fromEntries(fields.map((field) => [field, 0]));
  const incomeLineMap = new Map();
  const expenseLineMap = new Map();
  const expenseLinePayrollFlags = new Map();
  const expenseLineOwnerPayrollFlags = new Map();

  metricsList.forEach((metrics) => {
    fields.forEach((field) => {
      aggregate[field] = round2(Number(aggregate[field] || 0) + Number(metrics?.[field] || 0));
    });
    (metrics?.incomeLines || []).forEach((line) => {
      if (!line?.label) return;
      const label = String(line.label);
      incomeLineMap.set(label, round2(Number(incomeLineMap.get(label) || 0) + Number(line.total || 0)));
    });
    (metrics?.expenseLines || []).forEach((line) => {
      if (!line?.label) return;
      const label = String(line.label);
      expenseLineMap.set(label, round2(Number(expenseLineMap.get(label) || 0) + Number(line.total || 0)));
      expenseLinePayrollFlags.set(label, Boolean(line.isPayroll));
      expenseLineOwnerPayrollFlags.set(label, Boolean(line.isOwnerPayroll));
    });
  });

  const incomeLines = [...incomeLineMap.entries()].map(([label, total]) => ({
    label,
    total
  }));
  const expenseLines = [...expenseLineMap.entries()].map(([label, total]) => ({
    label,
    total,
    isPayroll: Boolean(expenseLinePayrollFlags.get(label)),
    isOwnerPayroll: Boolean(expenseLineOwnerPayrollFlags.get(label))
  }));

  return buildQboBackupMetric({
    entityId,
    entityName,
    source,
    fetchedAt,
    ...aggregate,
    incomeLines,
    expenseLines
  });
}

function loadBackupQboPeriodMetrics(periods = [], { entityId, entityName } = {}) {
  let monthlyMetrics = {};
  try {
    monthlyMetrics = readQboBackupCsvMetrics({ entityId, entityName });
  } catch (_error) {
    return {};
  }

  return Object.fromEntries(
    periods
      .map((period) => {
        const monthStarts = getWholeMonthStartsForPeriod(period?.start, period?.end);
        if (!monthStarts.length) return null;
        const metricsList = monthStarts.map((monthStart) => monthlyMetrics[monthStart]);
        if (metricsList.some((metrics) => !metrics)) return null;
        const fetchedAt = metricsList
          .map((metrics) => metrics?.fetchedAt)
          .filter(Boolean)
          .sort()
          .at(-1);
        const metrics =
          metricsList.length === 1
            ? { ...metricsList[0] }
            : aggregateQboMetrics(metricsList, {
                entityId,
                entityName,
                source: "backup-csv",
                fetchedAt
              });
        return [period.key, { ...metrics, source: "backup-csv" }];
      })
      .filter(Boolean)
  );
}

export function parseDashboardPnlReport(report, { entityId = DEFAULT_QBO_ENTITY_ID, entityName = entityId } = {}) {
  let income = 0;
  let cogs = 0;
  let expenses = 0;
  let otherIncome = 0;
  let otherExpenses = 0;
  let netOperatingIncome = null;
  let netIncome = null;
  const incomeSummary = extractQboIncomeLines(report);
  const expenseSummary = extractQboExpenseLines(report);

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
    } else if (header.includes("other expense")) {
      otherExpenses += totalFromSection(row);
    }

    const summaryLabel = normalizeReportLabel(row?.Summary?.ColData?.[0]?.value);
    if (summaryLabel.includes("net operating income")) {
      netOperatingIncome = totalFromSection(row);
    } else if (summaryLabel.includes("net income")) {
      netIncome = totalFromSection(row);
    }
  }

  if (netOperatingIncome === null || typeof netOperatingIncome === "undefined") {
    netOperatingIncome = income - cogs - expenses;
  }

  if (netIncome === null || typeof netIncome === "undefined") {
    netIncome = netOperatingIncome + otherIncome - otherExpenses;
  }

  return {
    entityId,
    entityName,
    income: round2(income),
    cogs: round2(cogs),
    grossProfit: round2(income - cogs),
    expenses: round2(expenses),
    otherIncome: round2(otherIncome),
    otherExpenses: round2(otherExpenses),
    otherIncomeExpenses: round2(netIncome - netOperatingIncome),
    netOperatingIncome: round2(netOperatingIncome),
    netIncome: round2(netIncome),
    memberPayments: round2(extractReportLinesTotal(report, ["Member Payments"])),
    ...incomeSummary,
    ...expenseSummary
  };
}

function fromCacheRow(row) {
  if (!row) return null;
  const cachedReport = parseRawReport(row.raw_json);
  const parsedReport = cachedReport
    ? parseDashboardPnlReport(cachedReport, {
        entityId: row.entity_id,
        entityName: getQboEntityName(row.entity_id)
      })
    : null;
  return {
    entityId: row.entity_id,
    income: Number(row.income || 0),
    cogs: Number(row.cogs || 0),
    grossProfit: Number(row.gross_profit || 0),
    expenses: Number(row.expenses || 0),
    otherIncome: Number(row.other_income || parsedReport?.otherIncome || 0),
    otherExpenses: Number(parsedReport?.otherExpenses || 0),
    otherIncomeExpenses: Number(
      parsedReport?.otherIncomeExpenses ??
        Number(row.net_income || 0) -
          (Number(row.gross_profit || 0) - Number(row.expenses || 0))
    ),
    netOperatingIncome: Number(
      parsedReport?.netOperatingIncome ??
        Number(row.gross_profit || 0) - Number(row.expenses || 0)
    ),
    netIncome: Number(row.net_income || 0),
    memberPayments: Number(row.member_payments || 0),
    incomeLines: parsedReport?.incomeLines || [],
    incomeLineMap: parsedReport?.incomeLineMap || {},
    expenseLines: parsedReport?.expenseLines || [],
    expenseLineMap: parsedReport?.expenseLineMap || {},
    payrollExpense: Number(parsedReport?.payrollExpense || 0),
    payrollEmployeeExpense: Number(parsedReport?.payrollEmployeeExpense || parsedReport?.payrollExpense || 0),
    payrollEmployerExpense: Number(parsedReport?.payrollEmployerExpense || 0),
    ownerPayrollExpense: Number(parsedReport?.ownerPayrollExpense || 0),
    nonLaborExpense: Number(parsedReport?.nonLaborExpense || 0),
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
            raw_json,
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

function shouldStopQboLiveAttempts(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("qbo token refresh failed") ||
    message.includes("invalid_grant") ||
    message.includes("fetch failed") ||
    message.includes("connect timeout")
  );
}

export async function loadDashboardQboPeriodMetrics(periods = [], { connection = null } = {}) {
  const activePeriods = periods.filter(
    (period) => period?.key && period?.start && period?.end && period.started !== false
  );
  if (!activePeriods.length) return { map: {}, warnings: [], source: "empty" };

  const entityId = getQboEntityId();
  const cachedMetrics = await loadCachedQboPeriodMetrics(activePeriods, { connection }).catch(() => ({}));
  const backupMetrics = loadBackupQboPeriodMetrics(activePeriods, {
    entityId,
    entityName: getQboEntityName(entityId)
  });
  const fallbackForPeriod = (period) => {
    if (backupMetrics[period.key]) return { metrics: backupMetrics[period.key], label: "backup CSV values" };
    if (cachedMetrics[period.key]) return { metrics: cachedMetrics[period.key], label: "cached values" };
    return null;
  };
  const fallbackMap = Object.fromEntries(
    activePeriods
      .map((period) => {
        const fallback = fallbackForPeriod(period);
        return fallback ? [period.key, fallback.metrics] : null;
      })
      .filter(Boolean)
  );
  const qboEnabled = String(getQboEnv("DASHBOARD_QBO_ENABLED", "true")).toLowerCase() !== "false";
  if (!qboEnabled) {
    return {
      map: fallbackMap,
      warnings: Object.keys(fallbackMap).length
        ? ["QBO dashboard metrics are disabled; using local backup/cached QBO reconciliation values."]
        : ["QBO dashboard metrics are disabled; reconciliation rows are blank."],
      source: "disabled"
    };
  }

  const { config, missingEnv } = buildQboClientConfig(entityId);
  if (!config) {
    const missing = missingEnv.map((key) => `QBO_${entityId}_${key}`).join(", ");
    return {
      map: fallbackMap,
      warnings: Object.keys(fallbackMap).length
        ? [`QBO dashboard metrics are using local backup/cached values because live config is missing: ${missing}.`]
        : [`QBO dashboard metrics are blank because live config is missing: ${missing}.`],
      source: "cache"
    };
  }

  const client = new QuickBooksClient(config);
  const map = {};
  const warnings = [];
  let stoppedLiveAttemptsMessage = "";
  let skippedLivePeriodCount = 0;
  let skippedLiveBackupCount = 0;
  let skippedLiveCachedCount = 0;
  let skippedLiveBlankCount = 0;

  for (const period of activePeriods) {
    if (stoppedLiveAttemptsMessage) {
      const fallback = fallbackForPeriod(period);
      if (fallback) {
        map[period.key] = fallback.metrics;
        if (fallback.metrics?.source === "backup-csv") {
          skippedLiveBackupCount += 1;
        } else {
          skippedLiveCachedCount += 1;
        }
      } else {
        skippedLiveBlankCount += 1;
      }
      skippedLivePeriodCount += 1;
      continue;
    }

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
      if (shouldStopQboLiveAttempts(error)) {
        stoppedLiveAttemptsMessage = error?.message || String(error);
      }
      const fallback = fallbackForPeriod(period);
      if (fallback) {
        map[period.key] = fallback.metrics;
        warnings.push(
          `QBO ${period.label || period.key} metrics used ${fallback.label} because live fetch failed: ${error?.message || error}`
        );
      } else {
        warnings.push(
          `QBO ${period.label || period.key} metrics are blank because live fetch failed: ${error?.message || error}`
        );
      }
    }
  }

  if (skippedLivePeriodCount) {
    warnings.push(
      `QBO live fetch was skipped for ${skippedLivePeriodCount} later periods after an earlier failure: ${stoppedLiveAttemptsMessage}. Backup CSV values used for ${skippedLiveBackupCount}; cached values used for ${skippedLiveCachedCount}; blank for ${skippedLiveBlankCount}.`
    );
  }

  return { map, warnings, source: warnings.length ? "partial" : "live" };
}
