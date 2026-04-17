import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { ensureLocalLineSyncSchema } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const args = process.argv.slice(2);

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

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return normalizeWhitespace(
    String(value ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
  );
}

function parseYesNo(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeWhitespace(value).toUpperCase();
  if (normalized === "Y" || normalized === "YES" || normalized === "TRUE") return true;
  if (normalized === "N" || normalized === "NO" || normalized === "FALSE") return false;
  return null;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toTinyInt(value) {
  if (value === null || typeof value === "undefined") return null;
  return value ? 1 : 0;
}

function sameNumber(left, right, tolerance = 0.0001) {
  if (left === null && right === null) return true;
  if (!Number.isFinite(Number(left)) || !Number.isFinite(Number(right))) return false;
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function parsePriceListId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function computeDerivedSaleDiscount(finalPrice, strikethroughDisplayValue) {
  const finalValue = toNumber(finalPrice);
  const strikeValue = toNumber(strikethroughDisplayValue);
  if (
    !Number.isFinite(finalValue) ||
    !Number.isFinite(strikeValue) ||
    strikeValue <= finalValue ||
    strikeValue <= 0
  ) {
    return null;
  }
  return Number(((strikeValue - finalValue) / strikeValue).toFixed(2));
}

function isRealLocalLineSale(row) {
  const derivedDiscount = computeDerivedSaleDiscount(
    row.finalPriceCache,
    row.strikethroughDisplayValue
  );
  return Boolean(row.onSaleToggle) || (Number.isFinite(derivedDiscount) && derivedDiscount > 0);
}

function limitRows(rows, limit) {
  return rows.slice(0, limit);
}

function buildConfiguredPriceListChecks() {
  return [
    {
      envKey: "LL_PRICE_LIST_GUEST_ID",
      label: "Guest Basket",
      localLinePriceListId: parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID)
    },
    {
      envKey: "LL_PRICE_LIST_CSA_MEMBERS_ID",
      label: "CSA Members",
      localLinePriceListId: parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID)
    },
    {
      envKey: "LL_PRICE_LIST_HERDSHARE_ID",
      label: "Herd Share Members",
      localLinePriceListId: parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID)
    },
    {
      envKey: "LL_PRICE_LIST_SNAP_ID",
      label: "SNAP",
      localLinePriceListId: parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID)
    }
  ].filter((row) => Number.isFinite(row.localLinePriceListId));
}

