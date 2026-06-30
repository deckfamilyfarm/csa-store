import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { ensureLocalLineSyncSchema, getPool } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(`--${flag}`);
}

function getArg(name) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function resolveFromRepoRoot(targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
}

function parseMoney(value) {
  if (value === null || typeof value === "undefined") return 0;
  const numeric = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseYmd(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function addDaysYmd(ymd, days) {
  const date = parseYmd(ymd);
  if (!date) return ymd;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return formatYmd(date);
}

function getMondayYmd(ymd) {
  const date = parseYmd(ymd);
  if (!date) return ymd;
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return formatYmd(date);
}

function getCustomerStoreCreditAmount(row = {}) {
  return parseMoney(
    row["Store Credit"] ??
      row["Store credit"] ??
      row["Store credit balance"] ??
      row.store_credit ??
      row.store_credit_balance ??
      0
  );
}

function summarizeCustomerExport(filePath) {
  const workbook = xlsx.read(fs.readFileSync(filePath), { type: "buffer" });
  const sheetName = workbook.SheetNames?.[0];
  const worksheet = sheetName ? workbook.Sheets[sheetName] : null;
  const rows = worksheet ? xlsx.utils.sheet_to_json(worksheet, { raw: false, defval: "" }) : [];
  let totalBalance = 0;
  let nonzeroBalanceCustomerCount = 0;

  rows.forEach((row) => {
    const balance = getCustomerStoreCreditAmount(row);
    totalBalance += balance;
    if (Math.abs(balance) > 0.005) {
      nonzeroBalanceCustomerCount += 1;
    }
  });

  return {
    customerCount: rows.length,
    nonzeroBalanceCustomerCount,
    totalBalance: Math.round(totalBalance * 100) / 100
  };
}

export function buildCustomerCreditSnapshotRecords(options = {}) {
  const dataDir = resolveFromRepoRoot(
    options.dataDir || "../ffcsa_scripts/localline/data"
  );
  const includeEmpty = Boolean(options.includeEmpty);
  const skipped = [];
  const files = fs.readdirSync(dataDir)
    .filter((file) => /^customers(?:_new)?_\d{4}-\d{2}-\d{2}\.csv$/.test(file))
    .sort();
  const byWeek = new Map();

  files.forEach((file) => {
    const fileDate = file.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!fileDate) return;
    const summary = summarizeCustomerExport(path.join(dataDir, file));
    if (!summary.customerCount && !includeEmpty) {
      skipped.push({ file, reason: "empty export" });
      return;
    }
    const snapshotWeekStart = getMondayYmd(fileDate);
    const record = {
      sourceFile: file,
      fileDate,
      snapshotWeekStart,
      snapshotWeekEnd: addDaysYmd(snapshotWeekStart, 6),
      ...summary
    };
    const previous = byWeek.get(snapshotWeekStart);
    if (
      !previous ||
      record.fileDate > previous.fileDate ||
      (record.fileDate === previous.fileDate && record.customerCount > previous.customerCount)
    ) {
      byWeek.set(snapshotWeekStart, record);
    }
  });

  return {
    dataDir,
    filesFound: files.length,
    skipped,
    records: Array.from(byWeek.values()).sort((left, right) =>
      left.snapshotWeekStart.localeCompare(right.snapshotWeekStart)
    )
  };
}

export async function backfillLocalLineCustomerCreditSnapshots(options = {}) {
  const { dataDir, filesFound, skipped, records } = buildCustomerCreditSnapshotRecords(options);
  if (options.dryRun) {
    return { dataDir, filesFound, skipped, weeklySnapshotsUpserted: 0, records };
  }

  const pool = getPool();
  await ensureLocalLineSyncSchema(pool);
  const now = new Date();

  for (const record of records) {
    const capturedAt = new Date(`${record.fileDate}T12:00:00Z`);
    const summaryJson = JSON.stringify({
      source: "legacy_customer_export_backfill",
      sourceFile: record.sourceFile,
      fileDate: record.fileDate,
      customerCount: record.customerCount,
      nonzeroBalanceCustomerCount: record.nonzeroBalanceCustomerCount,
      totalBalance: record.totalBalance
    });
    await pool.query(
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
        record.snapshotWeekStart,
        record.snapshotWeekEnd,
        record.customerCount,
        record.nonzeroBalanceCustomerCount,
        record.totalBalance,
        capturedAt,
        summaryJson,
        now,
        now
      ]
    );
  }

  await pool.end();
  return { dataDir, filesFound, skipped, weeklySnapshotsUpserted: records.length, records };
}

async function main() {
  const result = await backfillLocalLineCustomerCreditSnapshots({
    dataDir: getArg("data-dir") || undefined,
    includeEmpty: hasFlag("include-empty"),
    dryRun: hasFlag("dry-run")
  });
  console.log(JSON.stringify({
    dataDir: result.dataDir,
    filesFound: result.filesFound,
    skipped: result.skipped,
    weeklySnapshotsUpserted: result.weeklySnapshotsUpserted,
    firstSnapshots: result.records.slice(0, 5),
    lastSnapshots: result.records.slice(-10)
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
