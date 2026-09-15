import crypto from "crypto";
import { ensureSquareSyncSchema, getPool } from "../db.js";
import {
  getCustomerFacingSaleDiscount,
  resolvePricingProfile
} from "./productPricing.js";

const DEFAULT_SQUARE_API_VERSION = "2026-08-19";
const DEFAULT_SQUARE_CURRENCY = "USD";
const COMMON_NAME_TOKENS = new Set([
  "and",
  "the",
  "with",
  "pkg",
  "package",
  "packages",
  "each",
  "ea",
  "lb",
  "lbs",
  "pound",
  "pounds",
  "oz",
  "ounce",
  "ounces"
]);

function toNumber(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toTinyInt(value) {
  if (value === null || typeof value === "undefined") return null;
  return value ? 1 : 0;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function databaseTimestampNow() {
  const date = new Date();
  date.setMilliseconds(0);
  return date;
}

function normalizeCurrency(value) {
  return String(value || DEFAULT_SQUARE_CURRENCY).trim().toUpperCase() || DEFAULT_SQUARE_CURRENCY;
}

function configuredCurrency() {
  return normalizeCurrency(process.env.SQUARE_CURRENCY || DEFAULT_SQUARE_CURRENCY);
}

function dollarsToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function centsToDollars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number((numeric / 100).toFixed(2));
}

function jsonString(value) {
  if (value === null || typeof value === "undefined") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getSquareConfig() {
  const environment = String(process.env.SQUARE_ENVIRONMENT || "production").trim().toLowerCase();
  const baseUrl =
    process.env.SQUARE_BASE_URL ||
    (environment === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com");

  return {
    accessToken: process.env.SQUARE_ACCESS_TOKEN || "",
    environment,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    locationId: process.env.SQUARE_LOCATION_ID || "",
    apiVersion: process.env.SQUARE_API_VERSION || DEFAULT_SQUARE_API_VERSION,
    currency: configuredCurrency()
  };
}

export function isSquareEnabled() {
  return Boolean(getSquareConfig().accessToken);
}

async function fetchSquare(path, options = {}) {
  const config = getSquareConfig();
  if (!config.accessToken) {
    throw new Error("Square access token is not configured.");
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Square-Version": config.apiVersion,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const body = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })()
    : {};

  if (!response.ok) {
    const detail =
      Array.isArray(body?.errors) && body.errors.length
        ? body.errors.map((error) => error.detail || error.code).filter(Boolean).join("; ")
        : body?.raw || text || response.statusText;
    throw new Error(`Square request failed (${response.status}): ${detail}`);
  }

  return body;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

async function listSquareCatalogItems() {
  const objects = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ types: "ITEM" });
    if (cursor) params.set("cursor", cursor);
    const payload = await fetchSquare(`/v2/catalog/list?${params.toString()}`);
    objects.push(...(Array.isArray(payload.objects) ? payload.objects : []));
    cursor = payload.cursor || null;
  } while (cursor);

  return objects.filter((object) => object?.type === "ITEM");
}

async function batchRetrieveSquareObjects(objectIds) {
  const uniqueIds = [...new Set(objectIds.filter(Boolean))];
  const objects = [];

  for (const idChunk of chunk(uniqueIds, 1000)) {
    const payload = await fetchSquare("/v2/catalog/batch-retrieve", {
      method: "POST",
      body: JSON.stringify({
        object_ids: idChunk,
        include_related_objects: true
      })
    });
    objects.push(...(Array.isArray(payload.objects) ? payload.objects : []));
  }

  return objects;
}

async function batchUpsertSquareObjects(objects) {
  const cleanObjects = objects.filter(Boolean);
  if (!cleanObjects.length) {
    return { objects: [] };
  }

  const responseObjects = [];
  for (const objectChunk of chunk(cleanObjects, 1000)) {
    const payload = await fetchSquare("/v2/catalog/batch-upsert", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        batches: [{ objects: objectChunk }]
      })
    });
    responseObjects.push(...(Array.isArray(payload.objects) ? payload.objects : []));
  }

  return { objects: responseObjects };
}

async function startSquareRun(connection, mode, userId = null) {
  const now = new Date();
  const [result] = await connection.query(
    `
      INSERT INTO square_sync_runs (
        mode,
        status,
        started_at,
        created_by_user_id,
        created_at,
        updated_at
      ) VALUES (?, 'running', ?, ?, ?, ?)
    `,
    [mode, now, userId || null, now, now]
  );
  return Number(result.insertId);
}

