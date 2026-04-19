import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

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

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeUnitOfMeasure(value, fallback = "each") {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === "lb" || normalized === "lbs" || normalized === "pound" || normalized === "pounds") {
    return "lbs";
  }
  if (normalized === "each" || normalized === "ea") {
    return "each";
  }
  return fallback;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function computePurchasePrice(row) {
  const retailUnit = toNumber(row.retailSalesPrice);
  const unitOfMeasure = normalizeUnitOfMeasure(row.dff_unit_of_measure, null);
  const lowestWeight = toNumber(row.lowest_weight);
  const highestWeight = toNumber(row.highest_weight);
  const discount = 0.5412;

  if (!Number.isFinite(retailUnit)) {
    throw new Error(`Missing retailSalesPrice for pricelist row ${row.id}`);
  }

  if (unitOfMeasure === "lbs") {
    let averageWeight;

    if (Number.isFinite(lowestWeight) && Number.isFinite(highestWeight)) {
      averageWeight = (lowestWeight + highestWeight) / 2;
    } else if (Number.isFinite(lowestWeight)) {
      averageWeight = lowestWeight;
    } else if (Number.isFinite(highestWeight)) {
      averageWeight = highestWeight;
    } else {
      throw new Error(`Missing weights for pounds-based pricelist row ${row.id}`);
    }

    return roundCurrency(retailUnit * averageWeight * discount);
  }

  if (unitOfMeasure === "each") {
    return roundCurrency(retailUnit * discount);
  }

  throw new Error(`Unknown unit of measure "${row.dff_unit_of_measure}" for pricelist row ${row.id}`);
}

function priceChanged(currentValue, nextValue) {
  const current = toNumber(currentValue);
  const next = toNumber(nextValue);
  if (!Number.isFinite(current) && !Number.isFinite(next)) return false;
  if (!Number.isFinite(current) || !Number.isFinite(next)) return true;
  return Math.abs(current - next) > 0.009;
}

function mapById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function groupPackagesByProduct(rows) {
  return rows.reduce((acc, row) => {
    const list = acc.get(row.productId) || [];
    list.push(row);
    acc.set(row.productId, list);
    return acc;
  }, new Map());
}

function isDepositProductName(name) {
  return typeof name === "string" && name.toLowerCase().includes("deposit");
}

function buildPricingSeed(killdeerRow, vendor = null, saleRow = null) {
  const unitOfMeasure = normalizeUnitOfMeasure(killdeerRow.dff_unit_of_measure, "each");
  const sourceUnitPrice = toNullableNumber(killdeerRow.retailSalesPrice);
  const minWeight = toNullableNumber(killdeerRow.lowest_weight);
  const maxWeight = toNullableNumber(killdeerRow.highest_weight);
  const guestMarkup = toNullableNumber(vendor?.guestMarkup);
  const memberMarkup = toNullableNumber(vendor?.memberMarkup);
  const saleDiscount = toNullableNumber(saleRow?.saleDiscount);
  const noMarkup = isDepositProductName(killdeerRow.productName);

  return {
    unitOfMeasure,
    sourceUnitPrice: sourceUnitPrice === null ? null : roundCurrency(sourceUnitPrice),
    minWeight:
      unitOfMeasure === "lbs" && minWeight !== null
        ? Number(minWeight.toFixed(3))
        : null,
    maxWeight:
      unitOfMeasure === "lbs" && maxWeight !== null
        ? Number(maxWeight.toFixed(3))
        : null,
    avgWeightOverride: null,
    sourceMultiplier: 0.5412,
    guestMarkup: noMarkup ? 0 : (guestMarkup ?? 0.55),
    memberMarkup: noMarkup ? 0 : (memberMarkup ?? 0.4),
    herdShareMarkup: noMarkup ? 0 : (memberMarkup ?? 0.4),
    snapMarkup: noMarkup ? 0 : (memberMarkup ?? 0.4),
    onSale: saleRow?.onSale ? 1 : 0,
    saleDiscount: saleDiscount ?? 0
  };
}

function isMissingOrZero(value) {
  const numeric = toNullableNumber(value);
  return numeric === null || Math.abs(numeric) < 0.000001;
}

