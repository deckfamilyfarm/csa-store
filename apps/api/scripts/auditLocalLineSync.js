import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const require = createRequire(import.meta.url);
const xlsx = require(path.resolve(repoRoot, "../killdeer/node_modules/xlsx"));

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(`--${flag}`);
}

function getArg(name) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function getListArg(name) {
  const value = getArg(name);
  if (!value) return [];
  return value
    .split(",")
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
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

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function parseYesNo(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeWhitespace(value).toUpperCase();
  if (normalized === "Y" || normalized === "YES" || normalized === "TRUE") return true;
  if (normalized === "N" || normalized === "NO" || normalized === "FALSE") return false;
  return null;
}

function mapBy(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}

function groupBy(rows, key) {
  return rows.reduce((acc, row) => {
    const list = acc.get(row[key]) || [];
    list.push(row);
    acc.set(row[key], list);
    return acc;
  }, new Map());
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function isMissingTableError(error, tableName = "") {
  const message = String(error?.message || "").toLowerCase();
  if (error?.code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist")) {
    if (!tableName) return true;
    return message.includes(tableName.toLowerCase());
  }
  return false;
}

function buildPriceListsFromEnv() {
  const parseNumber = (value, fallback = null) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  const defaultGuest = parseNumber(process.env.LL_MARKUP_GUEST);
  const defaultMember = parseNumber(process.env.LL_MARKUP_MEMBER);
  const entries = [
    {
      key: "Guest Basket",
      id: parseNumber(process.env.LL_PRICE_LIST_GUEST_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_GUEST_MARKUP, defaultGuest)
    },
    {
      key: "CSA Members",
      id: parseNumber(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_CSA_MEMBERS_MARKUP, defaultMember)
    },
    {
      key: "Herd Share Members",
      id: parseNumber(process.env.LL_PRICE_LIST_HERDSHARE_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_HERDSHARE_MARKUP, defaultMember)
    },
    {
      key: "SNAP",
      id: parseNumber(process.env.LL_PRICE_LIST_SNAP_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_SNAP_MARKUP, defaultMember)
    }
  ];

  return entries.filter((entry) => Number.isFinite(entry.id) && Number.isFinite(entry.markup));
}

function getDairyPriceListIds() {
  return normalizeWhitespace(process.env.LL_DAIRY_PRICE_LIST_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function getDairyMarkup() {
  return Number.isFinite(Number(process.env.LL_MARKUP_DAIRY))
    ? Number(process.env.LL_MARKUP_DAIRY)
    : null;
}

function isDairyCategoryName(name) {
  return typeof name === "string" && /dairy|milk|cheese|yogurt/i.test(name);
}

function computePurchasePriceFromPricelist(row) {
  const retailUnit = Number(row.retailSalesPrice);
  const unitOfMeasure = normalizeWhitespace(row.dff_unit_of_measure).toLowerCase();

  if (!Number.isFinite(retailUnit)) {
    throw new Error(`Missing retailSalesPrice for pricelist row ${row.id}`);
  }

  if (unitOfMeasure === "each") {
    return roundCurrency(retailUnit * 0.5412);
  }

  if (unitOfMeasure === "lbs") {
    const lowestWeight = toNumber(row.lowest_weight);
    const highestWeight = toNumber(row.highest_weight);
    let averageWeight = null;

    if (lowestWeight !== null && highestWeight !== null) {
      averageWeight = (lowestWeight + highestWeight) / 2;
    } else if (lowestWeight !== null) {
      averageWeight = lowestWeight;
    } else if (highestWeight !== null) {
      averageWeight = highestWeight;
    }

    if (averageWeight === null) {
      throw new Error(`Missing weights for pounds-based pricelist row ${row.id}`);
    }

    return roundCurrency(retailUnit * averageWeight * 0.5412);
  }

  throw new Error(`Unknown unit of measure "${row.dff_unit_of_measure}" for pricelist row ${row.id}`);
}

function expectedPriceListConfig(categoryName) {
  const dairyMarkup = getDairyMarkup();
  const dairyPriceListIds = getDairyPriceListIds();
  const useDairyMarkup = isDairyCategoryName(categoryName) && Number.isFinite(dairyMarkup);
  return buildPriceListsFromEnv().map((entry) => ({
    name: entry.key,
    id: entry.id,
    markup:
      useDairyMarkup && dairyPriceListIds.includes(entry.id)
        ? dairyMarkup
        : entry.markup
  }));
}

function buildExpectedPriceListEntry(
  basePrice,
  markupDecimal,
  saleEnabled,
  saleDiscount,
  preferredAdjustmentType = 2
) {
  const adjustmentType =
    preferredAdjustmentType === 1 ||
    preferredAdjustmentType === 2 ||
    preferredAdjustmentType === 3
      ? preferredAdjustmentType
      : 2;
  const regularFinalPrice = roundCurrency(basePrice * (1 + markupDecimal));
  let adjustmentValue =
    adjustmentType === 1
      ? roundCurrency(regularFinalPrice - basePrice)
      : adjustmentType === 2
        ? roundCurrency(markupDecimal * 100)
        : regularFinalPrice;
  let finalPrice = regularFinalPrice;
  let basePriceUsed = roundCurrency(basePrice);
  let onSaleToggle = false;
  let strikethroughDisplayValue = null;

  if (saleEnabled && Number.isFinite(saleDiscount) && saleDiscount > 0) {
    const discountedFinal = regularFinalPrice * (1 - saleDiscount);
    finalPrice = roundCurrency(discountedFinal);
    onSaleToggle = true;
    strikethroughDisplayValue = regularFinalPrice;

    if (adjustmentType === 1) {
      adjustmentValue = roundCurrency(finalPrice - basePriceUsed);
    } else if (adjustmentType === 2) {
      basePriceUsed = roundCurrency(discountedFinal / (1 + markupDecimal));
      const saleMarkup = (discountedFinal - basePriceUsed) / basePriceUsed;
      adjustmentValue = roundCurrency(saleMarkup * 100);
    } else {
      adjustmentValue = finalPrice;
    }
  }

  return {
    adjustmentType,
    adjustmentValue,
    basePriceUsed,
    finalPrice,
    onSale: Boolean(saleEnabled),
    onSaleToggle,
    strikethroughDisplayValue
  };
}

function computeActualFinalPrice(basePrice, entry) {
  const safeBase = toNumber(basePrice);
  if (safeBase === null) return null;
  if (!entry?.adjustment) return safeBase;

  const adjustmentValue = toNumber(entry.adjustment_value);
  if (adjustmentValue === null) return null;

  if (entry.adjustment_type === 1) {
    return roundCurrency(safeBase + adjustmentValue);
  }

  if (entry.adjustment_type === 2) {
    return roundCurrency(safeBase * (1 + adjustmentValue / 100));
  }

  if (entry.adjustment_type === 3) {
    return roundCurrency(adjustmentValue);
  }

  return null;
}

function compareTextField(changes, key, currentValue, nextValue) {
  const current = normalizeWhitespace(currentValue);
  const next = normalizeWhitespace(nextValue);
  if (current !== next) {
    changes[key] = { from: currentValue ?? null, to: nextValue ?? null };
  }
}

function compareBoolField(changes, key, currentValue, nextValue) {
  const current = currentValue === null || typeof currentValue === "undefined" ? null : Boolean(currentValue);
  const next = nextValue === null || typeof nextValue === "undefined" ? null : Boolean(nextValue);
  if (current !== next) {
    changes[key] = { from: current, to: next };
  }
}

function compareNumberField(changes, key, currentValue, nextValue) {
  const current = toNumber(currentValue);
  const next = toNumber(nextValue);
  if (current === null && next === null) return;
  if (current === null || next === null || Math.abs(current - next) > 0.009) {
    changes[key] = { from: currentValue ?? null, to: nextValue ?? null };
  }
}

async function getLocalLineAccessToken(baseUrl) {
  const response = await fetch(`${baseUrl}token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.LL_USERNAME,
      password: process.env.LL_PASSWORD
    })
  });

  if (!response.ok) {
    throw new Error(`Local Line token error: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return payload?.access || payload?.token || payload;
}

async function downloadLocalLineExport(baseUrl, token) {
  const response = await fetch(`${baseUrl}products/export/?direct=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Local Line products export failed: ${response.status} ${await response.text()}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const filePath = path.join(os.tmpdir(), "localline-products-export.xlsx");
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  return filePath;
}

function parseLocalLineExport(filePath) {
  const workbook = xlsx.readFile(filePath);
  const availabilityRows = xlsx.utils.sheet_to_json(workbook.Sheets["Availability"]);
  const packageRows = xlsx.utils.sheet_to_json(workbook.Sheets["Packages and pricing"]);

  const productsById = new Map();
  const packagesByProductId = new Map();

  for (const row of availabilityRows) {
    const productId = Number(row["Local Line Product ID"]);
    if (!Number.isFinite(productId)) continue;

    productsById.set(productId, {
      productId,
      internalId: row["Internal ID"] ?? null,
      name: row.Product ?? null,
      visible: parseYesNo(row.Visible),
      description: row.Description ?? null,
      trackInventoryBy: row["Track Inventory By"] ?? null,
      inventoryType: row["Inventory Type"] ?? null,
      productInventory: toNumber(row["Product Inventory"]),
      packageCodesEnabled: parseYesNo(row["Package Codes Enabled"])
    });
  }

  for (const row of packageRows) {
    const productId = Number(row["Local Line Product ID"]);
    const packageId = Number(row["Package ID"]);
    if (!Number.isFinite(productId) || !Number.isFinite(packageId)) continue;

    const list = packagesByProductId.get(productId) || [];
    list.push({
      productId,
      packageId,
      name: row["Package Name"] ?? null,
      price: toNumber(row["Package Price"]),
      packageCode: row["Package Code"] ?? null,
      inventoryType: row["Inventory Type"] ?? null,
      packageInventory: toNumber(row["Package Inventory"]),
      packageReservedInventory: toNumber(row["Package Reserved Inventory"]),
      packageAvailableInventory: toNumber(row["Package Available Inventory"]),
      avgPackageWeight: toNumber(row["Avg Package Weight"]),
      numOfItems: toNumber(row["# of Items"])
    });
    packagesByProductId.set(productId, list);
  }

  return {
    productCount: productsById.size,
    packageCount: packageRows.length,
    productsById,
    packagesByProductId
  };
}

async function fetchStoreCatalog(connection) {
  const [products] = await connection.query(`
    SELECT
      p.id,
      p.name,
      p.description,
      p.visible,
      p.track_inventory AS trackInventory,
      p.inventory,
      p.category_id AS categoryId,
      c.name AS categoryName
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
  `);

  const [packages] = await connection.query(`
    SELECT
      id,
      product_id AS productId,
      name,
      price,
      package_code AS packageCode,
      unit,
      num_of_items AS numOfItems,
      track_inventory AS trackInventory,
      inventory
    FROM packages
  `);

  return { products, packages };
}

async function fetchCurrentPricelist(connection, { includeInactive }) {
  try {
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
          track_inventory,
          stock_inventory,
          upc,
          sale,
          sale_discount,
          active
        FROM pricelist
        WHERE localLineProductID IS NOT NULL
          ${includeInactive ? "" : "AND active = 1"}
        ORDER BY localLineProductID ASC
      `
    );
    return {
      rows,
      sourceTable: "pricelist",
      warning: null
    };
  } catch (error) {
    if (!isMissingTableError(error, "pricelist")) {
      throw error;
    }

    return {
      rows: [],
      sourceTable: null,
      warning:
        "Skipped pricelist comparison because the legacy `pricelist` table is missing from the configured DB."
    };
  }
}

async function fetchLocalLineProductDetail(baseUrl, token, productId) {
  const response = await fetch(`${baseUrl}products/${productId}/?expand=packages,product_price_list_entries`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return {
      ok: false,
      productId,
      status: response.status,
      error: await response.text()
    };
  }

  return {
    ok: true,
    productId,
    body: await response.json()
  };
}

async function mapWithConcurrency(values, concurrency, mapper, onProgress) {
  const results = [];
  let index = 0;
  let completed = 0;
  const total = values.length;

  async function worker() {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
      completed += 1;
      if (typeof onProgress === "function") {
        onProgress({
          completed,
          total,
          value: values[currentIndex],
          index: currentIndex
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, values.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildCatalogComparison(exportCatalog, storeCatalog) {
  const storeProductsById = mapBy(storeCatalog.products, "id");
  const storePackagesByProductId = groupBy(storeCatalog.packages, "productId");

  const missingStoreProducts = [];
  const missingLocalLineProducts = [];
  const productUpdates = [];
  const packageUpdates = [];
  const packageShapeMismatches = [];
  const suppressedWarnings = {
    packageInventoryNullSkipped: 0
  };

  for (const [productId, llProduct] of exportCatalog.productsById.entries()) {
    const storeProduct = storeProductsById.get(productId);
    const llPackages = exportCatalog.packagesByProductId.get(productId) || [];

    if (!storeProduct) {
      missingStoreProducts.push({
        productId,
        localLineName: llProduct.name,
        visible: llProduct.visible,
        description: stripHtml(llProduct.description),
        trackInventory: llProduct.productInventory !== null,
        inventory: llProduct.productInventory,
        packageCount: llPackages.length,
        packages: llPackages.map((pkg) => ({
          packageId: pkg.packageId,
          name: pkg.name,
          price: pkg.price,
          packageCode: pkg.packageCode,
          numOfItems: pkg.numOfItems,
          visible: llProduct.visible,
          trackInventory: pkg.packageInventory !== null,
          inventory: pkg.packageInventory
        }))
      });
      continue;
    }

    const productChanges = {};
    compareTextField(productChanges, "name", storeProduct.name, llProduct.name);
    compareTextField(
      productChanges,
      "description",
      stripHtml(storeProduct.description),
      stripHtml(llProduct.description)
    );
    compareBoolField(productChanges, "visible", storeProduct.visible, llProduct.visible);
    compareBoolField(
      productChanges,
      "trackInventory",
      storeProduct.trackInventory,
      llProduct.productInventory !== null
    );
    compareNumberField(productChanges, "inventory", storeProduct.inventory, llProduct.productInventory);

    if (Object.keys(productChanges).length) {
      productUpdates.push({ productId, changes: productChanges });
    }

    const storePackages = storePackagesByProductId.get(productId) || [];
    const llPackageIds = llPackages.map((pkg) => pkg.packageId).sort((a, b) => a - b);
    const storePackageIds = storePackages.map((pkg) => pkg.id).sort((a, b) => a - b);
    const llPackagesById = mapBy(llPackages, "packageId");
    const storePackagesById = mapBy(storePackages, "id");

    if (!arraysEqual(storePackageIds, llPackageIds)) {
      packageShapeMismatches.push({
        productId,
        storePackageIds,
        localLinePackageIds: llPackageIds,
        missingInStorePackages: llPackages
          .filter((pkg) => !storePackagesById.has(pkg.packageId))
          .map((pkg) => ({
            packageId: pkg.packageId,
            name: pkg.name,
            price: pkg.price,
            packageCode: pkg.packageCode
          })),
        missingInLocalLinePackages: storePackages
          .filter((pkg) => !llPackagesById.has(pkg.id))
          .map((pkg) => ({
            packageId: pkg.id,
            name: pkg.name,
            price: pkg.price,
            packageCode: pkg.packageCode
          }))
      });
    }

    for (const llPackage of llPackages) {
      const storePackage = storePackagesById.get(llPackage.packageId);
      if (!storePackage) continue;

      const packageChanges = {};
      compareTextField(packageChanges, "name", storePackage.name, llPackage.name);
      compareNumberField(packageChanges, "price", storePackage.price, llPackage.price);
      compareTextField(packageChanges, "packageCode", storePackage.packageCode, llPackage.packageCode);
      compareBoolField(packageChanges, "visible", storePackage.visible, llProduct.visible);
      compareBoolField(
        packageChanges,
        "trackInventory",
        storePackage.trackInventory,
        llPackage.packageInventory !== null
      );
      if (llPackage.packageInventory !== null) {
        compareNumberField(packageChanges, "inventory", storePackage.inventory, llPackage.packageInventory);
      } else if (storePackage.inventory !== null && typeof storePackage.inventory !== "undefined") {
        compareNumberField(packageChanges, "inventory", storePackage.inventory, null);
        suppressedWarnings.packageInventoryNullSkipped += 1;
      }

      if (Object.keys(packageChanges).length) {
        packageUpdates.push({
          productId,
          packageId: llPackage.packageId,
          changes: packageChanges
        });
      }
    }
  }

  const localLineProductIds = new Set(exportCatalog.productsById.keys());
  for (const storeProduct of storeCatalog.products) {
    if (!localLineProductIds.has(storeProduct.id)) {
      missingLocalLineProducts.push({
        productId: storeProduct.id,
        storeName: storeProduct.name
      });
    }
  }

  return {
    missingStoreProducts,
    missingLocalLineProducts,
    productUpdates,
    packageUpdates,
    packageShapeMismatches,
    suppressedWarnings
  };
}

function buildPricelistComparison(pricelistRows, storeCatalog, liveDetails) {
  const storeProductsById = mapBy(storeCatalog.products, "id");
  const storePackagesByProductId = groupBy(storeCatalog.packages, "productId");
  const liveByProductId = new Map(liveDetails.map((item) => [item.productId, item]));

  const liveFetchErrors = [];
  const missingLiveProducts = [];
  const productFieldMismatches = [];
  const packageFieldMismatches = [];
  const priceListEntryMismatches = [];
  const fixedAdjustmentEntries = [];
  const extraPriceListEntries = [];
  const pricingErrors = [];

  for (const row of pricelistRows) {
    const productId = Number(row.localLineProductID);
    const storeProduct = storeProductsById.get(productId);
    const storePackage = (storePackagesByProductId.get(productId) || [])[0];
    const live = liveByProductId.get(productId);

    if (!live?.ok) {
      liveFetchErrors.push({
        productId,
        pricelistId: row.id,
        status: live?.status ?? null,
        error: live?.error ?? "missing"
      });
      continue;
    }

    const body = live.body;
    const livePackage = (body.packages || [])[0];
    if (!livePackage) {
      missingLiveProducts.push({
        productId,
        pricelistId: row.id,
        reason: "no-live-package"
      });
      continue;
    }

    try {
      const expectedBasePrice = computePurchasePriceFromPricelist(row);
      const actualBasePrice = toNumber(livePackage.package_price ?? livePackage.unit_price);
      const categoryName = storeProduct?.categoryName || "";
      const expectedLists = expectedPriceListConfig(categoryName);
      const actualEntries = Array.isArray(livePackage.price_list_entries)
        ? livePackage.price_list_entries
        : [];
      const actualEntryByListId = new Map(actualEntries.map((entry) => [entry.price_list_id, entry]));
      const expectedListIds = expectedLists.map((entry) => entry.id).sort((a, b) => a - b);
      const actualListIds = actualEntries.map((entry) => entry.price_list_id).sort((a, b) => a - b);

      const productChanges = {};
      compareTextField(productChanges, "pricelistName", row.productName, body.name);
      compareBoolField(productChanges, "visible", row.visible, body.visible);
      compareBoolField(productChanges, "trackInventory", row.track_inventory, body.track_inventory);
      if (Object.keys(productChanges).length) {
        productFieldMismatches.push({
          productId,
          pricelistId: row.id,
          changes: productChanges
        });
      }

      const packageChanges = {};
      compareTextField(packageChanges, "pricelistPackageName", row.packageName, livePackage.name);
      compareNumberField(packageChanges, "expectedBasePrice", expectedBasePrice, actualBasePrice);
      compareTextField(packageChanges, "upc", row.upc, livePackage.package_code);
      if (storePackage) {
        compareTextField(packageChanges, "storePackageName", storePackage.name, livePackage.name);
        compareNumberField(packageChanges, "storePackagePrice", storePackage.price, actualBasePrice);
      }
      if (Object.keys(packageChanges).length) {
        packageFieldMismatches.push({
          productId,
          pricelistId: row.id,
          packageId: livePackage.id,
          changes: packageChanges
        });
      }

      const extraListIds = actualListIds.filter((id) => !expectedListIds.includes(id));
      if (extraListIds.length) {
        extraPriceListEntries.push({
          productId,
          pricelistId: row.id,
          extraListIds
        });
      }

      for (const list of expectedLists) {
        const actualEntry = actualEntryByListId.get(list.id);
        const expectedEntry = buildExpectedPriceListEntry(
          expectedBasePrice,
          list.markup,
          Boolean(row.sale),
          Number(row.sale_discount || 0),
          actualEntry?.adjustment_type
        );

        if (!actualEntry) {
          priceListEntryMismatches.push({
            productId,
            pricelistId: row.id,
            priceListId: list.id,
            reason: "missing-live-entry",
            expected: expectedEntry
          });
          continue;
        }

        const actualFinalPrice = computeActualFinalPrice(actualBasePrice, actualEntry);
        const liveEntryMismatch = {
          productId,
          pricelistId: row.id,
          priceListId: list.id,
          priceListName: list.name,
          actual: {
            adjustmentType: actualEntry.adjustment_type ?? null,
            adjustmentValue: actualEntry.adjustment_value ?? null,
            finalPrice: actualFinalPrice,
            onSale: Boolean(actualEntry.on_sale),
            onSaleToggle: Boolean(actualEntry.on_sale_toggle),
            strikethroughDisplayValue: actualEntry.strikethrough_display_value ?? null
          },
          expected: expectedEntry
        };

        if (actualEntry.adjustment_type === 1) {
          fixedAdjustmentEntries.push(liveEntryMismatch);
        }

        const actualFinalMismatch =
          actualFinalPrice === null ||
          Math.abs(actualFinalPrice - expectedEntry.finalPrice) > 0.009;
        const onSaleMismatch = Boolean(actualEntry.on_sale) !== expectedEntry.onSale;

        if (actualFinalMismatch || onSaleMismatch) {
          priceListEntryMismatches.push({
            ...liveEntryMismatch,
            reason: [
              actualFinalMismatch ? "final-price" : null,
              onSaleMismatch ? "on-sale-flag" : null
            ].filter(Boolean)
          });
        }
      }
    } catch (error) {
      pricingErrors.push({
        productId,
        pricelistId: row.id,
        error: error.message
      });
    }
  }

  return {
    liveFetchErrors,
    missingLiveProducts,
    productFieldMismatches,
    packageFieldMismatches,
    priceListEntryMismatches,
    fixedAdjustmentEntries,
    extraPriceListEntries,
    pricingErrors
  };
}

function writeReport(reportFile, report) {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
}

function limitRows(rows, limit) {
  return rows.slice(0, limit);
}

function reasonsInclude(reason, target) {
  if (Array.isArray(reason)) return reason.includes(target);
  return reason === target;
}

function buildProposedStoreCreates(catalogComparison) {
  return catalogComparison.missingStoreProducts.map((item) => ({
    action: "create-store-product-from-localline",
    productId: item.productId,
    product: {
      id: item.productId,
      name: item.localLineName,
      description: item.description || null,
      visible: item.visible ? 1 : 0,
      trackInventory: item.trackInventory ? 1 : 0,
      inventory: item.inventory ?? null
    },
    packages: item.packages || []
  }));
}

function buildProposedStorePackageShapeFixes(catalogComparison) {
  return catalogComparison.packageShapeMismatches.flatMap((item) => {
    const proposals = [];

    for (const pkg of item.missingInStorePackages || []) {
      proposals.push({
        action: "add-missing-store-package",
        productId: item.productId,
        packageId: pkg.packageId,
        package: pkg
      });
    }

    for (const pkg of item.missingInLocalLinePackages || []) {
      proposals.push({
        action: "review-extra-store-package",
        productId: item.productId,
        packageId: pkg.packageId,
        package: pkg
      });
    }

    return proposals;
  });
}

function buildProposedPricelistRowUpdates(pricelistComparison) {
  const merged = new Map();

  const ensureRow = (item) => {
    const key = `${item.pricelistId}:${item.productId}`;
    if (!merged.has(key)) {
      merged.set(key, {
        action: "update-pricelist-row-from-localline",
        pricelistId: item.pricelistId,
        productId: item.productId,
        changes: {}
      });
    }
    return merged.get(key);
  };

  for (const item of pricelistComparison.productFieldMismatches) {
    const row = ensureRow(item);
    for (const [field, change] of Object.entries(item.changes || {})) {
      if (field === "pricelistName") {
        row.changes.productName = change.to;
      } else if (field === "trackInventory") {
        row.changes.track_inventory = change.to ? 1 : 0;
      } else if (field === "visible") {
        row.changes.visible = change.to ? 1 : 0;
      }
    }
  }

  for (const item of pricelistComparison.packageFieldMismatches) {
    const row = ensureRow(item);
    for (const [field, change] of Object.entries(item.changes || {})) {
      if (field === "pricelistPackageName") {
        row.changes.packageName = change.to;
      } else if (field === "upc") {
        row.changes.upc = change.to;
      }
    }
  }

  return [...merged.values()].filter((item) => Object.keys(item.changes).length > 0);
}

function buildProposedPriceListCaptures(pricelistComparison) {
  return pricelistComparison.priceListEntryMismatches.map((item) => ({
    action: reasonsInclude(item.reason, "missing-live-entry")
      ? "review-missing-live-price-list-entry"
      : "capture-live-price-list-override",
    productId: item.productId,
    pricelistId: item.pricelistId,
    priceListId: item.priceListId,
    priceListName: item.priceListName || null,
    actual: item.actual || null,
    expected: item.expected || null,
    reason: item.reason
  }));
}

function buildSuggestedFixes(catalogComparison, pricelistComparison, proposals) {
  const items = [];

  if (proposals.storeProductCreates.length) {
    items.push({
      key: "create-store-products",
      severity: "action",
      title: "Create missing local store products from Local Line",
      count: proposals.storeProductCreates.length,
      detail: "These products exist in Local Line export but not in local products/packages.",
      applySupported: true
    });
  }

  if (catalogComparison.productUpdates.length || catalogComparison.packageUpdates.length) {
    items.push({
      key: "sync-store-catalog-fields",
      severity: "action",
      title: "Sync local product and package fields from Local Line",
      count: catalogComparison.productUpdates.length + catalogComparison.packageUpdates.length,
      detail: "These are concrete local DB updates for names, descriptions, visibility, package names, prices, and package codes.",
      applySupported: true
    });
  }

  if (proposals.storePackageShapeFixes.length) {
    const actionableCount = proposals.storePackageShapeFixes.filter(
      (item) => item.action === "add-missing-store-package"
    ).length;
    items.push({
      key: "repair-package-shape",
      severity: "action",
      title: "Repair package-shape mismatches",
      count: proposals.storePackageShapeFixes.length,
      detail: "These products have different package sets in Local Line and the local store.",
      applySupported: actionableCount > 0
    });
  }

  if (proposals.pricelistRowUpdates.length) {
    items.push({
      key: "align-pricelist-row-fields",
      severity: "action",
      title: "Align pricelist text and flags from live Local Line",
      count: proposals.pricelistRowUpdates.length,
      detail: "These update product/package names, visibility, track inventory, and UPC values in the pricelist table.",
      applySupported: false
    });
  }

  if (pricelistComparison.liveFetchErrors.length) {
    items.push({
      key: "repair-dead-localline-mappings",
      severity: "error",
      title: "Repair dead or unauthorized Local Line product mappings",
      count: pricelistComparison.liveFetchErrors.length,
      detail: "These pricelist rows point at Local Line product ids that could not be fetched.",
      applySupported: false
    });
  }

  const missingLiveEntries = pricelistComparison.priceListEntryMismatches.filter((item) =>
    reasonsInclude(item.reason, "missing-live-entry")
  );
  if (missingLiveEntries.length) {
    items.push({
      key: "review-missing-price-list-entries",
      severity: "warn",
      title: "Review missing Local Line price-list memberships",
      count: missingLiveEntries.length,
      detail: "These products are missing one or more expected Local Line price list entries.",
      applySupported: false
    });
  }

  if (pricelistComparison.fixedAdjustmentEntries.length) {
    items.push({
      key: "capture-fixed-adjustments",
      severity: "warn",
      title: "Capture live fixed-price overrides",
      count: pricelistComparison.fixedAdjustmentEntries.length,
      detail: "These rows use fixed adjustments in Local Line and should be treated as live overrides instead of formula-only pricing.",
      applySupported: false
    });
  }

  const overrideEntries = proposals.priceListOverrideCaptures.filter(
    (item) => item.action === "capture-live-price-list-override"
  );
  if (overrideEntries.length) {
    items.push({
      key: "persist-live-price-list-overrides",
      severity: "schema",
      title: "Persist live Local Line price-list overrides in local data",
      count: overrideEntries.length,
      detail: "The current schema cannot represent all live Local Line price-list behaviors, so these overrides should be stored explicitly.",
      applySupported: false
    });
  }

  return items;
}

function buildActionableProposals(proposals, selectedFixKeys = []) {
  const requested = new Set(
    (Array.isArray(selectedFixKeys) ? selectedFixKeys : [selectedFixKeys]).filter(Boolean)
  );
  const includeAll = requested.size === 0;
  const selected = [];

  if (includeAll || requested.has("create-store-products")) {
    selected.push(...proposals.storeProductCreates);
  }

  if (includeAll || requested.has("sync-store-catalog-fields")) {
    selected.push(...proposals.storeProductUpdates, ...proposals.storePackageUpdates);
  }

  if (includeAll || requested.has("repair-package-shape")) {
    selected.push(
      ...proposals.storePackageShapeFixes.filter((item) => item.action === "add-missing-store-package")
    );
  }

  return selected;
}

function toTinyInt(value) {
  if (value === null || typeof value === "undefined") return null;
  return value ? 1 : 0;
}

function extractStoreProductValues(proposal) {
  const values = {};
  for (const [field, change] of Object.entries(proposal.changes || {})) {
    if (field === "name") {
      values.name = change.to ?? null;
    } else if (field === "description") {
      values.description = change.to ?? null;
    } else if (field === "visible") {
      values.visible = toTinyInt(change.to);
    } else if (field === "trackInventory") {
      values.track_inventory = toTinyInt(change.to);
    } else if (field === "inventory") {
      values.inventory = change.to ?? null;
    }
  }
  values.updated_at = new Date();
  return values;
}

function extractStorePackageValues(proposal) {
  const values = {};
  for (const [field, change] of Object.entries(proposal.changes || {})) {
    if (field === "name") {
      values.name = change.to ?? null;
    } else if (field === "price") {
      values.price = change.to ?? null;
    } else if (field === "packageCode") {
      values.package_code = change.to ?? null;
    } else if (field === "visible") {
      values.visible = toTinyInt(change.to);
    } else if (field === "trackInventory") {
      values.track_inventory = toTinyInt(change.to);
    } else if (field === "inventory") {
      values.inventory = change.to ?? null;
    }
  }
  return values;
}

async function runUpdateQuery(connection, table, idColumn, idValue, values) {
  const entries = Object.entries(values).filter(([, value]) => typeof value !== "undefined");
  if (!entries.length) {
    return { updated: false, reason: "no-op" };
  }

  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  params.push(idValue);

  await connection.query(`UPDATE ${table} SET ${assignments} WHERE ${idColumn} = ?`, params);
  return { updated: true };
}

async function applyCreateStoreProduct(connection, proposal, state) {
  if (state.productsById.has(proposal.productId)) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      status: "skipped",
      reason: "product-already-exists"
    };
  }

  await connection.beginTransaction();
  try {
    await connection.query(
      `
        INSERT INTO products (
          id,
          name,
          description,
          visible,
          track_inventory,
          inventory,
          created_at,
          updated_at,
          is_deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        proposal.product.id,
        proposal.product.name,
        proposal.product.description ?? null,
        proposal.product.visible ?? 0,
        proposal.product.trackInventory ?? 0,
        proposal.product.inventory ?? null,
        new Date(),
        new Date(),
        0
      ]
    );

    for (const pkg of proposal.packages || []) {
      await connection.query(
        `
          INSERT INTO packages (
            id,
            product_id,
            name,
            price,
            package_code,
            num_of_items,
            visible,
            track_inventory,
            inventory
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          pkg.packageId,
          proposal.productId,
          pkg.name ?? null,
          pkg.price ?? null,
          pkg.packageCode ?? null,
          pkg.numOfItems ?? null,
          toTinyInt(pkg.visible) ?? proposal.product.visible ?? 0,
          toTinyInt(pkg.trackInventory) ?? 0,
          pkg.inventory ?? null
        ]
      );
    }

    await connection.commit();
    state.productsById.set(proposal.productId, { id: proposal.productId });
    for (const pkg of proposal.packages || []) {
      state.packagesById.set(pkg.packageId, {
        id: pkg.packageId,
        productId: proposal.productId
      });
    }

    return {
      action: proposal.action,
      productId: proposal.productId,
      status: "applied",
      packageCount: (proposal.packages || []).length
    };
  } catch (error) {
    await connection.rollback();
    return {
      action: proposal.action,
      productId: proposal.productId,
      status: "error",
      error: error.message
    };
  }
}

async function applyUpdateStoreProduct(connection, proposal, state) {
  if (!state.productsById.has(proposal.productId)) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      status: "error",
      error: "product-missing-in-store"
    };
  }

  try {
    const values = extractStoreProductValues(proposal);
    const result = await runUpdateQuery(connection, "products", "id", proposal.productId, values);
    return {
      action: proposal.action,
      productId: proposal.productId,
      status: result.updated ? "applied" : "skipped",
      reason: result.reason || null,
      updatedFields: Object.keys(values).filter((key) => key !== "updated_at")
    };
  } catch (error) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      status: "error",
      error: error.message
    };
  }
}

async function applyUpdateStorePackage(connection, proposal, state) {
  if (!state.packagesById.has(proposal.packageId)) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "error",
      error: "package-missing-in-store"
    };
  }

  try {
    const values = extractStorePackageValues(proposal);
    const result = await runUpdateQuery(connection, "packages", "id", proposal.packageId, values);
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: result.updated ? "applied" : "skipped",
      reason: result.reason || null,
      updatedFields: Object.keys(values)
    };
  } catch (error) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "error",
      error: error.message
    };
  }
}

