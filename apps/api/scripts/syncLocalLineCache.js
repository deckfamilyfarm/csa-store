import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ensureLocalLineSyncSchema } from "../db.js";

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

function resolveFromRepoRoot(targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(repoRoot, targetPath);
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/?$/, "/");
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildProductExportHash(exportProduct, exportPackages) {
  const packagePayload = [...exportPackages]
    .sort((left, right) => Number(left.packageId) - Number(right.packageId))
    .map((pkg) => pkg.raw);
  return sha256(
    JSON.stringify({
      product: exportProduct.raw,
      packages: packagePayload
    })
  );
}

function buildLiveHash(body) {
  if (!body) return null;
  return sha256(JSON.stringify(body));
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildMediaRowKey(row) {
  if (row.sourceMediaId !== null && typeof row.sourceMediaId !== "undefined" && row.sourceMediaId !== "") {
    return String(row.sourceMediaId);
  }
  return normalizeWhitespace(row.remoteUrl || row.sourceUrl || "");
}

function parseYesNo(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeWhitespace(value).toUpperCase();
  if (normalized === "Y" || normalized === "YES" || normalized === "TRUE") return true;
  if (normalized === "N" || normalized === "NO" || normalized === "FALSE") return false;
  return null;
}

function parseNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeContentType(value) {
  return normalizeWhitespace(value).toLowerCase() || "application/octet-stream";
}

function extensionFromContentType(contentType) {
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("svg")) return "svg";
  return "bin";
}

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

function canMirrorImages() {
  return Boolean(
    process.env.DO_SPACES_BUCKET &&
      process.env.DO_SPACES_ENDPOINT &&
      process.env.DO_SPACES_KEY &&
      process.env.DO_SPACES_SECRET
  );
}

function createSpacesClient() {
  if (!canMirrorImages()) return null;
  return new S3Client({
    region: process.env.DO_SPACES_REGION || "sfo3",
    endpoint: process.env.DO_SPACES_ENDPOINT,
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET
    }
  });
}

function mapWithConcurrency(values, concurrency, mapper, onProgress) {
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

  return Promise.all(
    Array.from({ length: Math.min(concurrency, values.length || 1) }, () => worker())
  ).then(() => results);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Number.isFinite(retryOptions.attempts) ? retryOptions.attempts : 4;
  const baseDelayMs = Number.isFinite(retryOptions.baseDelayMs) ? retryOptions.baseDelayMs : 750;
  const timeoutMs = Number.isFinite(retryOptions.timeoutMs) ? retryOptions.timeoutMs : 30000;
  const label = retryOptions.label || "Request";
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) return response;

      if (!retryableStatuses.has(response.status) || attempt === attempts) {
        return response;
      }

      const detail = await response.text().catch(() => "");
      lastError = new Error(`${label} retryable error: ${response.status} ${detail}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }

    await sleep(baseDelayMs * attempt);
  }

  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`);
}

function chunk(rows, size = 100) {
  const items = [];
  for (let index = 0; index < rows.length; index += size) {
    items.push(rows.slice(index, index + size));
  }
  return items;
}

function buildBatchPlaceholders(rowCount, columnCount) {
  return Array.from({ length: rowCount }, () => `(${Array(columnCount).fill("?").join(", ")})`).join(", ");
}

function computeDerivedSaleDiscount(finalPrice, strikethroughDisplayValue) {
  const finalValue = toNumber(finalPrice);
  const strikeValue = toNumber(strikethroughDisplayValue);
  if (!Number.isFinite(finalValue) || !Number.isFinite(strikeValue) || strikeValue <= finalValue || strikeValue <= 0) {
    return null;
  }
  return Number(((strikeValue - finalValue) / strikeValue).toFixed(4));
}

function isRealLocalLineSale(row) {
  const derivedDiscount = computeDerivedSaleDiscount(
    row.finalPriceCache,
    row.strikethroughDisplayValue
  );
  return Boolean(row.onSaleToggle) || (Number.isFinite(derivedDiscount) && derivedDiscount > 0);
}

function buildConfiguredPriceListsFromEnv() {
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

  return entries.filter((entry) => Number.isFinite(entry.id)).map((entry) => ({
    localLinePriceListId: entry.id,
    name: entry.key,
    active: 1,
    source: "localline"
  }));
}