function needsPricingSeedRepair(storePricingProfile, pricingSeed) {
  if (!storePricingProfile || !pricingSeed) return false;

  if (pricingSeed.sourceUnitPrice !== null && isMissingOrZero(storePricingProfile.sourceUnitPrice)) {
    return true;
  }

  if (pricingSeed.unitOfMeasure === "lbs") {
    if (pricingSeed.minWeight !== null && isMissingOrZero(storePricingProfile.minWeight)) {
      return true;
    }
    if (pricingSeed.maxWeight !== null && isMissingOrZero(storePricingProfile.maxWeight)) {
      return true;
    }
  }

  if (isMissingOrZero(storePricingProfile.sourceMultiplier)) return true;
  if (pricingSeed.guestMarkup !== 0 && isMissingOrZero(storePricingProfile.guestMarkup)) return true;
  if (pricingSeed.memberMarkup !== 0 && isMissingOrZero(storePricingProfile.memberMarkup)) return true;
  if (pricingSeed.herdShareMarkup !== 0 && isMissingOrZero(storePricingProfile.herdShareMarkup)) return true;
  if (pricingSeed.snapMarkup !== 0 && isMissingOrZero(storePricingProfile.snapMarkup)) return true;

  return false;
}

function buildDiff(
  killdeerRow,
  storeProduct,
  storePackage,
  storePricingProfile = null,
  vendor = null,
  saleRow = null
) {
  const nextProductName = normalizeText(killdeerRow.productName);
  const nextPackageName = normalizeText(killdeerRow.packageName);
  const nextPackagePrice = computePurchasePrice(killdeerRow);
  const nextUnitOfMeasure = normalizeUnitOfMeasure(killdeerRow.dff_unit_of_measure, null);
  const currentUnitOfMeasure = normalizeUnitOfMeasure(storePricingProfile?.unitOfMeasure, "each");
  const pricingSeed = buildPricingSeed(killdeerRow, vendor, saleRow);

  const changes = {};

  if (nextProductName !== normalizeText(storeProduct.name)) {
    changes.productName = {
      from: storeProduct.name,
      to: nextProductName
    };
  }

  if (nextPackageName !== normalizeText(storePackage.name)) {
    changes.packageName = {
      from: storePackage.name,
      to: nextPackageName
    };
  }

  if (priceChanged(storePackage.price, nextPackagePrice)) {
    changes.packagePrice = {
      from: Number(storePackage.price),
      to: nextPackagePrice
    };
  }

  if (nextUnitOfMeasure && nextUnitOfMeasure !== currentUnitOfMeasure) {
    changes.unitOfMeasure = {
      from: currentUnitOfMeasure,
      to: nextUnitOfMeasure
    };
  }

  if (needsPricingSeedRepair(storePricingProfile, pricingSeed)) {
    changes.pricingProfileSeed = {
      to: pricingSeed
    };
  }

  return {
    killdeerPricelistId: killdeerRow.id,
    productId: storeProduct.id,
    packageId: storePackage.id,
    active: Boolean(killdeerRow.active),
    visible: Boolean(killdeerRow.visible),
    changes,
    pricingSeed
  };
}

function filterChanges(changes, { unitsOnly = false } = {}) {
  if (!unitsOnly) {
    return changes;
  }

  const filtered = {};
  if (changes.unitOfMeasure) {
    filtered.unitOfMeasure = changes.unitOfMeasure;
  }
  if (changes.pricingProfileSeed) {
    filtered.pricingProfileSeed = changes.pricingProfileSeed;
  }
  return filtered;
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
}

async function loadKilldeerRows(connection, { ids, includeInactive }) {
  const filters = ["localLineProductID IS NOT NULL"];
  const params = [];

  if (!includeInactive) {
    filters.push("active = 1");
  }

  if (ids.length) {
    filters.push("localLineProductID IN (?)");
    params.push(ids);
  }

  const [rows] = await connection.query(
    `
      SELECT
        id,
        localLineProductID,
        productName,
        packageName,
        retailSalesPrice,
        lowest_weight,
        highest_weight,
        dff_unit_of_measure,
        visible,
        active
      FROM pricelist
      WHERE ${filters.join(" AND ")}
      ORDER BY localLineProductID ASC
    `,
    params
  );

  return rows;
}

