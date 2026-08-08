import path from "path";
import { fileURLToPath } from "url";
import { ensureSubscriptionPortalSchema, getPool } from "../db.js";
import {
  enforceHerdSharePriceListMembers,
  enforceLinkedHerdShareCustomerPriceListDefaults,
  getConfiguredHerdSharePriceListId
} from "../lib/localLinePriceListMembers.js";

const __filename = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(`--${flag}`);
}

function getArg(name) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function parseInteger(value, fallback = null) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function runHerdSharePriceListMemberSync(options = {}) {
  const herdSharePriceListId = parseInteger(
    options.herdSharePriceListId,
    getConfiguredHerdSharePriceListId()
  );
  const dryRun = options.dryRun !== false;
  const linkedOnly = Boolean(options.linkedOnly);

  if (linkedOnly) {
    await ensureSubscriptionPortalSchema();
    return enforceLinkedHerdShareCustomerPriceListDefaults({
      herdSharePriceListId,
      dryRun,
      removeOtherPriceLists: Boolean(options.removeOtherPriceLists),
      throwOnError: false
    });
  }

  return enforceHerdSharePriceListMembers({
    herdSharePriceListId,
    dryRun,
    throwOnError: false
  });
}

async function main() {
  const linkedOnly = hasFlag("linked-only");
  try {
    const result = await runHerdSharePriceListMemberSync({
      herdSharePriceListId: getArg("price-list-id"),
      dryRun: !hasFlag("apply"),
      linkedOnly,
      removeOtherPriceLists: hasFlag("remove-other")
    });

    console.log(JSON.stringify(result, null, 2));
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (linkedOnly) {
      await getPool().end();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
