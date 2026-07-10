import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { buildQboClientConfig, describeQboConfig, getQboEntityId } from "../lib/qboConfig.js";
import { QuickBooksClient } from "../lib/quickBooksClient.js";
import { parseDashboardPnlReport } from "../lib/qboDashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");

dotenv.config({ path: path.resolve(repoRoot, ".env"), override: false });

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function formatYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function getDefaultStartDate() {
  const now = new Date();
  return `${now.getUTCFullYear()}-01-01`;
}

function getDefaultEndDate() {
  return formatYmd(new Date());
}

async function main() {
  const entityId = getArg("entity", getQboEntityId());
  const startDate = getArg("start", getDefaultStartDate());
  const endDate = getArg("end", getDefaultEndDate());
  const skipReport = hasFlag("skip-report");
  const description = describeQboConfig(entityId);

  if (!description.configured) {
    console.error("QBO is not configured for this entity.");
    console.error(`Missing: ${description.missingEnv.join(", ")}`);
    console.error(`Token store path: ${description.tokenStorePath}`);
    if (description.envSources.length) {
      console.error("Env files checked:");
      description.envSources.forEach((source) => console.error(`- ${source.label}: ${source.path}`));
    }
    process.exitCode = 1;
    return;
  }

  const { config } = buildQboClientConfig(entityId);
  const client = new QuickBooksClient(config);
  const companyInfo = await client.fetchCompanyInfo();
  const company = companyInfo?.CompanyInfo || {};

  const result = {
    ok: true,
    entityId,
    env: description.env,
    realmId: description.realmId,
    companyName: company.CompanyName || company.LegalName || null,
    companyId: company.Id || null,
    tokenStorePath: description.tokenStorePath,
    fallbackTokenStorePath: description.fallbackTokenStorePath,
    accountingMethod: description.accountingMethod
  };

  if (!skipReport) {
    const report = await client.fetchProfitAndLoss(startDate, endDate);
    result.profitAndLoss = {
      startDate,
      endDate,
      ...parseDashboardPnlReport(report, {
        entityId,
        entityName: result.companyName || entityId
      })
    };
  }

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