async function finishSquareRun(connection, runId, status, summary = {}, errorMessage = null) {
  const now = new Date();
  await connection.query(
    `
      UPDATE square_sync_runs
      SET status = ?,
          finished_at = ?,
          summary_json = ?,
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [status, now, jsonString(summary), errorMessage || null, now, runId]
  );
}

async function insertSquareResult(connection, runId, row) {
  await connection.query(
    `
      INSERT INTO square_sync_results (
        sync_run_id,
        product_id,
        package_id,
        square_item_id,
        square_variation_id,
        action,
        status,
        local_price_amount,
        remote_price_amount,
        currency,
        message,
        raw_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      runId,
      row.productId || null,
      row.packageId || null,
      row.squareItemId || null,
      row.squareVariationId || null,
      row.action || null,
      row.status || "unknown",
      Number.isFinite(Number(row.localPriceAmount)) ? Number(row.localPriceAmount) : null,
      Number.isFinite(Number(row.remotePriceAmount)) ? Number(row.remotePriceAmount) : null,
      row.currency || null,
      row.message || null,
      jsonString(row.raw || null),
      new Date()
    ]
  );
}

async function upsertSquareItem(connection, item, syncAt) {
  const data = item?.item_data || {};
  const now = new Date();
  await connection.query(
    `
      INSERT INTO square_catalog_items (
        square_item_id,
        name,
        description,
        version,
        updated_at_remote,
        is_deleted,
        present_at_all_locations,
        raw_json,
        created_at,
        updated_at,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        version = VALUES(version),
        updated_at_remote = VALUES(updated_at_remote),
        is_deleted = VALUES(is_deleted),
        present_at_all_locations = VALUES(present_at_all_locations),
        raw_json = VALUES(raw_json),
        updated_at = VALUES(updated_at),
        last_synced_at = VALUES(last_synced_at)
    `,
    [
      item.id,
      data.name || "",
      data.description || data.description_plaintext || null,
      item.version === null || typeof item.version === "undefined" ? null : String(item.version),
      toDate(item.updated_at),
      toTinyInt(Boolean(item.is_deleted)),
      toTinyInt(item.present_at_all_locations),
      jsonString(item),
      now,
      now,
      syncAt
    ]
  );
}

async function upsertSquareVariation(connection, variation, fallbackItemId, syncAt) {
  const data = variation?.item_variation_data || {};
  const priceMoney = data.price_money || {};
  const now = new Date();
  await connection.query(
    `
      INSERT INTO square_catalog_variations (
        square_variation_id,
        square_item_id,
        name,
        sku,
        pricing_type,
        price_amount,
        currency,
        version,
        updated_at_remote,
        is_deleted,
        present_at_all_locations,
        raw_json,
        created_at,
        updated_at,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        square_item_id = VALUES(square_item_id),
        name = VALUES(name),
        sku = VALUES(sku),
        pricing_type = VALUES(pricing_type),
        price_amount = VALUES(price_amount),
        currency = VALUES(currency),
        version = VALUES(version),
        updated_at_remote = VALUES(updated_at_remote),
        is_deleted = VALUES(is_deleted),
        present_at_all_locations = VALUES(present_at_all_locations),
        raw_json = VALUES(raw_json),
        updated_at = VALUES(updated_at),
        last_synced_at = VALUES(last_synced_at)
    `,
    [
      variation.id,
      data.item_id || fallbackItemId,
      data.name || "",
      data.sku || null,
      data.pricing_type || null,
      Number.isFinite(Number(priceMoney.amount)) ? Number(priceMoney.amount) : null,
      priceMoney.currency || null,
      variation.version === null || typeof variation.version === "undefined"
        ? null
        : String(variation.version),
      toDate(variation.updated_at),
      toTinyInt(Boolean(variation.is_deleted)),
      toTinyInt(variation.present_at_all_locations),
      jsonString(variation),
      now,
      now,
      syncAt
    ]
  );
}

async function upsertReturnedSquareObjects(connection, objects, syncAt = new Date()) {
  for (const object of objects || []) {
    if (object?.type === "ITEM") {
      await upsertSquareItem(connection, object, syncAt);
      for (const variation of object.item_data?.variations || []) {
        await upsertSquareVariation(connection, variation, object.id, syncAt);
      }
    } else if (object?.type === "ITEM_VARIATION") {
      await upsertSquareVariation(connection, object, object.item_variation_data?.item_id, syncAt);
    }
  }
}