async function loadState(connection) {
  const [syncRuns] = await connection.query(
    `
      SELECT
        id,
        mode,
        status,
        started_at AS startedAt,
        finished_at AS finishedAt,
        summary_json AS summaryJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM local_line_sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT 20
    `
  );

  const [products] = await connection.query(
    `
      SELECT
        id,
        name,
        description,
        visible,
        track_inventory AS trackInventory,
        inventory,
        category_id AS categoryId,
        updated_at AS updatedAt
      FROM products
    `
  );

  const [packages] = await connection.query(
    `
      SELECT
        id,
        product_id AS productId,
        name,
        price,
        package_code AS packageCode,
        visible,
        track_inventory AS trackInventory,
        inventory
      FROM packages
    `
  );

  const [productMetas] = await connection.query(
    `
      SELECT
        product_id AS productId,
        local_line_product_id AS localLineProductId,
        internal_id AS internalId,
        vendor_name AS vendorName,
        status,
        visible,
        track_inventory AS trackInventory,
        track_inventory_by AS trackInventoryBy,
        inventory_type AS inventoryType,
        product_inventory AS productInventory,
        reserved_inventory AS reservedInventory,
        available_inventory AS availableInventory,
        package_codes_enabled AS packageCodesEnabled,
        ownership_type AS ownershipType,
        packing_tag AS packingTag,
        export_hash AS exportHash,
        live_hash AS liveHash,
        last_live_fetch_status AS lastLiveFetchStatus,
        last_live_fetch_error AS lastLiveFetchError,
        raw_json AS rawJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM local_line_product_meta
    `
  );

  const [packageMetas] = await connection.query(
    `
      SELECT
        package_id AS packageId,
        product_id AS productId,
        local_line_package_id AS localLinePackageId,
        live_name AS liveName,
        live_price AS livePrice,
        live_visible AS liveVisible,
        live_track_inventory AS liveTrackInventory,
        inventory_type AS inventoryType,
        package_inventory AS packageInventory,
        package_reserved_inventory AS packageReservedInventory,
        package_available_inventory AS packageAvailableInventory,
        avg_package_weight AS avgPackageWeight,
        num_of_items AS numOfItems,
        package_code AS packageCode,
        raw_json AS rawJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM local_line_package_meta
    `
  );

  const [priceLists] = await connection.query(
    `
      SELECT
        id,
        local_line_price_list_id AS localLinePriceListId,
        name,
        active,
        source,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM price_lists
    `
  );

  const [priceListEntries] = await connection.query(
    `
      SELECT
        id,
        product_id AS productId,
        local_line_product_id AS localLineProductId,
        package_id AS packageId,
        local_line_package_id AS localLinePackageId,
        price_list_id AS priceListId,
        local_line_price_list_id AS localLinePriceListId,
        entry_scope AS entryScope,
        source_entry_id AS sourceEntryId,
        price_list_name AS priceListName,
        product_name AS productName,
        package_name AS packageName,
        visible,
        track_inventory AS trackInventory,
        package_code AS packageCode,
        adjustment_type AS adjustmentType,
        adjustment_value AS adjustmentValue,
        calculated_value AS calculatedValue,
        base_price_used AS basePriceUsed,
        final_price_cache AS finalPriceCache,
        on_sale AS onSale,
        on_sale_toggle AS onSaleToggle,
        strikethrough_display_value AS strikethroughDisplayValue,
        max_units_per_order AS maxUnitsPerOrder,
        raw_json AS rawJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM local_line_price_list_entries
    `
  );

  const [productSales] = await connection.query(
    `
      SELECT
        product_id AS productId,
        on_sale AS onSale,
        sale_discount AS saleDiscount,
        updated_at AS updatedAt
      FROM product_sales
    `
  );

  const [productMediaCounts] = await connection.query(
    `
      SELECT product_id AS productId, COUNT(*) AS mediaCount
      FROM product_media
      WHERE source = 'localline'
      GROUP BY product_id
    `
  );

  const [syncIssues] = await connection.query(
    `
      SELECT
        id,
        sync_run_id AS syncRunId,
        severity,
        issue_type AS issueType,
        product_id AS productId,
        package_id AS packageId,
        price_list_id AS priceListId,
        details_json AS detailsJson,
        resolved_at AS resolvedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM local_line_sync_issues
      WHERE resolved_at IS NULL
      ORDER BY created_at DESC, id DESC
    `
  );

  return {
    syncRuns,
    products,
    packages,
    productMetas,
    packageMetas,
    priceLists,
    priceListEntries,
    productSales,
    productMediaCounts,
    syncIssues
  };
}

