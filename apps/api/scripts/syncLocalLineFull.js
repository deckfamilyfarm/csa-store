import path from "path";
import { fileURLToPath } from "url";
import { runLocalLineAudit } from "./auditLocalLineSync.js";
import { runLocalLineCacheSync } from "./syncLocalLineCache.js";

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
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(repoRoot, targetPath);
}

export async function runLocalLineFullSync(options = {}) {
  const killdeerEnvPath = options.killdeerEnvPath || undefined;
  const skipPricelist = options.skipPricelist !== false;
  const forceFull = Boolean(options.forceFull);
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 6;
  const liveRefreshHours =
    Number.isFinite(options.liveRefreshHours) ? options.liveRefreshHours : undefined;
  const includeInactive = Boolean(options.includeInactive);
  const auditReportFile = resolveFromRepoRoot(
    options.auditReportFile || path.join("tmp", "localline-full-sync-audit-report.json")
  );
  const cacheReportFile = resolveFromRepoRoot(
    options.cacheReportFile || path.join("tmp", "localline-full-sync-cache-report.json")
  );
  const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const actionableFixKeys = [
    "create-store-products",
    "sync-store-catalog-fields",
    "repair-package-shape"
  ];

  const auditResult = await runLocalLineAudit({
    killdeerEnvPath,
    skipPricelist,
    reportFile: auditReportFile,
    includeInactive,
    write: true,
    selectedFixKeys: actionableFixKeys,
    concurrency,
    limit: Number.isFinite(options.limit) ? options.limit : 20,
    onProgress: reportProgress
  });

  const cacheResult = await runLocalLineCacheSync({
    write: true,
    forceFull,
    concurrency,
    liveRefreshHours,
    reportFile: cacheReportFile,
    limit: Number.isFinite(options.cacheLimit) ? options.cacheLimit : null,
    onProgress: reportProgress
  });

  reportProgress({
    phaseKey: "finalize",
    phaseLabel: "Finalize",
    status: "completed",
    percent: 100,
    message: "Local Line full sync complete"
  });

  return {
    mode: "apply",
    reportFiles: {
      audit: auditResult.summary.reportFile,
      cache: cacheResult.reportFile
    },
    audit: auditResult.summary,
    cache: cacheResult.summary,
    fullSummary: {
      appliedCatalogChanges: auditResult.summary.applySummary?.applied || 0,
      createdProducts: auditResult.summary.applySummary?.createdProducts || 0,
      updatedProducts: auditResult.summary.applySummary?.updatedProducts || 0,
      updatedPackages: auditResult.summary.applySummary?.updatedPackages || 0,
      priceLists: cacheResult.summary.exportSummary.priceLists || 0,
      packagePriceListMemberships: cacheResult.summary.exportSummary.packagePriceListMemberships || 0,
      productPriceListMemberships: cacheResult.summary.exportSummary.productPriceListMemberships || 0,
      cachedMediaRows: cacheResult.summary.exportSummary.productMediaRows || 0,
      mirroredProductImageRows: cacheResult.summary.exportSummary.mirroredProductImageRows || 0,
      syncIssueRows: cacheResult.summary.exportSummary.syncIssueRows || 0
    }
  };
}

async function main() {
  const result = await runLocalLineFullSync({
    killdeerEnvPath: getArg("killdeer-env") || undefined,
    skipPricelist: !hasFlag("with-pricelist"),
    forceFull: hasFlag("force-full"),
    includeInactive: hasFlag("include-inactive"),
    concurrency: Number(getArg("concurrency") || 6),
    liveRefreshHours: getArg("live-refresh-hours")
      ? Number(getArg("live-refresh-hours"))
      : undefined,
    limit: Number(getArg("limit") || 20),
    cacheLimit: getArg("cache-limit") ? Number(getArg("cache-limit")) : null,
    auditReportFile: getArg("audit-report-file") || path.join("tmp", "localline-full-sync-audit-report.json"),
    cacheReportFile: getArg("cache-report-file") || path.join("tmp", "localline-full-sync-cache-report.json")
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