async function getLocalLineAccessToken(baseUrl) {
  const response = await fetchWithRetry(`${baseUrl}token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.LL_USERNAME,
      password: process.env.LL_PASSWORD
    })
  }, {
    label: "Local Line token request",
    timeoutMs: 15000
  });

  if (!response.ok) {
    throw new Error(`Local Line token error: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return payload?.access || payload?.token || payload;
}

async function downloadLocalLineExport(baseUrl, token) {
  const response = await fetchWithRetry(`${baseUrl}products/export/?direct=true`, {
    headers: { Authorization: `Bearer ${token}` }
  }, {
    label: "Local Line products export",
    timeoutMs: 120000
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
  const packagesById = new Map();

  for (const row of availabilityRows) {
    const productId = Number(row["Local Line Product ID"]);
    if (!Number.isFinite(productId)) continue;

    productsById.set(productId, {
      productId,
      internalId: row["Internal ID"] ?? null,
      name: row.Product ?? null,
      vendor: row.Vendor ?? null,
      status: row.Status ?? null,
      visible: parseYesNo(row.Visible),
      description: row.Description ?? null,
      trackInventoryBy: row["Track Inventory By"] ?? null,
      inventoryType: row["Inventory Type"] ?? null,
      productInventory: toNumber(row["Product Inventory"]),
      reservedInventory: toNumber(row["Reserved Inventory"]),
      availableInventory: toNumber(row["Available Inventory"]),
      packageCodesEnabled: parseYesNo(row["Package Codes Enabled"]),
      ownershipType: row["Ownership Type"] ?? null,
      packingTag: row["Packing Tag"] ?? null,
      raw: row
    });
  }

  for (const row of packageRows) {
    const productId = Number(row["Local Line Product ID"]);
    const packageId = Number(row["Package ID"]);
    if (!Number.isFinite(productId) || !Number.isFinite(packageId)) continue;

    const packageRecord = {
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
      numOfItems: toNumber(row["# of Items"]),
      raw: row
    };

    const list = packagesByProductId.get(productId) || [];
    list.push(packageRecord);
    packagesByProductId.set(productId, list);
    packagesById.set(packageId, packageRecord);
  }

  return {
    productCount: productsById.size,
    packageCount: packageRows.length,
    productsById,
    packagesByProductId,
    packagesById
  };
}

async function fetchLocalLineProductDetail(baseUrl, token, productId) {
  const response = await fetchWithRetry(`${baseUrl}products/${productId}/?expand=packages,product_price_list_entries`, {
    headers: { Authorization: `Bearer ${token}` }
  }, {
    label: `Local Line product ${productId}`,
    timeoutMs: 30000
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

function computeActualFinalPrice(basePrice, entry) {
  const safeBase = toNumber(basePrice);
  if (safeBase === null) return null;
  if (!entry?.adjustment) return safeBase;

  const adjustmentValue = toNumber(entry.adjustment_value);
  if (adjustmentValue === null) return null;

  if (Number(entry.adjustment_type) === 1) {
    return roundCurrency(safeBase + adjustmentValue);
  }

  if (Number(entry.adjustment_type) === 2) {
    return roundCurrency(safeBase * (1 + adjustmentValue / 100));
  }

  if (Number(entry.adjustment_type) === 3) {
    return roundCurrency(adjustmentValue);
  }

  return null;
}

function getEntryPriceListId(entry) {
  const id = Number(entry?.price_list_id ?? entry?.price_list);
  return Number.isFinite(id) ? id : null;
}

function getEntryPriceListName(entry) {
  return (
    normalizeWhitespace(
      entry?.price_list_name ??
      entry?.name ??
      entry?.price_list_label ??
      entry?.label ??
      ""
    ) || null
  );
}

function collectPriceListDefinitions(liveDetails) {
  const definitions = new Map(
    buildConfiguredPriceListsFromEnv().map((item) => [item.localLinePriceListId, item])
  );

  for (const detail of liveDetails) {
    if (!detail?.ok) continue;
    const body = detail.body || {};
    const candidateEntries = [
      ...(Array.isArray(body.product_price_list_entries) ? body.product_price_list_entries : []),
      ...((body.packages || []).flatMap((pkg) => (Array.isArray(pkg.price_list_entries) ? pkg.price_list_entries : [])))
    ];

    for (const entry of candidateEntries) {
      const id = getEntryPriceListId(entry);
      if (!id) continue;
      if (!definitions.has(id)) {
        definitions.set(id, {
          localLinePriceListId: id,
          name: getEntryPriceListName(entry) || `Price List ${id}`,
          active: 1,
          source: "localline"
        });
      } else if (!definitions.get(id).name && getEntryPriceListName(entry)) {
        definitions.set(id, { ...definitions.get(id), name: getEntryPriceListName(entry) });
      }
    }
  }

  return [...definitions.values()].sort((left, right) => left.localLinePriceListId - right.localLinePriceListId);
}

function extractMediaCandidatesFromValue(value, context = {}) {
  const candidates = [];

  const addUrl = (url, extra = {}) => {
    if (typeof url !== "string") return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    candidates.push({
      remoteUrl: trimmed,
      thumbnailUrl: typeof extra.thumbnailUrl === "string" ? extra.thumbnailUrl : null,
      sourceMediaId: extra.sourceMediaId || null,
      sortOrder: extra.sortOrder ?? 0,
      isPrimary: extra.isPrimary ? 1 : 0,
      altText: extra.altText || null
    });
  };

  if (typeof value === "string") {
    addUrl(value, context);
    return candidates;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      candidates.push(
        ...extractMediaCandidatesFromValue(item, {
          ...context,
          sortOrder: context.sortOrder ?? index
        })
      );
    });
    return candidates;
  }

  if (!value || typeof value !== "object") {
    return candidates;
  }

  const primaryUrl =
    value.remote_url ??
    value.remoteUrl ??
    value.public_url ??
    value.publicUrl ??
    value.full_url ??
    value.fullUrl ??
    value.full ??
    value.original_url ??
    value.originalUrl ??
    value.original ??
    value.download_url ??
    value.downloadUrl ??
    value.url ??
    value.image_url ??
    value.imageUrl ??
    value.src;

  addUrl(
    primaryUrl,
    {
      ...context,
      thumbnailUrl:
        value.thumbnail_url ??
        value.thumbnailUrl ??
        value.thumb_url ??
        value.thumbUrl ??
        value.thumbnail ??
        value.thumb ??
        context.thumbnailUrl,
      sourceMediaId: value.id ?? value.media_id ?? value.mediaId ?? context.sourceMediaId,
      altText: value.alt_text ?? value.altText ?? context.altText
    }
  );

  return candidates;
}

function extractProductMediaRows(productId, body) {
  const fields = [
    { key: "image", isPrimary: true },
    { key: "image_url", isPrimary: true },
    { key: "imageUrl", isPrimary: true },
    { key: "photo", isPrimary: true },
    { key: "photo_url", isPrimary: true },
    { key: "photoUrl", isPrimary: true },
    { key: "images" },
    { key: "photos" },
    { key: "media" }
  ];

  const rows = [];
  for (const field of fields) {
    if (typeof body?.[field.key] === "undefined") continue;
    rows.push(
      ...extractMediaCandidatesFromValue(body[field.key], {
        sortOrder: rows.length,
        isPrimary: Boolean(field.isPrimary)
      })
    );
  }

  const deduped = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const key = `${row.remoteUrl}|${row.thumbnailUrl || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push({
      productId,
      source: "localline",
      sourceMediaId: row.sourceMediaId,
      sourceUrl: row.remoteUrl,
      remoteUrl: row.remoteUrl,
      storageKey: null,
      publicUrl: null,
      thumbnailUrl: row.thumbnailUrl,
      sortOrder: index,
      isPrimary: index === 0 ? 1 : row.isPrimary,
      altText: row.altText || null,
      contentHash: null,
      width: null,
      height: null,
      mimeType: null,
      fetchedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSyncedAt: new Date()
    });
  });

  return deduped;
}

async function loadStoreMappings(connection, productIds) {
  if (!productIds.length) {
    return {
      productsById: new Map(),
      packagesByProductId: new Map(),
      localLineProductMetaByProductId: new Map(),
      packageMetaCountByProductId: new Map(),
      priceListEntryCountByProductId: new Map(),
      productMediaByProductId: new Map()
    };
  }

  const [products] = await connection.query(
    `
      SELECT id
      FROM products
      WHERE id IN (?)
    `,
    [productIds]
  );

  const [packages] = await connection.query(
    `
      SELECT id, product_id AS productId
      FROM packages
      WHERE product_id IN (?)
    `,
    [productIds]
  );

  const [productMetaRows] = await connection.query(
    `
      SELECT
        product_id AS productId,
        export_hash AS exportHash,
        live_hash AS liveHash,
        last_live_fetch_status AS lastLiveFetchStatus,
        last_synced_at AS lastSyncedAt,
        updated_at AS updatedAt
      FROM local_line_product_meta
      WHERE product_id IN (?)
    `,
    [productIds]
  );

  const [packageMetaCounts] = await connection.query(
    `
      SELECT product_id AS productId, COUNT(*) AS packageMetaCount
      FROM local_line_package_meta
      WHERE product_id IN (?)
      GROUP BY product_id
    `,
    [productIds]
  );

  const [priceListEntryCounts] = await connection.query(
    `
      SELECT product_id AS productId, COUNT(*) AS priceListEntryCount
      FROM local_line_price_list_entries
      WHERE product_id IN (?)
      GROUP BY product_id
    `,
    [productIds]
  );

  const [productMediaRows] = await connection.query(
    `
      SELECT
        product_id AS productId,
        source AS source,
        source_media_id AS sourceMediaId,
        source_url AS sourceUrl,
        remote_url AS remoteUrl,
        storage_key AS storageKey,
        public_url AS publicUrl,
        thumbnail_url AS thumbnailUrl,
        sort_order AS sortOrder,
        is_primary AS isPrimary,
        alt_text AS altText,
        content_hash AS contentHash,
        width,
        height,
        mime_type AS mimeType,
        fetched_at AS fetchedAt,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM product_media
      WHERE source = 'localline'
        AND product_id IN (?)
    `,
    [productIds]
  );

  return {
    productsById: new Map(products.map((row) => [Number(row.id), row])),
    packagesByProductId: packages.reduce((acc, row) => {
      const list = acc.get(Number(row.productId)) || [];
      list.push({ id: Number(row.id), productId: Number(row.productId) });
      acc.set(Number(row.productId), list);
      return acc;
    }, new Map()),
    localLineProductMetaByProductId: new Map(
      productMetaRows.map((row) => [Number(row.productId), row])
    ),
    packageMetaCountByProductId: new Map(
      packageMetaCounts.map((row) => [Number(row.productId), Number(row.packageMetaCount || 0)])
    ),
    priceListEntryCountByProductId: new Map(
      priceListEntryCounts.map((row) => [Number(row.productId), Number(row.priceListEntryCount || 0)])
    ),
    productMediaByProductId: productMediaRows.reduce((acc, row) => {
      const productId = Number(row.productId);
      const list = acc.get(productId) || [];
      list.push(row);
      acc.set(productId, list);
      return acc;
    }, new Map())
  };
}

function selectProductIdsForSync(exportCatalog, storeMappings, options = {}) {
  const forceFull = Boolean(options.forceFull);
  const liveRefreshHours = Number.isFinite(options.liveRefreshHours) ? options.liveRefreshHours : 6;
  const liveRefreshMs = liveRefreshHours > 0 ? liveRefreshHours * 60 * 60 * 1000 : 0;
  const now = Date.now();
  const limitedProductIds = [...exportCatalog.productsById.keys()].slice(0, options.limit || undefined);
  const exportHashesByProductId = new Map();
  const candidateProductIds = [];
  const skippedProductIds = [];
  const reasonCounts = {};

  for (const productId of limitedProductIds) {
    if (!storeMappings.productsById.has(productId)) {
      continue;
    }

    const exportProduct = exportCatalog.productsById.get(productId);
    const exportPackages = exportCatalog.packagesByProductId.get(productId) || [];
    const exportHash = buildProductExportHash(exportProduct, exportPackages);
    exportHashesByProductId.set(productId, exportHash);

    let reason = "";
    if (forceFull) {
      reason = "force-full";
    } else {
      const existingMeta = storeMappings.localLineProductMetaByProductId.get(productId);
      const packageMetaCount = storeMappings.packageMetaCountByProductId.get(productId) || 0;
      const priceListEntryCount = storeMappings.priceListEntryCountByProductId.get(productId) || 0;
      const productMediaCount = (storeMappings.productMediaByProductId.get(productId) || []).length;
      const lastLiveSyncAt = toTimestamp(existingMeta?.lastSyncedAt || existingMeta?.updatedAt);
      const liveRefreshExpired =
        liveRefreshMs > 0 && (!lastLiveSyncAt || now - lastLiveSyncAt >= liveRefreshMs);

      if (!existingMeta) {
        reason = "missing-product-meta";
      } else if (existingMeta.exportHash !== exportHash) {
        reason = "export-hash-changed";
      } else if (Number(existingMeta.lastLiveFetchStatus || 0) !== 200) {
        reason = "stale-live-fetch-status";
      } else if (liveRefreshExpired) {
        reason = "stale-live-refresh-window";
      } else if (packageMetaCount < exportPackages.length) {
        reason = "missing-package-meta";
      } else if (priceListEntryCount === 0) {
        reason = "missing-price-list-entries";
      } else if (productMediaCount === 0) {
        reason = "missing-product-media";
      }
    }

    if (reason) {
      candidateProductIds.push(productId);
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    } else {
      skippedProductIds.push(productId);
    }
  }

  return {
    totalConsideredProducts: limitedProductIds.length,
    candidateProductIds,
    skippedProductIds,
    exportHashesByProductId,
    reasonCounts,
    forceFull,
    liveRefreshHours
  };
}

function reuseExistingMirroredMedia(row, existingRows = []) {
  const existing = existingRows.find((candidate) => buildMediaRowKey(candidate) === buildMediaRowKey(row));
  if (!existing || !existing.publicUrl || !existing.storageKey || !existing.contentHash) {
    return row;
  }

  return {
    ...row,
    storageKey: existing.storageKey,
    publicUrl: existing.publicUrl,
    thumbnailUrl: existing.thumbnailUrl || row.thumbnailUrl,
    contentHash: existing.contentHash,
    width: existing.width ?? row.width,
    height: existing.height ?? row.height,
    mimeType: existing.mimeType ?? row.mimeType,
    fetchedAt: existing.fetchedAt || row.fetchedAt,
    createdAt: existing.createdAt || row.createdAt,
    updatedAt: row.updatedAt,
    lastSyncedAt: row.lastSyncedAt,
    reusedMirror: true
  };
}

function buildCacheDataset(exportCatalog, liveDetails, storeMappings, options = {}) {
  const now = new Date();
  const priceLists = collectPriceListDefinitions(liveDetails);
  const priceListIdByLocalLineId = new Map();
  const exportHashesByProductId = options.exportHashesByProductId || new Map();
  const guestPriceListId = parseNumber(process.env.LL_PRICE_LIST_GUEST_ID);

  const productMetaRows = [];
  const packageMetaRows = [];
  const packageMemberships = [];
  const productMembershipMap = new Map();
  const priceListEntryRows = [];
  const productMediaRows = [];
  const fetchErrors = [];

  const liveByProductId = new Map(liveDetails.map((detail) => [detail.productId, detail]));

  for (const [productId, exportProduct] of exportCatalog.productsById.entries()) {
    if (!storeMappings.productsById.has(productId)) {
      continue;
    }

    const storePackages = storeMappings.packagesByProductId.get(productId) || [];
    const exportPackages = exportCatalog.packagesByProductId.get(productId) || [];
    const live = liveByProductId.get(productId);

    const productMetaRow = {
      productId,
      localLineProductId: productId,
      internalId: exportProduct.internalId,
      vendorName: exportProduct.vendor,
      status: exportProduct.status,
      visible: exportProduct.visible === null ? null : exportProduct.visible ? 1 : 0,
      trackInventory: exportProduct.productInventory !== null ? 1 : 0,
      trackInventoryBy: exportProduct.trackInventoryBy,
      inventoryType: exportProduct.inventoryType,
      productInventory: exportProduct.productInventory,
      reservedInventory: exportProduct.reservedInventory,
      availableInventory: exportProduct.availableInventory,
      packageCodesEnabled:
        exportProduct.packageCodesEnabled === null ? null : exportProduct.packageCodesEnabled ? 1 : 0,
      ownershipType: exportProduct.ownershipType,
      packingTag: exportProduct.packingTag,
      exportHash: exportHashesByProductId.get(productId) || buildProductExportHash(exportProduct, exportPackages),
      liveHash: live?.ok ? buildLiveHash(live.body) : null,
      lastLiveFetchStatus: live?.ok ? 200 : live?.status ?? null,
      lastLiveFetchError: live?.ok ? null : live?.error ?? "missing",
      rawJson: JSON.stringify({
        export: exportProduct.raw,
        live: live?.ok ? live.body : null
      }),
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now
    };
    productMetaRows.push(productMetaRow);

    const storePackageIdByLocalLinePackageId = new Map(
      storePackages.map((pkg) => [Number(pkg.id), Number(pkg.id)])
    );
    const livePackageById = new Map(
      (live?.ok && Array.isArray(live.body?.packages) ? live.body.packages : [])
        .map((pkg) => [Number(pkg.id), pkg])
    );

    for (const exportPackage of exportPackages) {
      const storePackageId = storePackageIdByLocalLinePackageId.get(exportPackage.packageId);
      if (!storePackageId) continue;
      const livePackage = livePackageById.get(exportPackage.packageId) || null;

      packageMetaRows.push({
        packageId: storePackageId,
        productId,
        localLinePackageId: exportPackage.packageId,
        liveName: livePackage?.name ?? null,
        livePrice: toNumber(livePackage?.package_price ?? livePackage?.unit_price),
        liveVisible:
          typeof livePackage?.visible === "boolean" ? (livePackage.visible ? 1 : 0) : null,
        liveTrackInventory:
          typeof livePackage?.track_inventory === "boolean"
            ? (livePackage.track_inventory ? 1 : 0)
            : null,
        inventoryType: exportPackage.inventoryType,
        packageInventory: exportPackage.packageInventory,
        packageReservedInventory: exportPackage.packageReservedInventory,
        packageAvailableInventory: exportPackage.packageAvailableInventory,
        avgPackageWeight: exportPackage.avgPackageWeight,
        numOfItems: exportPackage.numOfItems,
        packageCode: exportPackage.packageCode,
        rawJson: JSON.stringify({
          export: exportPackage.raw,
          live: livePackage
        }),
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now
      });
    }

    if (!live?.ok) {
      fetchErrors.push({
        severity: "error",
        issueType: "live_fetch_error",
        productId,
        packageId: null,
        priceListId: null,
        detailsJson: JSON.stringify({
          status: live?.status ?? null,
          error: live?.error ?? "missing"
        }),
        createdAt: now,
        updatedAt: now
      });
      continue;
    }

    const body = live.body || {};
    productMediaRows.push(
      ...extractProductMediaRows(productId, body).map((row) =>
        reuseExistingMirroredMedia(row, storeMappings.productMediaByProductId.get(productId) || [])
      )
    );

    const productLevelEntries = Array.isArray(body.product_price_list_entries)
      ? body.product_price_list_entries
      : [];
    const packages = Array.isArray(body.packages) ? body.packages : [];

    for (const livePackage of packages) {
      const storePackageId = storePackageIdByLocalLinePackageId.get(Number(livePackage.id));
      if (!storePackageId) continue;

      const usingPackageEntries =
        Array.isArray(livePackage.price_list_entries) && livePackage.price_list_entries.length > 0;
      const entries = usingPackageEntries ? livePackage.price_list_entries : productLevelEntries;
      const basePrice = toNumber(livePackage.package_price ?? livePackage.unit_price);

      for (const entry of entries) {
        const localLinePriceListId = getEntryPriceListId(entry);
        if (!localLinePriceListId) continue;

        packageMemberships.push({
          packageId: storePackageId,
          localLinePriceListId,
          present: 1,
          adjustmentType: toNumber(entry.adjustment_type),
          adjustmentValue: toNumber(entry.adjustment_value),
          calculatedValue: toNumber(entry.calculated_value),
          basePriceUsed: toNumber(entry.base_price_used),
          finalPriceCache: computeActualFinalPrice(basePrice, entry),
          onSale: entry.on_sale ? 1 : 0,
          onSaleToggle: entry.on_sale_toggle ? 1 : 0,
          strikethroughDisplayValue: toNumber(entry.strikethrough_display_value),
          maxUnitsPerOrder: toNumber(entry.max_units_per_order),
          rawJson: JSON.stringify(entry),
          createdAt: now,
          updatedAt: now,
          lastSyncedAt: now,
          productId
        });

        priceListEntryRows.push({
          productId,
          localLineProductId: productId,
          packageId: storePackageId,
          localLinePackageId: Number(livePackage.id),
          localLinePriceListId,
          entryScope: usingPackageEntries ? "package" : "product",
          sourceEntryId:
            entry?.id === null || typeof entry?.id === "undefined" ? null : String(entry.id),
          priceListName: getEntryPriceListName(entry),
          productName: body.name ?? null,
          packageName: livePackage.name ?? null,
          visible: typeof body.visible === "boolean" ? (body.visible ? 1 : 0) : null,
          trackInventory:
            typeof body.track_inventory === "boolean" ? (body.track_inventory ? 1 : 0) : null,
          packageCode: livePackage.package_code ?? null,
          adjustmentType: toNumber(entry.adjustment_type),
          adjustmentValue: toNumber(entry.adjustment_value),
          calculatedValue: toNumber(entry.calculated_value),
          basePriceUsed: toNumber(entry.base_price_used),
          finalPriceCache: computeActualFinalPrice(basePrice, entry),
          onSale: entry.on_sale ? 1 : 0,
          onSaleToggle: entry.on_sale_toggle ? 1 : 0,
          strikethroughDisplayValue: toNumber(entry.strikethrough_display_value),
          maxUnitsPerOrder: toNumber(entry.max_units_per_order),
          rawJson: JSON.stringify(entry),
          createdAt: now,
          updatedAt: now,
          lastSyncedAt: now
        });

        const membershipKey = `${productId}:${localLinePriceListId}`;
        const current = productMembershipMap.get(membershipKey) || {
          productId,
          localLinePriceListId,
          packageCount: 0
        };
        current.packageCount += 1;
        productMembershipMap.set(membershipKey, current);
      }
    }
  }

  const productSaleRows = [...new Set(priceListEntryRows.map((row) => row.productId))].map((productId) => {
    const productEntries = priceListEntryRows.filter(
      (row) =>
        row.productId === productId &&
        (!Number.isFinite(guestPriceListId) || Number(row.localLinePriceListId) === guestPriceListId)
    );
    let onSale = false;
    let saleDiscount = null;

    for (const row of productEntries) {
      const visible = row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible);
      if (!visible) continue;

      const derivedDiscount = computeDerivedSaleDiscount(
        row.finalPriceCache,
        row.strikethroughDisplayValue
      );
      const rowOnSale = isRealLocalLineSale(row);

      if (rowOnSale) {
        onSale = true;
      }
      if (
        Number.isFinite(derivedDiscount) &&
        (saleDiscount === null || derivedDiscount > saleDiscount)
      ) {
        saleDiscount = derivedDiscount;
      }
    }

    return {
      productId,
      onSale: onSale ? 1 : 0,
      saleDiscount,
      updatedAt: now
    };
  });

  return {
    priceLists,
    priceListIdByLocalLineId,
    productMetaRows,
    packageMetaRows,
    packageMemberships,
    productMembershipRows: [...productMembershipMap.values()],
    productSaleRows,
    priceListEntryRows,
    productMediaRows,
    fetchErrors,
    mediaMirrorIssues: [],
    mirroredProductImages: [],
    mirrorStats: {
      reusedRows: productMediaRows.filter((row) => row.reusedMirror).length,
      uploadedRows: 0,
      failedRows: 0
    }
  };
}

async function createSyncRun(connection, mode) {
  const startedAt = new Date();
  const [result] = await connection.query(
    `
      INSERT INTO local_line_sync_runs (mode, status, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [mode, "running", startedAt, startedAt, startedAt]
  );

  return {
    id: Number(result.insertId),
    startedAt
  };
}

async function finalizeSyncRun(connection, syncRunId, status, summary) {
  const now = new Date();
  await connection.query(
    `
      UPDATE local_line_sync_runs
      SET status = ?, finished_at = ?, summary_json = ?, updated_at = ?
      WHERE id = ?
    `,
    [status, now, JSON.stringify(summary), now, syncRunId]
  );
}

async function upsertPriceLists(connection, rows) {
  if (!rows.length) return new Map();

  for (const row of rows) {
    await connection.query(
      `
        INSERT INTO price_lists (
          local_line_price_list_id,
          name,
          active,
          source,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          active = VALUES(active),
          source = VALUES(source),
          updated_at = VALUES(updated_at),
          last_synced_at = VALUES(last_synced_at)
      `,
      [
        row.localLinePriceListId,
        row.name,
        row.active,
        row.source,
        row.createdAt || new Date(),
        row.updatedAt || new Date(),
        row.lastSyncedAt || new Date()
      ]
    );
  }

  const [storedRows] = await connection.query(
    `
      SELECT id, local_line_price_list_id AS localLinePriceListId
      FROM price_lists
      WHERE local_line_price_list_id IN (?)
    `,
    [rows.map((row) => row.localLinePriceListId)]
  );

  return new Map(storedRows.map((row) => [Number(row.localLinePriceListId), Number(row.id)]));
}

async function upsertProductMeta(connection, rows, options = {}) {
  const chunks = chunk(rows, 25);
  let completed = 0;

  for (const batch of chunks) {
    const values = batch.flatMap((row) => [
      row.productId,
      row.localLineProductId,
      row.internalId,
      row.vendorName,
      row.status,
      row.visible,
      row.trackInventory,
      row.trackInventoryBy,
      row.inventoryType,
      row.productInventory,
      row.reservedInventory,
      row.availableInventory,
      row.packageCodesEnabled,
      row.ownershipType,
      row.packingTag,
      row.exportHash,
      row.liveHash,
      row.lastLiveFetchStatus,
      row.lastLiveFetchError,
      row.rawJson,
      row.createdAt,
      row.updatedAt,
      row.lastSyncedAt
    ]);

    await connection.query(
      `
        INSERT INTO local_line_product_meta (
          product_id,
          local_line_product_id,
          internal_id,
          vendor_name,
          status,
          visible,
          track_inventory,
          track_inventory_by,
          inventory_type,
          product_inventory,
          reserved_inventory,
          available_inventory,
          package_codes_enabled,
          ownership_type,
          packing_tag,
          export_hash,
          live_hash,
          last_live_fetch_status,
          last_live_fetch_error,
          raw_json,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 23)}
        ON DUPLICATE KEY UPDATE
          local_line_product_id = VALUES(local_line_product_id),
          internal_id = VALUES(internal_id),
          vendor_name = VALUES(vendor_name),
          status = VALUES(status),
          visible = VALUES(visible),
          track_inventory = VALUES(track_inventory),
          track_inventory_by = VALUES(track_inventory_by),
          inventory_type = VALUES(inventory_type),
          product_inventory = VALUES(product_inventory),
          reserved_inventory = VALUES(reserved_inventory),
          available_inventory = VALUES(available_inventory),
          package_codes_enabled = VALUES(package_codes_enabled),
          ownership_type = VALUES(ownership_type),
          packing_tag = VALUES(packing_tag),
          export_hash = VALUES(export_hash),
          live_hash = VALUES(live_hash),
          last_live_fetch_status = VALUES(last_live_fetch_status),
          last_live_fetch_error = VALUES(last_live_fetch_error),
          raw_json = VALUES(raw_json),
          updated_at = VALUES(updated_at),
          last_synced_at = VALUES(last_synced_at)
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: rows.length
    });
  }
}

async function upsertPackageMeta(connection, rows, options = {}) {
  const chunks = chunk(rows, 25);
  let completed = 0;

  for (const batch of chunks) {
    const values = batch.flatMap((row) => [
      row.packageId,
      row.productId,
      row.localLinePackageId,
      row.liveName,
      row.livePrice,
      row.liveVisible,
      row.liveTrackInventory,
      row.inventoryType,
      row.packageInventory,
      row.packageReservedInventory,
      row.packageAvailableInventory,
      row.avgPackageWeight,
      row.numOfItems,
      row.packageCode,
      row.rawJson,
      row.createdAt,
      row.updatedAt,
      row.lastSyncedAt
    ]);

    await connection.query(
      `
        INSERT INTO local_line_package_meta (
          package_id,
          product_id,
          local_line_package_id,
          live_name,
          live_price,
          live_visible,
          live_track_inventory,
          inventory_type,
          package_inventory,
          package_reserved_inventory,
          package_available_inventory,
          avg_package_weight,
          num_of_items,
          package_code,
          raw_json,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 18)}
        ON DUPLICATE KEY UPDATE
          product_id = VALUES(product_id),
          local_line_package_id = VALUES(local_line_package_id),
          live_name = VALUES(live_name),
          live_price = VALUES(live_price),
          live_visible = VALUES(live_visible),
          live_track_inventory = VALUES(live_track_inventory),
          inventory_type = VALUES(inventory_type),
          package_inventory = VALUES(package_inventory),
          package_reserved_inventory = VALUES(package_reserved_inventory),
          package_available_inventory = VALUES(package_available_inventory),
          avg_package_weight = VALUES(avg_package_weight),
          num_of_items = VALUES(num_of_items),
          package_code = VALUES(package_code),
          raw_json = VALUES(raw_json),
          updated_at = VALUES(updated_at),
          last_synced_at = VALUES(last_synced_at)
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: rows.length
    });
  }
}

async function replaceLocalLinePriceListEntries(connection, rows, priceListIdMap, options = {}) {
  const productIds = [...new Set(rows.map((row) => row.productId))];
  if (productIds.length) {
    for (const ids of chunk(productIds, 200)) {
      await connection.query(
        `DELETE FROM local_line_price_list_entries WHERE product_id IN (?)`,
        [ids]
      );
    }
  }

  const insertRows = rows
    .map((row) => ({
      ...row,
      priceListId: priceListIdMap.get(row.localLinePriceListId)
    }))
    .filter((row) => row.priceListId);

  let completed = 0;
  for (const batch of chunk(insertRows, 50)) {
    const values = batch.flatMap((row) => [
      row.productId,
      row.localLineProductId,
      row.packageId,
      row.localLinePackageId,
      row.priceListId,
      row.localLinePriceListId,
      row.entryScope,
      row.sourceEntryId,
      row.priceListName,
      row.productName,
      row.packageName,
      row.visible,
      row.trackInventory,
      row.packageCode,
      row.adjustmentType,
      row.adjustmentValue,
      row.calculatedValue,
      row.basePriceUsed,
      row.finalPriceCache,
      row.onSale,
      row.onSaleToggle,
      row.strikethroughDisplayValue,
      row.maxUnitsPerOrder,
      row.rawJson,
      row.createdAt,
      row.updatedAt,
      row.lastSyncedAt
    ]);

    await connection.query(
      `
        INSERT INTO local_line_price_list_entries (
          product_id,
          local_line_product_id,
          package_id,
          local_line_package_id,
          price_list_id,
          local_line_price_list_id,
          entry_scope,
          source_entry_id,
          price_list_name,
          product_name,
          package_name,
          visible,
          track_inventory,
          package_code,
          adjustment_type,
          adjustment_value,
          calculated_value,
          base_price_used,
          final_price_cache,
          on_sale,
          on_sale_toggle,
          strikethrough_display_value,
          max_units_per_order,
          raw_json,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 27)}
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: insertRows.length
    });
  }
}

async function replacePackageMemberships(connection, rows, priceListIdMap, options = {}) {
  const packageIds = [...new Set(rows.map((row) => row.packageId))];
  if (packageIds.length) {
    for (const ids of chunk(packageIds, 200)) {
      await connection.query(
        `DELETE FROM package_price_list_memberships WHERE package_id IN (?)`,
        [ids]
      );
    }
  }

  const insertRows = rows
    .map((row) => ({
      ...row,
      priceListId: priceListIdMap.get(row.localLinePriceListId)
    }))
    .filter((row) => row.priceListId);

  let completed = 0;
  for (const batch of chunk(insertRows, 100)) {
    const values = batch.flatMap((row) => [
      row.packageId,
      row.priceListId,
      row.present,
      row.adjustmentType,
      row.adjustmentValue,
      row.calculatedValue,
      row.basePriceUsed,
      row.finalPriceCache,
      row.onSale,
      row.onSaleToggle,
      row.strikethroughDisplayValue,
      row.maxUnitsPerOrder,
      row.rawJson,
      row.createdAt,
      row.updatedAt,
      row.lastSyncedAt
    ]);

    await connection.query(
      `
        INSERT INTO package_price_list_memberships (
          package_id,
          price_list_id,
          present,
          adjustment_type,
          adjustment_value,
          calculated_value,
          base_price_used,
          final_price_cache,
          on_sale,
          on_sale_toggle,
          strikethrough_display_value,
          max_units_per_order,
          raw_json,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 16)}
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: insertRows.length
    });
  }
}