export async function syncSquareCatalogCache({ userId = null } = {}) {
  await ensureSquareSyncSchema();
  const connection = await getPool().getConnection();
  let runId = null;
  try {
    runId = await startSquareRun(connection, "cache-sync", userId);
  } finally {
    connection.release();
  }

  let nextConnection = null;
  try {
    const items = await listSquareCatalogItems();
    const syncAt = databaseTimestampNow();
    let variationCount = 0;

    nextConnection = await getPool().getConnection();
    await nextConnection.beginTransaction();
    for (const item of items) {
      await upsertSquareItem(nextConnection, item, syncAt);
      const variations = Array.isArray(item.item_data?.variations) ? item.item_data.variations : [];
      variationCount += variations.length;
      for (const variation of variations) {
        await upsertSquareVariation(nextConnection, variation, item.id, syncAt);
      }
    }

    await nextConnection.query(
      "UPDATE square_catalog_items SET is_deleted = 1, updated_at = ? WHERE last_synced_at IS NULL OR last_synced_at < ?",
      [new Date(), syncAt]
    );
    await nextConnection.query(
      "UPDATE square_catalog_variations SET is_deleted = 1, updated_at = ? WHERE last_synced_at IS NULL OR last_synced_at < ?",
      [new Date(), syncAt]
    );

    const summary = {
      items: items.length,
      variations: variationCount,
      syncedAt: syncAt
    };
    await finishSquareRun(nextConnection, runId, "complete", summary);
    await nextConnection.commit();
    return { ok: true, runId, summary };
  } catch (error) {
    if (nextConnection) {
      await nextConnection.rollback().catch(() => {});
      await finishSquareRun(nextConnection, runId, "failed", {}, error?.message || "Square sync failed").catch(() => {});
    } else {
      const failConnection = await getPool().getConnection();
      await finishSquareRun(failConnection, runId, "failed", {}, error?.message || "Square sync failed").catch(() => {});
      failConnection.release();
    }
    throw error;
  } finally {
    if (nextConnection) nextConnection.release();
  }
}

export async function getSquareStatus() {
  await ensureSquareSyncSchema();
  const config = getSquareConfig();
  const pool = getPool();
  const [[itemCountRow]] = await pool.query(
    "SELECT COUNT(*) AS total FROM square_catalog_items WHERE COALESCE(is_deleted, 0) = 0"
  );
  const [[variationCountRow]] = await pool.query(
    "SELECT COUNT(*) AS total FROM square_catalog_variations WHERE COALESCE(is_deleted, 0) = 0"
  );
  const [[linkCountRow]] = await pool.query(
    "SELECT COUNT(*) AS total FROM square_variation_links"
  );
  const [runRows] = await pool.query(
    `
      SELECT
        id,
        mode,
        status,
        started_at AS startedAt,
        finished_at AS finishedAt,
        summary_json AS summaryJson,
        error_message AS errorMessage
      FROM square_sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT 5
    `
  );

  return {
    enabled: isSquareEnabled(),
    environment: config.environment,
    apiVersion: config.apiVersion,
    locationConfigured: Boolean(config.locationId),
    currency: config.currency,
    counts: {
      items: Number(itemCountRow?.total || 0),
      variations: Number(variationCountRow?.total || 0),
      links: Number(linkCountRow?.total || 0)
    },
    latestRuns: runRows.map((row) => ({
      ...row,
      summary: parseJson(row.summaryJson)
    }))
  };
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token && !COMMON_NAME_TOKENS.has(token));
}