function verifyState(state, options = {}) {
  const sampleLimit = Number.isFinite(options.sampleLimit) ? options.sampleLimit : 20;
  const maxStaleHours = Number.isFinite(options.maxStaleHours) ? options.maxStaleHours : 48;
  const now = Date.now();
  const maxStaleMs = maxStaleHours * 60 * 60 * 1000;
  const guestPriceListId = parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID);

  const failures = {
    missingStoreProducts: [],
    missingStorePackages: [],
    productFieldMismatches: [],
    packageFieldMismatches: [],
    saleMismatches: [],
    orphanProductSales: [],
    orphanPriceListEntries: [],
    orphanProductMedia: []
  };

  const warnings = {
    staleCompletedSync: [],
    staleProductMeta: [],
    liveFetchIssues: [],
    unresolvedSyncIssues: [],
    missingConfiguredPriceLists: [],
    missingPriceListEntries: [],
    missingProductMedia: []
  };

  const productById = new Map(state.products.map((row) => [Number(row.id), row]));
  const packageById = new Map(state.packages.map((row) => [Number(row.id), row]));
  const productSaleByProductId = new Map(
    state.productSales.map((row) => [Number(row.productId), row])
  );
  const priceListByLocalLineId = new Map(
    state.priceLists.map((row) => [Number(row.localLinePriceListId), row])
  );
  const mediaCountByProductId = new Map(
    state.productMediaCounts.map((row) => [Number(row.productId), Number(row.mediaCount || 0)])
  );
  const productMetaByProductId = new Map(
    state.productMetas.map((row) => [Number(row.productId), row])
  );

  const priceListEntriesByProductId = state.priceListEntries.reduce((acc, row) => {
    const productId = Number(row.productId);
    const list = acc.get(productId) || [];
    list.push(row);
    acc.set(productId, list);
    return acc;
  }, new Map());

  const completedSync = state.syncRuns.find((row) => row.status === "completed") || null;
  if (!completedSync) {
    warnings.staleCompletedSync.push({
      message: "No completed Local Line sync run recorded in local_line_sync_runs."
    });
  } else if (completedSync.finishedAt) {
    const ageMs = now - new Date(completedSync.finishedAt).getTime();
    if (ageMs > maxStaleMs) {
      warnings.staleCompletedSync.push({
        syncRunId: completedSync.id,
        finishedAt: completedSync.finishedAt,
        ageHours: Number((ageMs / (60 * 60 * 1000)).toFixed(1)),
        maxStaleHours
      });
    }
  }

  for (const check of buildConfiguredPriceListChecks()) {
    if (!priceListByLocalLineId.has(Number(check.localLinePriceListId))) {
      warnings.missingConfiguredPriceLists.push(check);
    }
  }

  const latestSyncRunId = state.syncRuns[0]?.id ?? null;
  const currentSyncIssues = latestSyncRunId
    ? state.syncIssues.filter((issue) => Number(issue.syncRunId) === Number(latestSyncRunId))
    : state.syncIssues;

  for (const issue of currentSyncIssues) {
    warnings.unresolvedSyncIssues.push({
      id: issue.id,
      severity: issue.severity,
      issueType: issue.issueType,
      productId: issue.productId,
      packageId: issue.packageId,
      priceListId: issue.priceListId,
      createdAt: issue.createdAt
    });
  }

  for (const meta of state.productMetas) {
    const productId = Number(meta.productId);
    const product = productById.get(productId);
    const parsed = parseJson(meta.rawJson);
    const exportRow = parsed?.export || {};

    if (!product) {
      failures.missingStoreProducts.push({
        productId,
        localLineProductId: meta.localLineProductId,
        lastLiveFetchStatus: meta.lastLiveFetchStatus
      });
      continue;
    }

    if (Number(meta.lastLiveFetchStatus || 0) !== 200) {
      warnings.liveFetchIssues.push({
        productId,
        localLineProductId: meta.localLineProductId,
        lastLiveFetchStatus: meta.lastLiveFetchStatus,
        lastLiveFetchError: meta.lastLiveFetchError
      });
    }

    if (meta.lastSyncedAt) {
      const ageMs = now - new Date(meta.lastSyncedAt).getTime();
      if (ageMs > maxStaleMs) {
        warnings.staleProductMeta.push({
          productId,
          lastSyncedAt: meta.lastSyncedAt,
          ageHours: Number((ageMs / (60 * 60 * 1000)).toFixed(1)),
          maxStaleHours
        });
      }
    }

    const expectedName = normalizeWhitespace(exportRow.Product);
    const actualName = normalizeWhitespace(product.name);
    if (expectedName && actualName !== expectedName) {
      failures.productFieldMismatches.push({
        productId,
        field: "name",
        expected: expectedName,
        actual: actualName
      });
    }

    const expectedDescription = stripHtml(exportRow.Description);
    const actualDescription = stripHtml(product.description);
    if (actualDescription !== expectedDescription) {
      failures.productFieldMismatches.push({
        productId,
        field: "description",
        expected: expectedDescription,
        actual: actualDescription
      });
    }

    if (
      meta.visible !== null &&
      Number(product.visible) !== Number(meta.visible)
    ) {
      failures.productFieldMismatches.push({
        productId,
        field: "visible",
        expected: Number(meta.visible),
        actual: toTinyInt(product.visible)
      });
    }

    if (
      meta.trackInventory !== null &&
      Number(product.trackInventory) !== Number(meta.trackInventory)
    ) {
      failures.productFieldMismatches.push({
        productId,
        field: "trackInventory",
        expected: Number(meta.trackInventory),
        actual: toTinyInt(product.trackInventory)
      });
    }

    if (
      meta.productInventory !== null &&
      !sameNumber(product.inventory, meta.productInventory)
    ) {
      failures.productFieldMismatches.push({
        productId,
        field: "inventory",
        expected: Number(meta.productInventory),
        actual: toNumber(product.inventory)
      });
    }

    const entryRows = priceListEntriesByProductId.get(productId) || [];
    if (Number(meta.lastLiveFetchStatus || 0) === 200 && entryRows.length === 0) {
      warnings.missingPriceListEntries.push({
        productId,
        localLineProductId: meta.localLineProductId
      });
    }

    if (Number(meta.lastLiveFetchStatus || 0) === 200 && (mediaCountByProductId.get(productId) || 0) === 0) {
      warnings.missingProductMedia.push({
        productId,
        localLineProductId: meta.localLineProductId
      });
    }
  }

  for (const meta of state.packageMetas) {
    const packageId = Number(meta.packageId);
    const pkg = packageById.get(packageId);
    const parsed = parseJson(meta.rawJson);
    const exportRow = parsed?.export || {};

    if (!pkg) {
      failures.missingStorePackages.push({
        packageId,
        productId: meta.productId,
        localLinePackageId: meta.localLinePackageId
      });
      continue;
    }

    if (Number(pkg.productId) !== Number(meta.productId)) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "productId",
        expected: Number(meta.productId),
        actual: Number(pkg.productId)
      });
    }

    const expectedName = normalizeWhitespace(exportRow["Package Name"]);
    const actualName = normalizeWhitespace(pkg.name);
    if (expectedName && expectedName !== actualName) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "name",
        expected: expectedName,
        actual: actualName
      });
    }

    const expectedPrice = roundCurrency(
      exportRow["Package Price"] ?? meta.livePrice ?? pkg.price
    );
    const actualPrice = toNumber(pkg.price);
    if (Number.isFinite(expectedPrice) && !sameNumber(actualPrice, expectedPrice, 0.01)) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "price",
        expected: expectedPrice,
        actual: actualPrice
      });
    }

    const expectedPackageCode = normalizeWhitespace(exportRow["Package Code"] ?? meta.packageCode);
    const actualPackageCode = normalizeWhitespace(pkg.packageCode);
    if (expectedPackageCode !== actualPackageCode) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "packageCode",
        expected: expectedPackageCode,
        actual: actualPackageCode
      });
    }

    if (
      meta.packageInventory !== null &&
      !sameNumber(pkg.inventory, meta.packageInventory)
    ) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "inventory",
        expected: Number(meta.packageInventory),
        actual: toNumber(pkg.inventory)
      });
    }

    if (
      meta.liveVisible !== null &&
      Number(pkg.visible) !== Number(meta.liveVisible)
    ) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "visible",
        expected: Number(meta.liveVisible),
        actual: toTinyInt(pkg.visible)
      });
    }

    if (
      meta.liveTrackInventory !== null &&
      Number(pkg.trackInventory) !== Number(meta.liveTrackInventory)
    ) {
      failures.packageFieldMismatches.push({
        packageId,
        productId: meta.productId,
        field: "trackInventory",
        expected: Number(meta.liveTrackInventory),
        actual: toTinyInt(pkg.trackInventory)
      });
    }
  }

  const guestEntryRowsByProductId = state.priceListEntries.reduce((acc, row) => {
    if (
      Number.isFinite(guestPriceListId) &&
      Number(row.localLinePriceListId) !== Number(guestPriceListId)
    ) {
      return acc;
    }
    const productId = Number(row.productId);
    const list = acc.get(productId) || [];
    list.push(row);
    acc.set(productId, list);
    return acc;
  }, new Map());

  for (const [productId, rows] of guestEntryRowsByProductId.entries()) {
    const visibleRows = rows.filter((row) =>
      row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible)
    );
    if (!visibleRows.length) {
      continue;
    }

    let expectedOnSale = false;
    let expectedSaleDiscount = null;
    for (const row of visibleRows) {
      const derivedDiscount = computeDerivedSaleDiscount(
        row.finalPriceCache,
        row.strikethroughDisplayValue
      );
      if (isRealLocalLineSale(row)) {
        expectedOnSale = true;
      }
      if (
        Number.isFinite(derivedDiscount) &&
        (expectedSaleDiscount === null || derivedDiscount > expectedSaleDiscount)
      ) {
        expectedSaleDiscount = derivedDiscount;
      }
    }

    const actual = productSaleByProductId.get(productId) || null;
    if (!actual) {
      failures.saleMismatches.push({
        productId,
        expectedOnSale,
        expectedSaleDiscount,
        actual: null,
        reason: "missing-product-sales-row"
      });
      continue;
    }

    const actualOnSale = Boolean(actual.onSale);
    const actualDiscount = actual.saleDiscount === null ? null : Number(actual.saleDiscount);
    if (
      actualOnSale !== expectedOnSale ||
      !sameNumber(actualDiscount, expectedSaleDiscount, 0.01)
    ) {
      failures.saleMismatches.push({
        productId,
        expectedOnSale,
        expectedSaleDiscount,
        actualOnSale,
        actualSaleDiscount: actualDiscount
      });
    }
  }

  for (const row of state.productSales) {
    if (!productById.has(Number(row.productId))) {
      failures.orphanProductSales.push({
        productId: Number(row.productId)
      });
    }
  }

  for (const row of state.priceListEntries) {
    const productId = Number(row.productId);
    const packageId = row.packageId === null || typeof row.packageId === "undefined" ? null : Number(row.packageId);
    if (!productById.has(productId) || !productMetaByProductId.has(productId)) {
      failures.orphanPriceListEntries.push({
        id: row.id,
        productId,
        packageId,
        reason: "missing-product-or-product-meta"
      });
      continue;
    }
    if (packageId !== null && !packageById.has(packageId)) {
      failures.orphanPriceListEntries.push({
        id: row.id,
        productId,
        packageId,
        reason: "missing-package"
      });
    }
  }

  for (const [productId] of mediaCountByProductId.entries()) {
    if (!productById.has(Number(productId))) {
      failures.orphanProductMedia.push({
        productId: Number(productId)
      });
    }
  }

  const failureCounts = Object.fromEntries(
    Object.entries(failures).map(([key, rows]) => [key, rows.length])
  );
  const warningCounts = Object.fromEntries(
    Object.entries(warnings).map(([key, rows]) => [key, rows.length])
  );
  const failureCount = Object.values(failureCounts).reduce((sum, value) => sum + value, 0);
  const warningCount = Object.values(warningCounts).reduce((sum, value) => sum + value, 0);

  return {
    generatedAt: new Date().toISOString(),
    pass: failureCount === 0,
    thresholds: {
      maxStaleHours,
      sampleLimit
    },
    counts: {
      syncRuns: state.syncRuns.length,
      products: state.products.length,
      packages: state.packages.length,
      localLineProductMeta: state.productMetas.length,
      localLinePackageMeta: state.packageMetas.length,
      localLinePriceListEntries: state.priceListEntries.length,
      productSales: state.productSales.length,
      unresolvedSyncIssues: currentSyncIssues.length
    },
    failureCounts,
    warningCounts,
    failures: Object.fromEntries(
      Object.entries(failures).map(([key, rows]) => [key, limitRows(rows, sampleLimit)])
    ),
    warnings: Object.fromEntries(
      Object.entries(warnings).map(([key, rows]) => [key, limitRows(rows, sampleLimit)])
    )
  };
}

async function main() {
  const storeEnvPath = resolveFromRepoRoot(".env");
  const reportFile = resolveFromRepoRoot(
    getArg("report-file") || path.join("tmp", "localline-verify-report.json")
  );
  const sampleLimit = Number(getArg("sample-limit") || 20);
  const maxStaleHours = Number(getArg("max-stale-hours") || 48);

  dotenv.config({ path: storeEnvPath });

  const connection = await mysql.createConnection({
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store"
  });

  try {
    await ensureLocalLineSyncSchema(connection);
    const state = await loadState(connection);
    const report = verifyState(state, { sampleLimit, maxStaleHours });

    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    console.log(
      JSON.stringify(
        {
          reportFile,
          pass: report.pass,
          failureCounts: report.failureCounts,
          warningCounts: report.warningCounts,
          counts: report.counts
        },
        null,
        2
      )
    );

    if (!report.pass) {
      process.exitCode = 1;
    }
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