async function loadStoreRows(connection, productIds) {
  if (!productIds.length) {
    return { products: [], packages: [], pricingProfiles: [], vendors: [], sales: [] };
  }

  const [products] = await connection.query(
    `
      SELECT id, name, vendor_id AS vendorId
      FROM products
      WHERE id IN (?)
    `,
    [productIds]
  );

  const [packages] = await connection.query(
    `
      SELECT id, product_id AS productId, name, price
      FROM packages
      WHERE product_id IN (?)
      ORDER BY product_id ASC, id ASC
    `,
    [productIds]
  );

  const [pricingProfiles] = await connection.query(
    `
      SELECT
        product_id AS productId,
        unit_of_measure AS unitOfMeasure,
        source_unit_price AS sourceUnitPrice,
        min_weight AS minWeight,
        max_weight AS maxWeight,
        source_multiplier AS sourceMultiplier,
        guest_markup AS guestMarkup,
        member_markup AS memberMarkup,
        herd_share_markup AS herdShareMarkup,
        snap_markup AS snapMarkup
      FROM product_pricing_profiles
      WHERE product_id IN (?)
    `,
    [productIds]
  );

  const vendorIds = [...new Set(products.map((row) => Number(row.vendorId)).filter((value) => Number.isFinite(value)))];

  const [vendors] = vendorIds.length
    ? await connection.query(
        `
          SELECT
            id,
            guest_markup AS guestMarkup,
            member_markup AS memberMarkup
          FROM vendors
          WHERE id IN (?)
        `,
        [vendorIds]
      )
    : [[]];

  const [sales] = await connection.query(
    `
      SELECT
        product_id AS productId,
        on_sale AS onSale,
        sale_discount AS saleDiscount
      FROM product_sales
      WHERE product_id IN (?)
    `,
    [productIds]
  );

  return { products, packages, pricingProfiles, vendors, sales };
}