function tokenScore(left, right) {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function containsScore(left, right) {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.78;
  return 0;
}

function scoreSquareCandidate(localPackage, squareVariation) {
  const localFull = `${localPackage.productName || ""} ${localPackage.packageName || ""}`;
  const squareFull = `${squareVariation.itemName || ""} ${squareVariation.name || ""} ${squareVariation.sku || ""}`;
  const productScore = Math.max(
    tokenScore(localPackage.productName, squareVariation.itemName),
    containsScore(localPackage.productName, squareVariation.itemName)
  );
  const packageScore = Math.max(
    tokenScore(localPackage.packageName, squareVariation.name),
    containsScore(localPackage.packageName, squareVariation.name)
  );
  const fullScore = Math.max(tokenScore(localFull, squareFull), containsScore(localFull, squareFull));
  const skuScore =
    localPackage.packageCode && squareVariation.sku
      ? Math.max(
          containsScore(localPackage.packageCode, squareVariation.sku),
          tokenScore(localPackage.packageCode, squareVariation.sku)
        )
      : 0;

  const score = Math.min(
    1,
    fullScore * 0.52 + productScore * 0.28 + packageScore * 0.15 + skuScore * 0.18
  );
  return Number(score.toFixed(4));
}

async function loadLocalPackagesForSquare() {
  const [rows] = await getPool().query(
    `
      SELECT
        p.id AS productId,
        p.name AS productName,
        p.visible AS productVisible,
        p.category_id AS categoryId,
        p.vendor_id AS vendorId,
        c.name AS categoryName,
        v.name AS vendorName,
        pkg.id AS packageId,
        pkg.name AS packageName,
        pkg.package_code AS packageCode,
        pkg.visible AS packageVisible
      FROM packages pkg
      JOIN products p ON p.id = pkg.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE COALESCE(p.is_deleted, 0) = 0
        AND (c.name IS NULL OR LOWER(TRIM(c.name)) <> 'membership')
      ORDER BY p.name ASC, pkg.name ASC, pkg.id ASC
    `
  );
  return rows;
}

async function loadSquareVariationsForReview() {
  const [rows] = await getPool().query(
    `
      SELECT
        sv.square_variation_id AS squareVariationId,
        sv.square_item_id AS squareItemId,
        sv.name,
        sv.sku,
        sv.pricing_type AS pricingType,
        sv.price_amount AS priceAmount,
        sv.currency,
        sv.version,
        si.name AS itemName,
        si.is_deleted AS itemDeleted,
        sv.is_deleted AS variationDeleted
      FROM square_catalog_variations sv
      JOIN square_catalog_items si ON si.square_item_id = sv.square_item_id
      WHERE COALESCE(sv.is_deleted, 0) = 0
        AND COALESCE(si.is_deleted, 0) = 0
      ORDER BY si.name ASC, sv.name ASC
    `
  );
  return rows;
}

async function loadSquareLinks() {
  const [rows] = await getPool().query(
    `
      SELECT
        id,
        product_id AS productId,
        package_id AS packageId,
        square_item_id AS squareItemId,
        square_variation_id AS squareVariationId,
        match_score AS matchScore,
        match_notes AS matchNotes,
        approved_by_user_id AS approvedByUserId,
        approved_at AS approvedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM square_variation_links
    `
  );
  return rows;
}

export async function buildSquareMatchReview({ limitCandidates = 5 } = {}) {
  await ensureSquareSyncSchema();
  const [localPackages, squareVariations, links] = await Promise.all([
    loadLocalPackagesForSquare(),
    loadSquareVariationsForReview(),
    loadSquareLinks()
  ]);
  const linkByPackageId = new Map(links.map((link) => [Number(link.packageId), link]));
  const linkByVariationId = new Map(links.map((link) => [String(link.squareVariationId), link]));
  const variationById = new Map(squareVariations.map((variation) => [variation.squareVariationId, variation]));

  const rows = localPackages.map((localPackage) => {
    const link = linkByPackageId.get(Number(localPackage.packageId)) || null;
    const linkedVariation = link ? variationById.get(link.squareVariationId) || null : null;
    const candidates = squareVariations
      .filter((variation) => {
        const variationLink = linkByVariationId.get(String(variation.squareVariationId));
        return !variationLink || Number(variationLink.packageId) === Number(localPackage.packageId);
      })
      .map((variation) => ({
        squareItemId: variation.squareItemId,
        squareVariationId: variation.squareVariationId,
        itemName: variation.itemName || "",
        variationName: variation.name || "",
        sku: variation.sku || "",
        priceAmount: toNumber(variation.priceAmount),
        currency: variation.currency || null,
        pricingType: variation.pricingType || "",
        score: scoreSquareCandidate(localPackage, variation)
      }))
      .filter((candidate) => candidate.score >= 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, limitCandidates);

    return {
      productId: Number(localPackage.productId),
      productName: localPackage.productName || "",
      packageId: Number(localPackage.packageId),
      packageName: localPackage.packageName || "",
      packageCode: localPackage.packageCode || "",
      categoryName: localPackage.categoryName || "",
      vendorName: localPackage.vendorName || "",
      linked: link
        ? {
            id: Number(link.id),
            squareItemId: link.squareItemId,
            squareVariationId: link.squareVariationId,
            itemName: linkedVariation?.itemName || "",
            variationName: linkedVariation?.name || "",
            sku: linkedVariation?.sku || "",
            priceAmount: toNumber(linkedVariation?.priceAmount),
            currency: linkedVariation?.currency || null,
            pricingType: linkedVariation?.pricingType || "",
            matchScore: toNumber(link.matchScore),
            approvedAt: link.approvedAt
          }
        : null,
      candidates
    };
  });

  return {
    rows,
    summary: {
      localPackages: rows.length,
      linked: rows.filter((row) => row.linked).length,
      unmatched: rows.filter((row) => !row.linked).length,
      squareVariations: squareVariations.length
    }
  };
}

export async function approveSquareVariationLink({
  productId,
  packageId,
  squareItemId,
  squareVariationId,
  matchScore = null,
  userId = null
}) {
  await ensureSquareSyncSchema();
  const pool = getPool();
  const [[packageRow]] = await pool.query(
    "SELECT id, product_id AS productId FROM packages WHERE id = ? AND product_id = ? LIMIT 1",
    [packageId, productId]
  );
  if (!packageRow) {
    throw new Error("Local package not found for this product.");
  }

  const [[variationRow]] = await pool.query(
    `
      SELECT
        sv.square_variation_id AS squareVariationId,
        sv.square_item_id AS squareItemId
      FROM square_catalog_variations sv
      WHERE sv.square_variation_id = ?
        AND sv.square_item_id = ?
        AND COALESCE(sv.is_deleted, 0) = 0
      LIMIT 1
    `,
    [squareVariationId, squareItemId]
  );
  if (!variationRow) {
    throw new Error("Square variation not found in the cached catalog.");
  }

  const [[existingVariationLink]] = await pool.query(
    `
      SELECT package_id AS packageId
      FROM square_variation_links
      WHERE square_variation_id = ?
        AND package_id <> ?
      LIMIT 1
    `,
    [squareVariationId, packageId]
  );
  if (existingVariationLink) {
    throw new Error("That Square variation is already linked to another package.");
  }

  const now = new Date();
  await pool.query(
    `
      INSERT INTO square_variation_links (
        product_id,
        package_id,
        square_item_id,
        square_variation_id,
        match_score,
        approved_by_user_id,
        approved_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        product_id = VALUES(product_id),
        square_item_id = VALUES(square_item_id),
        square_variation_id = VALUES(square_variation_id),
        match_score = VALUES(match_score),
        approved_by_user_id = VALUES(approved_by_user_id),
        approved_at = VALUES(approved_at),
        updated_at = VALUES(updated_at)
    `,
    [
      productId,
      packageId,
      squareItemId,
      squareVariationId,
      toNumber(matchScore),
      userId || null,
      now,
      now,
      now
    ]
  );

  return { ok: true };
}

export async function unlinkSquareVariation({ packageId, squareVariationId }) {
  await ensureSquareSyncSchema();
  if (!packageId && !squareVariationId) {
    throw new Error("Package id or Square variation id is required.");
  }

  if (packageId) {
    await getPool().query("DELETE FROM square_variation_links WHERE package_id = ?", [packageId]);
    return { ok: true };
  }

  await getPool().query("DELETE FROM square_variation_links WHERE square_variation_id = ?", [
    squareVariationId
  ]);
  return { ok: true };
}

async function loadApprovedSquarePricingRows(packageIds = []) {
  const params = [];
  let packageFilter = "";
  if (packageIds.length) {
    packageFilter = `AND l.package_id IN (${placeholders(packageIds)})`;
    params.push(...packageIds);
  }

  const [rows] = await getPool().query(
    `
      SELECT
        l.id AS linkId,
        l.product_id AS productId,
        l.package_id AS packageId,
        l.square_item_id AS squareItemId,
        l.square_variation_id AS squareVariationId,
        p.name AS productName,
        p.description AS productDescription,
        p.visible AS productVisible,
        p.track_inventory AS productTrackInventory,
        p.inventory AS productInventory,
        p.vendor_id AS vendorId,
        c.name AS categoryName,
        v.name AS vendorName,
        v.price_list_markup AS vendorPriceListMarkup,
        v.source_multiplier AS vendorSourceMultiplier,
        v.guest_markup AS vendorGuestMarkup,
        v.member_markup AS vendorMemberMarkup,
        pp.unit_of_measure AS unitOfMeasure,
        pp.source_unit_price AS sourceUnitPrice,
        pp.min_weight AS minWeight,
        pp.max_weight AS maxWeight,
        pp.avg_weight_override AS avgWeightOverride,
        pp.source_multiplier AS sourceMultiplier,
        pp.guest_markup AS guestMarkup,
        pp.member_markup AS memberMarkup,
        pp.herd_share_markup AS herdShareMarkup,
        pp.snap_markup AS snapMarkup,
        pp.on_sale AS profileOnSale,
        pp.sale_discount AS profileSaleDiscount,
        ps.on_sale AS saleOnSale,
        ps.sale_discount AS saleSaleDiscount,
        si.name AS squareItemName,
        sv.name AS squareVariationName,
        sv.sku AS squareSku,
        sv.pricing_type AS squarePricingType,
        sv.price_amount AS squarePriceAmount,
        sv.currency AS squareCurrency,
        sv.version AS squareVersion,
        sv.raw_json AS squareRawJson
      FROM square_variation_links l
      JOIN products p ON p.id = l.product_id
      JOIN packages pkg ON pkg.id = l.package_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN product_pricing_profiles pp ON pp.product_id = p.id
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      LEFT JOIN square_catalog_items si ON si.square_item_id = l.square_item_id
      LEFT JOIN square_catalog_variations sv ON sv.square_variation_id = l.square_variation_id
      WHERE COALESCE(p.is_deleted, 0) = 0
        AND (c.name IS NULL OR LOWER(TRIM(c.name)) <> 'membership')
        ${packageFilter}
      ORDER BY p.name ASC, pkg.name ASC
    `,
    params
  );

  return rows;
}

async function loadPackagesByProduct(productIds) {
  if (!productIds.length) return { packagesByProductId: new Map(), metaByPackageId: new Map() };
  const [packageRows] = await getPool().query(
    `
      SELECT
        id,
        product_id AS productId,
        name,
        price,
        package_code AS packageCode,
        unit,
        num_of_items AS numOfItems,
        track_type AS trackType,
        charge_type AS chargeType,
        visible,
        track_inventory AS trackInventory,
        inventory
      FROM packages
      WHERE product_id IN (${placeholders(productIds)})
    `,
    productIds
  );
  const [metaRows] = await getPool().query(
    `
      SELECT
        package_id AS packageId,
        product_id AS productId,
        avg_package_weight AS avgPackageWeight,
        num_of_items AS numOfItems,
        package_code AS packageCode,
        raw_json AS rawJson
      FROM local_line_package_meta
      WHERE product_id IN (${placeholders(productIds)})
    `,
    productIds
  ).catch(() => [[]]);

  const packagesByProductId = new Map();
  for (const row of packageRows) {
    const productId = Number(row.productId);
    if (!packagesByProductId.has(productId)) packagesByProductId.set(productId, []);
    packagesByProductId.get(productId).push(row);
  }

  const metaByPackageId = new Map(metaRows.map((row) => [Number(row.packageId), row]));
  return { packagesByProductId, metaByPackageId };
}

function buildVendorFromPricingRow(row) {
  return {
    id: row.vendorId,
    name: row.vendorName,
    priceListMarkup: row.vendorPriceListMarkup,
    sourceMultiplier: row.vendorSourceMultiplier,
    guestMarkup: row.vendorGuestMarkup,
    memberMarkup: row.vendorMemberMarkup
  };
}

function buildProfileFromPricingRow(row) {
  const saleOnSale =
    row.saleOnSale === null || typeof row.saleOnSale === "undefined"
      ? row.profileOnSale
      : row.saleOnSale;
  const saleDiscount =
    row.saleSaleDiscount === null || typeof row.saleSaleDiscount === "undefined"
      ? row.profileSaleDiscount
      : row.saleSaleDiscount;

  return {
    productId: row.productId,
    unitOfMeasure: row.unitOfMeasure,
    sourceUnitPrice: row.sourceUnitPrice,
    minWeight: row.minWeight,
    maxWeight: row.maxWeight,
    avgWeightOverride: row.avgWeightOverride,
    sourceMultiplier: row.sourceMultiplier,
    guestMarkup: row.guestMarkup,
    memberMarkup: row.memberMarkup,
    herdShareMarkup: row.herdShareMarkup,
    snapMarkup: row.snapMarkup,
    onSale: saleOnSale ?? 0,
    saleDiscount: saleDiscount ?? 0
  };
}

function buildProductFromPricingRow(row) {
  return {
    id: row.productId,
    name: row.productName,
    description: row.productDescription,
    visible: row.productVisible,
    trackInventory: row.productTrackInventory,
    inventory: row.productInventory,
    vendorId: row.vendorId
  };
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function computeSquareRetailPackagePrice(profile, pkg) {
  const saleDiscount =
    profile?.onSale
      ? Math.max(0, Math.min(toNumber(profile?.saleDiscount) ?? 0, 1))
      : 0;

  if (!profile?.usesSourcePricing) {
    const regularPrice = toNumber(pkg?.price);
    return {
      price:
        regularPrice !== null
          ? roundCurrency(regularPrice * (1 - saleDiscount))
          : null,
      regularPrice,
      basis: "local-package-price"
    };
  }

  const sourceUnitPrice = toNumber(profile?.sourceUnitPrice);
  if (sourceUnitPrice === null) {
    return {
      price: null,
      regularPrice: null,
      basis: "vendor-retail-price"
    };
  }

  const regularPrice = roundCurrency(sourceUnitPrice);

  return {
    price:
      regularPrice !== null
        ? roundCurrency(regularPrice * (1 - saleDiscount))
        : null,
    regularPrice,
    basis: "vendor-retail-price"
  };
}

function buildSquarePriceAuditRow(row, packagesByProductId, metaByPackageId) {
  const productPackages = packagesByProductId.get(Number(row.productId)) || [];
  const packageMetaByPackageId = new Map(
    productPackages.map((pkg) => [
      Number(pkg.id),
      metaByPackageId.get(Number(pkg.id)) || null
    ])
  );
  const targetPackage = productPackages.find((pkg) => Number(pkg.id) === Number(row.packageId));
  const issues = [];

  if (!targetPackage) {
    issues.push("Local package was not found.");
  }
  if (!row.squareVariationId || !row.squarePricingType) {
    issues.push("Linked Square variation was not found in the cache.");
  }
  if (row.squarePricingType && row.squarePricingType !== "FIXED_PRICING") {
    issues.push("Square variation is not fixed-price.");
  }

  const resolvedProfile = resolvePricingProfile({
    profile: buildProfileFromPricingRow(row),
    product: buildProductFromPricingRow(row),
    packages: productPackages,
    packageMetaByPackageId,
    vendor: buildVendorFromPricingRow(row)
  });
  const squareRetail = targetPackage
    ? computeSquareRetailPackagePrice(
        {
          ...resolvedProfile,
          saleDiscount: getCustomerFacingSaleDiscount(resolvedProfile)
        },
        targetPackage
      )
    : { price: null, regularPrice: null, basis: "unknown" };
  const proposedAmount = dollarsToCents(squareRetail.price);
  if (!Number.isFinite(Number(proposedAmount))) {
    issues.push("CSA Store price for Square could not be calculated.");
  }

  const currency = normalizeCurrency(row.squareCurrency || configuredCurrency());
  if (currency !== configuredCurrency()) {
    issues.push(`Square currency ${currency} does not match configured ${configuredCurrency()}.`);
  }

  const remoteAmount = toNumber(row.squarePriceAmount);
  const changed =
    !issues.length &&
    Number.isFinite(Number(proposedAmount)) &&
    Number(remoteAmount) !== Number(proposedAmount);

  return {
    productId: Number(row.productId),
    productName: row.productName || "",
    packageId: Number(row.packageId),
    packageName: targetPackage?.name || "",
    squareItemId: row.squareItemId,
    squareVariationId: row.squareVariationId,
    squareItemName: row.squareItemName || "",
    squareVariationName: row.squareVariationName || "",
    squareSku: row.squareSku || "",
    pricingType: row.squarePricingType || "",
    remoteAmount,
    remotePrice: centsToDollars(remoteAmount),
    proposedAmount,
    proposedPrice: centsToDollars(proposedAmount),
    regularPrice: squareRetail.regularPrice,
    priceBasis: squareRetail.basis,
    saleApplied: Boolean(resolvedProfile.onSale) && Number(resolvedProfile.saleDiscount || 0) > 0,
    currency,
    status: issues.length ? "blocked" : changed ? "changed" : "synced",
    issues,
    message: issues.join(" "),
    squareVersion: row.squareVersion || null,
    squareRawJson: row.squareRawJson || null
  };
}

async function buildSquarePriceAuditRows(packageIds = []) {
  const rows = await loadApprovedSquarePricingRows(packageIds);
  const productIds = [...new Set(rows.map((row) => Number(row.productId)).filter(Number.isFinite))];
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct(productIds);
  return rows.map((row) => buildSquarePriceAuditRow(row, packagesByProductId, metaByPackageId));
}

export async function auditSquarePrices({ packageIds = [], userId = null, persist = true } = {}) {
  await ensureSquareSyncSchema();
  const cleanPackageIds = [...new Set(
    (Array.isArray(packageIds) ? packageIds : [])
      .map((value) => Number(value))
      .filter(Number.isFinite)
  )];
  const rows = await buildSquarePriceAuditRows(cleanPackageIds);
  const summary = {
    total: rows.length,
    changed: rows.filter((row) => row.status === "changed").length,
    synced: rows.filter((row) => row.status === "synced").length,
    blocked: rows.filter((row) => row.status === "blocked").length
  };

  if (!persist) return { rows, summary, runId: null };

  const connection = await getPool().getConnection();
  const runId = await startSquareRun(connection, "audit-prices", userId);
  try {
    for (const row of rows) {
      await insertSquareResult(connection, runId, {
        ...row,
        action: "audit",
        localPriceAmount: row.proposedAmount,
        remotePriceAmount: row.remoteAmount,
        message: row.message || row.status,
        raw: row
      });
    }
    await finishSquareRun(connection, runId, "complete", summary);
    return { rows, summary, runId };
  } catch (error) {
    await finishSquareRun(connection, runId, "failed", summary, error?.message || "Square audit failed").catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function buildVariationUpdateObject(latestVariation, proposedAmount, currency) {
  const nextObject = JSON.parse(JSON.stringify(latestVariation));
  if (nextObject.type !== "ITEM_VARIATION") {
    throw new Error("Square object is not an item variation.");
  }
  if (nextObject.is_deleted) {
    throw new Error("Square variation is deleted.");
  }
  if (!nextObject.version) {
    throw new Error("Square variation is missing a version.");
  }
  if (!nextObject.item_variation_data?.item_id) {
    throw new Error("Square variation is missing an item id.");
  }
  if (nextObject.item_variation_data.pricing_type !== "FIXED_PRICING") {
    throw new Error("Square variation is not fixed-price.");
  }

  nextObject.item_variation_data.price_money = {
    amount: proposedAmount,
    currency
  };
  return nextObject;
}

export async function applySquarePrices({ packageIds = [], userId = null } = {}) {
  await ensureSquareSyncSchema();
  if (!isSquareEnabled()) {
    throw new Error("Square access token is not configured.");
  }

  const audit = await auditSquarePrices({ packageIds, userId, persist: false });
  const targets = audit.rows.filter((row) => row.status === "changed");
  const connection = await getPool().getConnection();
  let runId = null;
  try {
    runId = await startSquareRun(connection, "apply-prices", userId);
  } finally {
    connection.release();
  }

  const resultRows = [];
  let nextConnection = null;
  try {
    const latestObjects = await batchRetrieveSquareObjects(
      targets.map((row) => row.squareVariationId).filter(Boolean)
    );
    const latestById = new Map(latestObjects.map((object) => [object.id, object]));
    const updates = [];

    for (const row of targets) {
      try {
        const latest = latestById.get(row.squareVariationId);
        if (!latest) throw new Error("Square variation was not returned by Square.");
        const updateObject = buildVariationUpdateObject(latest, row.proposedAmount, row.currency);
        updates.push({ row, updateObject });
      } catch (error) {
        resultRows.push({
          ...row,
          action: "apply",
          status: "failed",
          message: error?.message || "Unable to prepare Square update."
        });
      }
    }

    if (updates.length) {
      try {
        const response = await batchUpsertSquareObjects(updates.map((entry) => entry.updateObject));
        const updatedIds = new Set((response.objects || []).map((object) => object.id));
        nextConnection = await getPool().getConnection();
        await nextConnection.beginTransaction();
        await upsertReturnedSquareObjects(nextConnection, response.objects || [], new Date());
        await nextConnection.commit();
        nextConnection.release();
        nextConnection = null;

        for (const entry of updates) {
          resultRows.push({
            ...entry.row,
            action: "apply",
            status: updatedIds.has(entry.row.squareVariationId) ? "updated" : "submitted",
            message: "Square price updated."
          });
        }
      } catch (error) {
        for (const entry of updates) {
          resultRows.push({
            ...entry.row,
            action: "apply",
            status: "failed",
            message: error?.message || "Square update failed."
          });
        }
      }
    }

    for (const row of audit.rows.filter((row) => row.status !== "changed")) {
      resultRows.push({
        ...row,
        action: "apply",
        status: row.status === "synced" ? "skipped" : "blocked",
        message: row.message || (row.status === "synced" ? "Already synced." : "Blocked.")
      });
    }

    const finalConnection = await getPool().getConnection();
    const summary = {
      total: resultRows.length,
      requestedUpdates: targets.length,
      updated: resultRows.filter((row) => row.status === "updated" || row.status === "submitted").length,
      failed: resultRows.filter((row) => row.status === "failed").length,
      blocked: resultRows.filter((row) => row.status === "blocked").length,
      skipped: resultRows.filter((row) => row.status === "skipped").length
    };
    try {
      for (const row of resultRows) {
        await insertSquareResult(finalConnection, runId, {
          ...row,
          localPriceAmount: row.proposedAmount,
          remotePriceAmount: row.remoteAmount,
          raw: row
        });
      }
      await finishSquareRun(finalConnection, runId, summary.failed ? "partial" : "complete", summary);
    } finally {
      finalConnection.release();
    }

    return {
      rows: resultRows,
      summary,
      runId
    };
  } catch (error) {
    const failConnection = await getPool().getConnection();
    await finishSquareRun(failConnection, runId, "failed", {}, error?.message || "Square apply failed").catch(() => {});
    failConnection.release();
    throw error;
  } finally {
    if (nextConnection) {
      await nextConnection.rollback().catch(() => {});
      nextConnection.release();
    }
  }
}