async function applyAddMissingStorePackage(connection, proposal, state) {
  if (state.packagesById.has(proposal.packageId)) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "skipped",
      reason: "package-already-exists"
    };
  }

  if (!state.productsById.has(proposal.productId)) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "error",
      error: "product-missing-in-store"
    };
  }

  try {
    await connection.query(
      `
        INSERT INTO packages (
          id,
          product_id,
          name,
          price,
          package_code,
          num_of_items,
          visible,
          track_inventory,
          inventory
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        proposal.packageId,
        proposal.productId,
        proposal.package?.name ?? null,
        proposal.package?.price ?? null,
        proposal.package?.packageCode ?? null,
        proposal.package?.numOfItems ?? null,
        1,
        0,
        null
      ]
    );

    state.packagesById.set(proposal.packageId, {
      id: proposal.packageId,
      productId: proposal.productId
    });

    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "applied"
    };
  } catch (error) {
    return {
      action: proposal.action,
      productId: proposal.productId,
      packageId: proposal.packageId,
      status: "error",
      error: error.message
    };
  }
}

async function applySelectedProposals(storeConnection, _pricelistConnection, storeCatalog, proposals, options = {}) {
  const state = {
    productsById: mapBy(storeCatalog.products, "id"),
    packagesById: mapBy(storeCatalog.packages, "id")
  };
  const selectedFixKeys = Array.isArray(options.selectedFixKeys) ? options.selectedFixKeys : [];
  const actionable = buildActionableProposals(proposals, selectedFixKeys);
  const results = [];

  for (const proposal of actionable) {
    if (proposal.action === "create-store-product-from-localline") {
      results.push(await applyCreateStoreProduct(storeConnection, proposal, state));
    } else if (proposal.action === "update-store-product-from-localline") {
      results.push(await applyUpdateStoreProduct(storeConnection, proposal, state));
    } else if (proposal.action === "update-store-package-from-localline") {
      results.push(await applyUpdateStorePackage(storeConnection, proposal, state));
    } else if (proposal.action === "add-missing-store-package") {
      results.push(await applyAddMissingStorePackage(storeConnection, proposal, state));
    }
  }

  const summary = {
    selectedFixKeys,
    attempted: actionable.length,
    applied: results.filter((item) => item.status === "applied").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    errors: results.filter((item) => item.status === "error").length,
    createdProducts: results.filter(
      (item) => item.status === "applied" && item.action === "create-store-product-from-localline"
    ).length,
    updatedProducts: results.filter(
      (item) => item.status === "applied" && item.action === "update-store-product-from-localline"
    ).length,
    updatedPackages: results.filter(
      (item) =>
        item.status === "applied" &&
        (item.action === "update-store-package-from-localline" || item.action === "add-missing-store-package")
    ).length,
    updatedPricelistRows: 0,
    reviewOnlySkipped:
      proposals.storePackageShapeFixes.filter((item) => item.action === "review-extra-store-package").length +
      proposals.reviewMissingLocalLineProducts.length +
      proposals.repairDeadMappings.length +
      proposals.priceListOverrideCaptures.length
  };

  return { summary, results };
}

async function main() {
  const { summary } = await runLocalLineAudit({
    killdeerEnvPath: getArg("killdeer-env") || undefined,
    reportFile: getArg("report-file") || path.join("tmp", "localline-audit-report.json"),
    includeInactive: hasFlag("include-inactive"),
    skipPricelist: !hasFlag("with-pricelist"),
    write: hasFlag("write"),
    selectedFixKeys: getListArg("fixes"),
    limit: Number(getArg("limit") || 20),
    concurrency: Number(getArg("concurrency") || 5)
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function runLocalLineAudit(options = {}) {
  const storeEnvPath = resolveFromRepoRoot(".env");
  const killdeerEnvPath = options.killdeerEnvPath
    ? resolveFromRepoRoot(options.killdeerEnvPath)
    : null;
  const reportFile = resolveFromRepoRoot(
    options.reportFile || path.join("tmp", "localline-audit-report.json")
  );
  const includeInactive = Boolean(options.includeInactive);
  const skipPricelist = options.skipPricelist !== false;
  const write = Boolean(options.write);
  const selectedFixKeys = Array.isArray(options.selectedFixKeys)
    ? options.selectedFixKeys.filter(Boolean)
    : [];
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 5;
  const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  dotenv.config({ path: storeEnvPath });
  const baseUrl = process.env.LL_BASEURL || "https://localline.ca/api/backoffice/v2/";
  const storeConfig = {
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store"
  };

  if (!skipPricelist && killdeerEnvPath) {
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
  const killdeerConnection = skipPricelist ? null : await mysql.createConnection(killdeerConfig);

  try {
    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "running",
      percent: 2,
      message: "Authenticating with Local Line"
    });
    const token = await getLocalLineAccessToken(baseUrl);
    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "running",
      percent: 6,
      message: "Downloading Local Line export"
    });
    const exportFilePath = await downloadLocalLineExport(baseUrl, token);
    const exportCatalog = parseLocalLineExport(exportFilePath);
    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "running",
      percent: 10,
      message: skipPricelist
        ? "Loading csa-store data"
        : "Loading csa-store and pricelist data"
    });
    const storeCatalog = await fetchStoreCatalog(storeConnection);
    const pricelistState = skipPricelist
      ? {
          rows: [],
          sourceTable: null,
          warning: "Pricelist comparison skipped; running in store + Local Line only mode."
        }
      : await fetchCurrentPricelist(killdeerConnection, { includeInactive });
    const pricelistRows = pricelistState.rows;

    const catalogComparison = buildCatalogComparison(exportCatalog, storeCatalog);
    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "running",
      percent: 14,
      message: pricelistRows.length
        ? "Fetching Local Line details for pricelist products"
        : "No pricelist source found; skipping pricelist comparison",
      current: 0,
      total: pricelistRows.length
    });
    const liveDetails = await mapWithConcurrency(
      pricelistRows.map((row) => Number(row.localLineProductID)),
      Number.isFinite(concurrency) ? concurrency : 5,
      (productId) => fetchLocalLineProductDetail(baseUrl, token, productId),
      ({ completed, total }) => {
        reportProgress({
          phaseKey: "catalog-sync",
          phaseLabel: "Catalog Sync",
          status: "running",
          percent: total ? 14 + Math.round((completed / total) * 18) : 32,
          message: "Fetching Local Line details for pricelist products",
          current: completed,
          total
        });
      }
    );
    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "running",
      percent: 34,
      message: write ? "Applying csa-store catalog updates" : "Building comparison report"
    });
    const pricelistComparison = buildPricelistComparison(pricelistRows, storeCatalog, liveDetails);
    const proposals = {
      storeProductCreates: buildProposedStoreCreates(catalogComparison),
      storeProductUpdates: catalogComparison.productUpdates.map((item) => ({
        action: "update-store-product-from-localline",
        ...item
      })),
      storePackageUpdates: catalogComparison.packageUpdates.map((item) => ({
        action: "update-store-package-from-localline",
        ...item
      })),
      storePackageShapeFixes: buildProposedStorePackageShapeFixes(catalogComparison),
      pricelistRowUpdates: buildProposedPricelistRowUpdates(pricelistComparison),
      priceListOverrideCaptures: buildProposedPriceListCaptures(pricelistComparison),
      reviewMissingLocalLineProducts: catalogComparison.missingLocalLineProducts.map((item) => ({
        action: "review-store-product-missing-in-localline",
        ...item
      })),
      repairDeadMappings: pricelistComparison.liveFetchErrors.map((item) => ({
        action: "repair-dead-localline-mapping",
        ...item
      }))
    };
    const suggestedFixes = buildSuggestedFixes(catalogComparison, pricelistComparison, proposals);
    const applyResult = write
      ? await applySelectedProposals(
          storeConnection,
          killdeerConnection,
          storeCatalog,
          proposals,
          { selectedFixKeys }
        )
      : null;

    reportProgress({
      phaseKey: "catalog-sync",
      phaseLabel: "Catalog Sync",
      status: "completed",
      percent: 40,
      message: write ? "Catalog sync complete" : "Catalog analysis complete"
    });

    const report = {
      mode: write ? "apply" : "dry-run",
      generatedAt: new Date().toISOString(),
      storeEnvPath,
      killdeerEnvPath: skipPricelist ? null : killdeerEnvPath,
      exportFilePath,
      localLineBaseUrl: baseUrl,
      includeInactive,
      skipPricelist,
      selectedFixKeys,
      pricelistSource: {
        table: pricelistState.sourceTable,
        warning: pricelistState.warning
      },
      exportSummary: {
        localLineProducts: exportCatalog.productCount,
        localLinePackages: exportCatalog.packageCount,
        storeProducts: storeCatalog.products.length,
        storePackages: storeCatalog.packages.length,
        pricelistRows: pricelistRows.length
      },
      catalogComparison,
      pricelistComparison,
      proposedUpdates: proposals,
      suggestedFixes,
      applyResult
    };

    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    writeReport(reportFile, report);

    const summary = {
      mode: report.mode,
      reportFile,
      exportSummary: report.exportSummary,
      skipPricelist: report.skipPricelist,
      pricelistSource: report.pricelistSource,
      catalogSummary: {
        missingStoreProducts: catalogComparison.missingStoreProducts.length,
        missingLocalLineProducts: catalogComparison.missingLocalLineProducts.length,
        productUpdates: catalogComparison.productUpdates.length,
        packageUpdates: catalogComparison.packageUpdates.length,
        packageShapeMismatches: catalogComparison.packageShapeMismatches.length,
        suppressedLowSignalWarnings: catalogComparison.suppressedWarnings
      },
      pricelistSummary: {
        liveFetchErrors: pricelistComparison.liveFetchErrors.length,
        missingLiveProducts: pricelistComparison.missingLiveProducts.length,
        productFieldMismatches: pricelistComparison.productFieldMismatches.length,
        packageFieldMismatches: pricelistComparison.packageFieldMismatches.length,
        priceListEntryMismatches: pricelistComparison.priceListEntryMismatches.length,
        fixedAdjustmentEntries: pricelistComparison.fixedAdjustmentEntries.length,
        extraPriceListEntries: pricelistComparison.extraPriceListEntries.length,
        pricingErrors: pricelistComparison.pricingErrors.length
      },
      suggestedFixes: limitRows(suggestedFixes, limit),
      applySummary: applyResult?.summary || null,
      proposedUpdateSummary: {
        storeProductCreates: proposals.storeProductCreates.length,
        storeProductUpdates: proposals.storeProductUpdates.length,
        storePackageUpdates: proposals.storePackageUpdates.length,
        storePackageShapeFixes: proposals.storePackageShapeFixes.length,
        pricelistRowUpdates: proposals.pricelistRowUpdates.length,
        priceListOverrideCaptures: proposals.priceListOverrideCaptures.length,
        reviewMissingLocalLineProducts: proposals.reviewMissingLocalLineProducts.length,
        repairDeadMappings: proposals.repairDeadMappings.length
      },
      sampleProposedStoreProductCreates: limitRows(proposals.storeProductCreates, limit),
      sampleProposedStoreProductUpdates: limitRows(proposals.storeProductUpdates, limit),
      sampleProposedStorePackageUpdates: limitRows(proposals.storePackageUpdates, limit),
      sampleProposedStorePackageShapeFixes: limitRows(proposals.storePackageShapeFixes, limit),
      sampleProposedPricelistRowUpdates: limitRows(proposals.pricelistRowUpdates, limit),
      sampleProposedPriceListOverrideCaptures: limitRows(proposals.priceListOverrideCaptures, limit),
      sampleRepairDeadMappings: limitRows(proposals.repairDeadMappings, limit),
      sampleApplyResults: limitRows(applyResult?.results || [], limit),
      sampleCatalogProductUpdates: limitRows(catalogComparison.productUpdates, limit),
      sampleCatalogPackageUpdates: limitRows(catalogComparison.packageUpdates, limit),
      sampleMissingStoreProducts: limitRows(catalogComparison.missingStoreProducts, limit),
      sampleMissingLocalLineProducts: limitRows(catalogComparison.missingLocalLineProducts, limit),
      samplePackageShapeMismatches: limitRows(catalogComparison.packageShapeMismatches, limit),
      samplePricelistProductMismatches: limitRows(pricelistComparison.productFieldMismatches, limit),
      samplePricelistPackageMismatches: limitRows(pricelistComparison.packageFieldMismatches, limit),
      samplePricelistEntryMismatches: limitRows(pricelistComparison.priceListEntryMismatches, limit),
      sampleFixedAdjustmentEntries: limitRows(pricelistComparison.fixedAdjustmentEntries, limit),
      sampleLiveFetchErrors: limitRows(pricelistComparison.liveFetchErrors, limit),
      samplePricingErrors: limitRows(pricelistComparison.pricingErrors, limit)
    };

    return { report, summary };
  } finally {
    await Promise.allSettled([storeConnection.end(), killdeerConnection?.end?.()]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