async function replaceProductMemberships(connection, rows, priceListIdMap, storeMappings, options = {}) {
  const productIds = [...new Set(rows.map((row) => row.productId))];
  if (productIds.length) {
    for (const ids of chunk(productIds, 200)) {
      await connection.query(
        `DELETE FROM product_price_list_memberships WHERE product_id IN (?)`,
        [ids]
      );
    }
  }

  const insertRows = rows
    .map((row) => {
      const priceListId = priceListIdMap.get(row.localLinePriceListId);
      if (!priceListId) return null;
      const packageCount = row.packageCount || 0;
      const totalStorePackages = (storeMappings.packagesByProductId.get(row.productId) || []).length;
      return {
        productId: row.productId,
        priceListId,
        packageCount,
        allPackagesPresent: totalStorePackages > 0 && packageCount >= totalStorePackages ? 1 : 0
      };
    })
    .filter(Boolean);

  let completed = 0;
  for (const batch of chunk(insertRows, 100)) {
    const timestamp = new Date();
    const values = batch.flatMap((row) => [
      row.productId,
      row.priceListId,
      row.packageCount,
      row.allPackagesPresent,
      timestamp,
      timestamp,
      timestamp
    ]);

    await connection.query(
      `
        INSERT INTO product_price_list_memberships (
          product_id,
          price_list_id,
          package_count,
          all_packages_present,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 7)}
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: insertRows.length
    });
  }
}

async function replaceProductSales(connection, rows, options = {}) {
  const productIds = [...new Set(rows.map((row) => row.productId))];
  if (productIds.length) {
    for (const ids of chunk(productIds, 200)) {
      await connection.query(`DELETE FROM product_sales WHERE product_id IN (?)`, [ids]);
    }
  }

  let completed = 0;
  for (const batch of chunk(rows, 100)) {
    const values = batch.flatMap((row) => [
      row.productId,
      row.onSale,
      row.saleDiscount,
      row.updatedAt
    ]);

    await connection.query(
      `
        INSERT INTO product_sales (
          product_id,
          on_sale,
          sale_discount,
          updated_at
        ) VALUES ${buildBatchPlaceholders(batch.length, 4)}
      `,
      values
    );

    completed += batch.length;
    options.onProgress?.({
      completed,
      total: rows.length
    });
  }
}

async function replaceProductMedia(connection, rows, productIds) {
  if (productIds.length) {
    for (const ids of chunk(productIds, 200)) {
      await connection.query(
        `DELETE FROM product_media WHERE source = 'localline' AND product_id IN (?)`,
        [ids]
      );
    }
  }

  for (const row of rows) {
    await connection.query(
      `
        INSERT INTO product_media (
          product_id,
          source,
          source_media_id,
          source_url,
          remote_url,
          storage_key,
          public_url,
          thumbnail_url,
          sort_order,
          is_primary,
          alt_text,
          content_hash,
          width,
          height,
          mime_type,
          fetched_at,
          created_at,
          updated_at,
          last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        row.productId,
        row.source,
        row.sourceMediaId,
        row.sourceUrl,
        row.remoteUrl,
        row.storageKey,
        row.publicUrl,
        row.thumbnailUrl,
        row.sortOrder,
        row.isPrimary,
        row.altText,
        row.contentHash,
        row.width,
        row.height,
        row.mimeType,
        row.fetchedAt,
        row.createdAt,
        row.updatedAt,
        row.lastSyncedAt
      ]
    );
  }
}