async function applyUpdates(connection, updates) {
  if (!updates.length) return;

  await connection.beginTransaction();

  try {
    for (const update of updates) {
      const { changes, pricingSeed, productId, packageId } = update;

      if (changes.productName) {
        await connection.query(
          `
            UPDATE products
            SET name = ?, updated_at = NOW()
            WHERE id = ?
          `,
          [changes.productName.to, productId]
        );
      }

      if (changes.packageName && changes.packagePrice) {
        await connection.query(
          `
            UPDATE packages
            SET name = ?, price = ?
            WHERE id = ?
          `,
          [changes.packageName.to, changes.packagePrice.to, packageId]
        );
      } else if (changes.packageName) {
        await connection.query(
          `
            UPDATE packages
            SET name = ?
            WHERE id = ?
          `,
          [changes.packageName.to, packageId]
        );
      } else if (changes.packagePrice) {
        await connection.query(
          `
            UPDATE packages
            SET price = ?
            WHERE id = ?
          `,
          [changes.packagePrice.to, packageId]
        );
      }

      if (changes.unitOfMeasure || changes.pricingProfileSeed) {
        await connection.query(
          `
            INSERT INTO product_pricing_profiles (
              product_id,
              unit_of_measure,
              source_unit_price,
              min_weight,
              max_weight,
              avg_weight_override,
              source_multiplier,
              guest_markup,
              member_markup,
              herd_share_markup,
              snap_markup,
              on_sale,
              sale_discount,
              remote_sync_status,
              remote_sync_message,
              remote_synced_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'DFF pricing inputs updated from pricelist sync. Apply to remote store pending.', NULL, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
              unit_of_measure = VALUES(unit_of_measure),
              source_unit_price = CASE
                WHEN source_unit_price IS NULL OR source_unit_price = 0 THEN VALUES(source_unit_price)
                ELSE source_unit_price
              END,
              min_weight = CASE
                WHEN min_weight IS NULL OR min_weight = 0 THEN VALUES(min_weight)
                ELSE min_weight
              END,
              max_weight = CASE
                WHEN max_weight IS NULL OR max_weight = 0 THEN VALUES(max_weight)
                ELSE max_weight
              END,
              source_multiplier = CASE
                WHEN source_multiplier IS NULL OR source_multiplier = 0 THEN VALUES(source_multiplier)
                ELSE source_multiplier
              END,
              guest_markup = CASE
                WHEN guest_markup IS NULL OR guest_markup = 0 THEN VALUES(guest_markup)
                ELSE guest_markup
              END,
              member_markup = CASE
                WHEN member_markup IS NULL OR member_markup = 0 THEN VALUES(member_markup)
                ELSE member_markup
              END,
              herd_share_markup = CASE
                WHEN herd_share_markup IS NULL OR herd_share_markup = 0 THEN VALUES(herd_share_markup)
                ELSE herd_share_markup
              END,
              snap_markup = CASE
                WHEN snap_markup IS NULL OR snap_markup = 0 THEN VALUES(snap_markup)
                ELSE snap_markup
              END,
              remote_sync_status = 'pending',
              remote_sync_message = 'DFF pricing inputs updated from pricelist sync. Apply to remote store pending.',
              remote_synced_at = NULL,
              updated_at = VALUES(updated_at)
          `,
          [
            productId,
            changes.unitOfMeasure?.to || pricingSeed.unitOfMeasure || "each",
            pricingSeed.sourceUnitPrice,
            pricingSeed.minWeight,
            pricingSeed.maxWeight,
            pricingSeed.avgWeightOverride,
            pricingSeed.sourceMultiplier,
            pricingSeed.guestMarkup,
            pricingSeed.memberMarkup,
            pricingSeed.herdShareMarkup,
            pricingSeed.snapMarkup,
            pricingSeed.onSale,
            pricingSeed.saleDiscount
          ]
        );
      }
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main() {
  const storeEnvPath = resolveFromRepoRoot(".env");
  const killdeerEnvPath = getArg("killdeer-env")
    ? resolveFromRepoRoot(getArg("killdeer-env"))
    : null;
  const includeInactive = hasFlag("include-inactive");
  const shouldWrite = hasFlag("write");
  const unitsOnly = hasFlag("units-only");
  const ids = (getArg("ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  const limit = Number(getArg("limit") || 20);

  dotenv.config({ path: storeEnvPath });
  const storeConfig = {
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store"
  };

  if (killdeerEnvPath) {
    const killdeerEnv = dotenv.config({ path: killdeerEnvPath, override: true });
    if (killdeerEnv.error) {
      throw killdeerEnv.error;
    }
  }

  const killdeerConfig = {
    host: process.env.DFF_DB_HOST || storeConfig.host,
    port: Number(process.env.DFF_DB_PORT || storeConfig.port || 3306),
    user: process.env.DFF_DB_USER || storeConfig.user,
    password: process.env.DFF_DB_PASSWORD || storeConfig.password,
    database: process.env.DFF_DB_DATABASE || storeConfig.database
  };

  const storeConnection = await mysql.createConnection(storeConfig);
  const killdeerConnection = await mysql.createConnection(killdeerConfig);

  try {
    const killdeerRows = await loadKilldeerRows(killdeerConnection, { ids, includeInactive });
    const localLineProductIds = killdeerRows
      .map((row) => Number(row.localLineProductID))
      .filter((value) => Number.isFinite(value));
    const { products, packages, pricingProfiles, vendors, sales } = await loadStoreRows(
      storeConnection,
      localLineProductIds
    );
    const productMap = mapById(products);
    const packagesByProduct = groupPackagesByProduct(packages);
    const pricingProfileByProductId = new Map(
      pricingProfiles.map((row) => [Number(row.productId), row])
    );
    const vendorById = new Map(vendors.map((row) => [Number(row.id), row]));
    const saleByProductId = new Map(sales.map((row) => [Number(row.productId), row]));

    const skipped = [];
    const updates = [];

    for (const row of killdeerRows) {
      const productId = Number(row.localLineProductID);
      const storeProduct = productMap.get(productId);

      if (!storeProduct) {
        skipped.push({
          reason: "missing-store-product",
          productId,
          killdeerPricelistId: row.id,
          killdeerProductName: row.productName
        });
        continue;
      }

      const packageRows = packagesByProduct.get(productId) || [];
      if (packageRows.length !== 1) {
        skipped.push({
          reason: packageRows.length ? "multiple-store-packages" : "missing-store-package",
          productId,
          killdeerPricelistId: row.id,
          storePackageCount: packageRows.length
        });
        continue;
      }

      try {
        const diff = buildDiff(
          row,
          storeProduct,
          packageRows[0],
          pricingProfileByProductId.get(productId) || null,
          vendorById.get(Number(storeProduct.vendorId)) || null,
          saleByProductId.get(productId) || null
        );
        const changes = filterChanges(diff.changes, { unitsOnly });
        if (Object.keys(changes).length) {
          updates.push({
            ...diff,
            changes
          });
        }
      } catch (error) {
        skipped.push({
          reason: "pricing-error",
          productId,
          killdeerPricelistId: row.id,
          error: error.message
        });
      }
    }

    if (shouldWrite) {
      await applyUpdates(storeConnection, updates);
    }

    const summary = {
      mode: shouldWrite ? "write" : "dry-run",
      storeEnvPath,
      killdeerEnvPath,
      includeInactive,
      unitsOnly,
      killdeerRowsEvaluated: killdeerRows.length,
      matchedStoreProducts: products.length,
      skippedCount: skipped.length,
      updatesNeeded: updates.length,
      productNameUpdates: updates.filter((update) => update.changes.productName).length,
      packageNameUpdates: updates.filter((update) => update.changes.packageName).length,
      packagePriceUpdates: updates.filter((update) => update.changes.packagePrice).length,
      unitOfMeasureUpdates: updates.filter((update) => update.changes.unitOfMeasure).length,
      pricingProfileSeedRepairs: updates.filter((update) => update.changes.pricingProfileSeed).length,
      sampleUpdates: updates.slice(0, Number.isFinite(limit) ? limit : 20),
      sampleSkipped: skipped.slice(0, Number.isFinite(limit) ? limit : 20)
    };

    printSummary(summary);
  } finally {
    await Promise.allSettled([storeConnection.end(), killdeerConnection.end()]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