async function replaceProductImages(connection, rows, productIds) {
  if (productIds.length) {
    for (const ids of chunk(productIds, 200)) {
      await connection.query(
        `
          DELETE FROM product_images
          WHERE product_id IN (?)
            AND (
              url LIKE '%/localline/%'
              OR url LIKE '%localline-public-images.s3.amazonaws.com%'
            )
        `,
        [ids]
      );
    }
  }

  for (const row of rows) {
    await connection.query(
      `
        INSERT INTO product_images (
          product_id,
          url,
          url_hash
        ) VALUES (?, ?, ?)
      `,
      [row.productId, row.url, row.urlHash]
    );
  }
}

async function mirrorOneProductMedia(spacesClient, row) {
  const candidateUrls = [...new Set([row.remoteUrl, row.thumbnailUrl].filter(Boolean))];
  let response = null;
  let lastError = null;
  let fetchedFromUrl = null;

  for (const candidateUrl of candidateUrls) {
    const candidateResponse = await fetchWithRetry(candidateUrl, {}, {
      label: `Image download for product ${row.productId}`,
      timeoutMs: 30000
    });

    if (candidateResponse.ok) {
      response = candidateResponse;
      fetchedFromUrl = candidateUrl;
      break;
    }

    lastError = new Error(
      `Image download failed: ${candidateResponse.status} ${await candidateResponse.text()}`
    );
  }

  if (!response) {
    throw lastError || new Error("Image download failed");
  }

  const contentType = normalizeContentType(response.headers.get("content-type") || "");
  const buffer = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(buffer).metadata();
  const hash = sha256(buffer).slice(0, 24);
  const ext = extensionFromContentType(contentType);
  const objectKey = `products/${row.productId}/localline/${hash}.${ext}`;
  const thumbKey = `products/${row.productId}/localline/${hash}.thumbnail.jpg`;

  try {
    await spacesClient.send(
      new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: objectKey,
        Body: buffer,
        ACL: "public-read",
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable"
      })
    );
  } catch (error) {
    throw new Error(`Image upload failed for ${fetchedFromUrl || row.remoteUrl}: ${error.message}`);
  }

  const thumbnailBuffer = await sharp(buffer)
    .resize({ width: 480, height: 480, fit: "cover" })
    .jpeg({ quality: 82 })
    .toBuffer();

  try {
    await spacesClient.send(
      new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: thumbKey,
        Body: thumbnailBuffer,
        ACL: "public-read",
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable"
      })
    );
  } catch (error) {
    throw new Error(
      `Thumbnail upload failed for ${fetchedFromUrl || row.remoteUrl}: ${error.message}`
    );
  }

  const publicUrl = buildPublicUrl(objectKey);
  const thumbnailUrl = buildPublicUrl(thumbKey);

  return {
    ...row,
    storageKey: objectKey,
    publicUrl,
    thumbnailUrl,
    contentHash: hash,
    width: metadata.width || null,
    height: metadata.height || null,
    mimeType: contentType
  };
}

async function mirrorProductMediaAssets(dataset, options = {}) {
  const spacesClient = options.spacesClient;
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 4;
  const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const rowsToMirror = dataset.productMediaRows.filter(
    (row) => !row.publicUrl || !row.storageKey || !row.contentHash
  );

  if (!dataset.productMediaRows.length) {
    reportProgress({
      phaseKey: "image-mirroring",
      phaseLabel: "Image Mirroring",
      status: "completed",
      percent: 88,
      message: "No Local Line product images to mirror"
    });
    return dataset;
  }

  if (!spacesClient && rowsToMirror.length) {
    dataset.mediaMirrorIssues.push({
      severity: "warn",
      issueType: "image_mirror_unavailable",
      productId: null,
      packageId: null,
      priceListId: null,
      detailsJson: JSON.stringify({
        reason: "DO Spaces is not configured"
      }),
      createdAt: new Date(),
        updatedAt: new Date()
      });
    reportProgress({
      phaseKey: "image-mirroring",
      phaseLabel: "Image Mirroring",
      status: "completed",
      percent: 88,
      message: "Skipping image mirroring because DO Spaces is not configured"
    });
    return dataset;
  }

  if (!rowsToMirror.length) {
    dataset.mirroredProductImages = dataset.productMediaRows.flatMap((row) => {
      const publicUrl = row.publicUrl || row.remoteUrl || row.sourceUrl;
      const thumbnailUrl = row.thumbnailUrl || publicUrl;
      if (!publicUrl) return [];
      return [
        {
          productId: row.productId,
          url: publicUrl,
          urlHash: sha256(publicUrl).slice(0, 64)
        },
        {
          productId: row.productId,
          url: thumbnailUrl,
          urlHash: sha256(thumbnailUrl).slice(0, 64)
        }
      ];
    });
    reportProgress({
      phaseKey: "image-mirroring",
      phaseLabel: "Image Mirroring",
      status: "completed",
      percent: 88,
      message: `Reused ${dataset.mirrorStats.reusedRows} existing mirrored image rows`
    });
    return dataset;
  }

  reportProgress({
    phaseKey: "image-mirroring",
    phaseLabel: "Image Mirroring",
    status: "running",
    percent: 76,
    message: "Mirroring Local Line product images",
    current: 0,
    total: rowsToMirror.length
  });

  const mirroredRows = await mapWithConcurrency(
    rowsToMirror,
    concurrency,
    async (row) => {
      try {
        return {
          ok: true,
          key: buildMediaRowKey(row),
          row: await mirrorOneProductMedia(spacesClient, row)
        };
      } catch (error) {
        return {
          ok: false,
          key: buildMediaRowKey(row),
          row,
          error: error.message
        };
      }
    },
    ({ completed, total }) => {
      reportProgress({
        phaseKey: "image-mirroring",
        phaseLabel: "Image Mirroring",
        status: "running",
        percent: total ? 76 + Math.round((completed / total) * 12) : 88,
        message: "Mirroring Local Line product images",
        current: completed,
        total
      });
    }
  );

  const mirroredByKey = new Map(mirroredRows.map((item) => [item.key, item]));
  dataset.productMediaRows = dataset.productMediaRows.map((row) => {
    const updated = mirroredByKey.get(buildMediaRowKey(row));
    return updated ? updated.row : row;
  });
  dataset.mirrorStats.uploadedRows = mirroredRows.filter((item) => item.ok).length;
  dataset.mirrorStats.failedRows = mirroredRows.filter((item) => !item.ok).length;
  dataset.mirroredProductImages = dataset.productMediaRows.flatMap((row) => {
    const publicUrl = row.publicUrl || row.remoteUrl || row.sourceUrl;
    const thumbnailUrl = row.thumbnailUrl || publicUrl;
    if (!publicUrl) return [];
    const urlHash = sha256(publicUrl).slice(0, 64);
    const thumbHash = sha256(thumbnailUrl).slice(0, 64);
    return [
      {
        productId: row.productId,
        url: publicUrl,
        urlHash
      },
      {
        productId: row.productId,
        url: thumbnailUrl,
        urlHash: thumbHash
      }
    ];
  });

  mirroredRows
    .filter((item) => !item.ok)
    .forEach((item) => {
      dataset.mediaMirrorIssues.push({
        severity: "error",
        issueType: "image_mirror_failed",
        productId: item.row.productId,
        packageId: null,
        priceListId: null,
        detailsJson: JSON.stringify({
          remoteUrl: item.row.remoteUrl,
          error: item.error
        }),
        createdAt: new Date(),
        updatedAt: new Date()
      });
    });

  reportProgress({
    phaseKey: "image-mirroring",
    phaseLabel: "Image Mirroring",
    status: "completed",
    percent: 88,
    message: `Mirrored ${dataset.mirrorStats.uploadedRows} images and reused ${dataset.mirrorStats.reusedRows} existing rows`
  });

  return dataset;
}

async function replaceSyncIssues(connection, syncRunId, rows, priceListIdMap) {
  if (!rows.length) return;

  for (const row of rows) {
    await connection.query(
      `
        INSERT INTO local_line_sync_issues (
          sync_run_id,
          severity,
          issue_type,
          product_id,
          package_id,
          price_list_id,
          details_json,
          resolved_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        syncRunId,
        row.severity,
        row.issueType,
        row.productId,
        row.packageId,
        row.priceListId ? priceListIdMap.get(row.priceListId) || null : null,
        row.detailsJson,
        null,
        row.createdAt || new Date(),
        row.updatedAt || new Date()
      ]
    );
  }
}

function buildSummary(dataset, liveDetails, write, syncRunId = null, incremental = null) {
  const okCount = liveDetails.filter((item) => item?.ok).length;
  const errorCount = liveDetails.length - okCount;
  return {
    mode: write ? "apply" : "dry-run",
    syncRunId,
    exportSummary: {
      liveProductsFetched: okCount,
      liveFetchErrors: errorCount,
      priceLists: dataset.priceLists.length,
      productMetaRows: dataset.productMetaRows.length,
      packageMetaRows: dataset.packageMetaRows.length,
      packagePriceListMemberships: dataset.packageMemberships.length,
      productPriceListMemberships: dataset.productMembershipRows.length,
      productSalesRows: dataset.productSaleRows.length,
      priceListEntryRows: dataset.priceListEntryRows.length,
      productMediaRows: dataset.productMediaRows.length,
      mirroredProductImageRows: dataset.mirroredProductImages.length,
      syncIssueRows: dataset.fetchErrors.length + dataset.mediaMirrorIssues.length
    },
    incremental: incremental || null,
    mirrorSummary: dataset.mirrorStats || {
      reusedRows: 0,
      uploadedRows: 0,
      failedRows: 0
    },
    samplePriceLists: dataset.priceLists.slice(0, 10),
    samplePriceListEntries: dataset.priceListEntryRows.slice(0, 10),
    sampleProductMedia: dataset.productMediaRows.slice(0, 10),
    sampleMirroredProductImages: dataset.mirroredProductImages.slice(0, 10),
    sampleSyncIssues: [...dataset.fetchErrors, ...dataset.mediaMirrorIssues].slice(0, 10)
  };
}

export async function runLocalLineCacheSync(options = {}) {
  const storeEnvPath = resolveFromRepoRoot(".env");
  const reportFile = resolveFromRepoRoot(
    options.reportFile || path.join("tmp", "localline-cache-sync-report.json")
  );
  const write = Boolean(options.write);
  const forceFull = Boolean(options.forceFull);
  const liveRefreshHours =
    Number.isFinite(options.liveRefreshHours)
      ? options.liveRefreshHours
      : parseNumber(process.env.LL_LIVE_REFRESH_HOURS, 6);
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 6;
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  dotenv.config({ path: storeEnvPath });

  const baseUrl = normalizeBaseUrl(
    process.env.LL_BASEURL || "https://localline.ca/api/backoffice/v2/"
  );
  const storeConfig = {
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store"
  };

  const connection = await mysql.createConnection(storeConfig);
  let syncRun = null;
  const spacesClient = createSpacesClient();

  try {
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 44,
      message: "Preparing Local Line cache sync"
    });
    await ensureLocalLineSyncSchema(connection);
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 46,
      message: "Authenticating with Local Line"
    });
    const token = await getLocalLineAccessToken(baseUrl);
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 50,
      message: "Downloading Local Line export"
    });
    const exportFilePath = await downloadLocalLineExport(baseUrl, token);
    const exportCatalog = parseLocalLineExport(exportFilePath);
    const consideredProductIds = [...exportCatalog.productsById.keys()].slice(0, limit || undefined);
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 54,
      message: "Loading csa-store product mappings"
    });
    const storeMappings = await loadStoreMappings(connection, consideredProductIds);
    const incremental = selectProductIdsForSync(exportCatalog, storeMappings, {
      limit,
      forceFull,
      liveRefreshHours
    });
    const productIds = incremental.candidateProductIds;
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 58,
      message: productIds.length
        ? "Fetching live Local Line product details"
        : "No Local Line product changes detected",
      current: 0,
      total: productIds.length
    });
    const liveDetails = await mapWithConcurrency(
      productIds,
      concurrency,
      (productId) => fetchLocalLineProductDetail(baseUrl, token, productId),
      ({ completed, total }) => {
        reportProgress({
          phaseKey: "localline-fetch",
          phaseLabel: "Local Line Fetch",
          status: "running",
          percent: total ? 58 + Math.round((completed / total) * 14) : 72,
          message: "Fetching live Local Line product details",
          current: completed,
          total
        });
      }
    );
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "running",
      percent: 74,
      message: "Building Local Line dataset"
    });
    const incrementalExportCatalog = {
      ...exportCatalog,
      productsById: new Map(
        productIds.map((productId) => [productId, exportCatalog.productsById.get(productId)])
      ),
      packagesByProductId: new Map(
        productIds.map((productId) => [productId, exportCatalog.packagesByProductId.get(productId) || []])
      )
    };
    const dataset = buildCacheDataset(incrementalExportCatalog, liveDetails, storeMappings, {
      exportHashesByProductId: incremental.exportHashesByProductId
    });
    reportProgress({
      phaseKey: "localline-fetch",
      phaseLabel: "Local Line Fetch",
      status: "completed",
      percent: 75,
      message: productIds.length
        ? `Fetched ${productIds.length} changed Local Line products`
        : `No Local Line product changes detected across ${incremental.totalConsideredProducts} products`
    });

    if (write) {
      await mirrorProductMediaAssets(dataset, {
        spacesClient,
        concurrency: 4,
        onProgress: reportProgress
      });
    }

    if (write) {
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 90,
        message: "Recording sync run"
      });
      syncRun = await createSyncRun(connection, "localline-cache-sync");
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 91,
        message: "Writing price lists"
      });
      const priceListIdMap = await upsertPriceLists(
        connection,
        dataset.priceLists.map((row) => ({
          ...row,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncedAt: new Date()
        }))
      );

      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 93,
        message: "Writing Local Line product and package metadata"
      });
      await upsertProductMeta(connection, dataset.productMetaRows, {
        onProgress: ({ completed, total }) => {
          reportProgress({
            phaseKey: "store-write",
            phaseLabel: "Store Writes",
            status: "running",
            percent: 93,
            message: `Writing Local Line product metadata (${completed}/${total})`,
            current: completed,
            total
          });
        }
      });
      await upsertPackageMeta(connection, dataset.packageMetaRows, {
        onProgress: ({ completed, total }) => {
          reportProgress({
            phaseKey: "store-write",
            phaseLabel: "Store Writes",
            status: "running",
            percent: 94,
            message: `Writing Local Line package metadata (${completed}/${total})`,
            current: completed,
            total
          });
        }
      });
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 95,
        message: "Writing price-list memberships and entry metadata",
        current: null,
        total: null
      });
      await replacePackageMemberships(connection, dataset.packageMemberships, priceListIdMap, {
        onProgress: ({ completed, total }) => {
          reportProgress({
            phaseKey: "store-write",
            phaseLabel: "Store Writes",
            status: "running",
            percent: 95,
            message: `Writing package price-list memberships (${completed}/${total})`,
            current: completed,
            total
          });
        }
      });
      await replaceProductMemberships(
        connection,
        dataset.productMembershipRows,
        priceListIdMap,
        storeMappings,
        {
          onProgress: ({ completed, total }) => {
            reportProgress({
              phaseKey: "store-write",
              phaseLabel: "Store Writes",
              status: "running",
              percent: 95,
              message: `Writing product price-list memberships (${completed}/${total})`,
              current: completed,
              total
            });
          }
        }
      );
      await replaceProductSales(connection, dataset.productSaleRows, {
        onProgress: ({ completed, total }) => {
          reportProgress({
            phaseKey: "store-write",
            phaseLabel: "Store Writes",
            status: "running",
            percent: 96,
            message: `Writing product sale flags (${completed}/${total})`,
            current: completed,
            total
          });
        }
      });
      await replaceLocalLinePriceListEntries(connection, dataset.priceListEntryRows, priceListIdMap, {
        onProgress: ({ completed, total }) => {
          reportProgress({
            phaseKey: "store-write",
            phaseLabel: "Store Writes",
            status: "running",
            percent: 96,
            message: `Writing Local Line price-list entry metadata (${completed}/${total})`,
            current: completed,
            total
          });
        }
      });
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 97,
        message: "Writing cached media and mirrored product images",
        current: null,
        total: null
      });
      await replaceProductMedia(connection, dataset.productMediaRows, productIds);
      await replaceProductImages(connection, dataset.mirroredProductImages, productIds);
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "running",
        percent: 98,
        message: "Writing sync issues"
      });
      await replaceSyncIssues(
        connection,
        syncRun.id,
        [...dataset.fetchErrors, ...dataset.mediaMirrorIssues],
        priceListIdMap
      );
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "completed",
        percent: 99,
        message: "Local Line metadata written to csa-store"
      });
    } else {
      reportProgress({
        phaseKey: "store-write",
        phaseLabel: "Store Writes",
        status: "completed",
        percent: 99,
        message: "Dry run only; no csa-store writes performed"
      });
    }

    const summary = buildSummary(dataset, liveDetails, write, syncRun?.id || null, {
      enabled: !forceFull,
      forceFull,
      liveRefreshHours,
      totalConsideredProducts: incremental.totalConsideredProducts,
      candidateProducts: incremental.candidateProductIds.length,
      skippedUnchangedProducts: incremental.skippedProductIds.length,
      reasonCounts: incremental.reasonCounts
    });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(
      reportFile,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          reportFile,
          exportFilePath,
          write,
          summary
        },
        null,
        2
      )
    );

    if (write && syncRun) {
      await finalizeSyncRun(connection, syncRun.id, "completed", summary);
    }

    return { summary, reportFile };
  } catch (error) {
    if (write && syncRun) {
      await finalizeSyncRun(connection, syncRun.id, "failed", { error: error.message });
    }
    throw error;
  } finally {
    await connection.end();
  }
}

async function main() {
  const { summary, reportFile } = await runLocalLineCacheSync({
    write: hasFlag("write"),
    forceFull: hasFlag("force-full"),
    concurrency: Number(getArg("concurrency") || 6),
    liveRefreshHours: getArg("live-refresh-hours")
      ? Number(getArg("live-refresh-hours"))
      : undefined,
    limit: getArg("limit") ? Number(getArg("limit")) : null,
    reportFile: getArg("report-file") || path.join("tmp", "localline-cache-sync-report.json")
  });

  console.log(
    JSON.stringify(
      {
        reportFile,
        ...summary
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
