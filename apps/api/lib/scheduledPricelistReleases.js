import { ensureScheduledPricelistSchema, getDb, getPool } from "../db.js";
import { isLocalLineEnabled, updateLocalLineForProduct } from "../localLine.js";

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const BATCH_STATUS_SCHEDULED = "scheduled";
const BATCH_STATUS_RUNNING = "running";
const BATCH_STATUS_COMPLETED = "completed";
const BATCH_STATUS_PARTIAL = "partial";
const BATCH_STATUS_FAILED = "failed";
const BATCH_STATUS_CANCELLED = "cancelled";
const ITEM_STATUS_PENDING = "pending";
const ITEM_STATUS_LOCAL_APPLIED = "local_applied";
const ITEM_STATUS_REMOTE_APPLIED = "remote_applied";
const ITEM_STATUS_FAILED = "failed";
const ITEM_STATUS_CANCELLED = "cancelled";

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFlag(value, fallback = 0) {
  if (value === null || typeof value === "undefined" || value === "") return fallback;
  return value === true || value === "true" ? 1 : Number(value) ? 1 : 0;
}

function normalizeSaleDiscount(value) {
  const numeric = toNumber(value);
  if (numeric === null) return 0;
  return Math.max(0, Math.min(Number(numeric), 1));
}

function normalizeSaleDiscountComparable(value) {
  return Number(normalizeSaleDiscount(value).toFixed(4));
}

function dateToMysqlUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function mysqlUtcToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  if (text.includes("T")) return text.endsWith("Z") ? text : `${text.replace(/\.\d+$/, "")}.000Z`;
  return `${text.replace(" ", "T")}.000Z`;
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function jsonText(value) {
  return JSON.stringify(value ?? null);
}

function normalizeScheduledAt(value, { requireFuture = true, requireTopOfHour = true } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Scheduled time is invalid.");
  }
  if (requireFuture && date.getTime() <= Date.now()) {
    throw new Error("Scheduled time must be in the future.");
  }
  if (
    requireTopOfHour &&
    (date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0)
  ) {
    throw new Error("Scheduled time must be at the top of an hour.");
  }
  return date;
}

function normalizeChangePayload(changes = {}) {
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(changes, "visible")) {
    payload.visible = toFlag(changes.visible);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "trackInventory")) {
    payload.trackInventory = toFlag(changes.trackInventory);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "inventory")) {
    payload.inventory = Math.max(0, toInteger(changes.inventory, 0));
  }
  if (Object.prototype.hasOwnProperty.call(changes, "onSale")) {
    payload.onSale = toFlag(changes.onSale);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "saleDiscount")) {
    payload.saleDiscount = normalizeSaleDiscount(changes.saleDiscount);
  }
  return payload;
}

function hasChange(changes, key) {
  return Object.prototype.hasOwnProperty.call(changes || {}, key);
}

function normalizeScheduleItem(row = {}) {
  const productId = Number(row.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    throw new Error("Every scheduled change needs a valid product id.");
  }

  const changes = normalizeChangePayload(row.changes || {});
  if (!Object.keys(changes).length) {
    throw new Error(`Product ${productId} does not include any supported changes.`);
  }

  return {
    productId,
    productName: String(row.productName || row.name || `Product ${productId}`).trim(),
    payload: {
      kind: "pricelist-grid",
      changes
    },
    display: row.display || {}
  };
}

function batchFromRow(row = {}) {
  return {
    id: Number(row.id),
    name: row.name || "",
    status: row.status || "",
    scheduledAt: mysqlUtcToIso(row.scheduledAtUtc || row.scheduled_at || row.scheduledAt),
    timezone: row.timezone || DEFAULT_TIMEZONE,
    createdByUserId: row.createdByUserId ?? row.created_by_user_id ?? null,
    createdByUsername: row.createdByUsername || row.created_by_username || "",
    itemCount: Number(row.itemCount ?? row.item_count ?? 0),
    pendingCount: Number(row.pendingCount ?? 0),
    localAppliedCount: Number(row.localAppliedCount ?? 0),
    remoteAppliedCount: Number(row.remoteAppliedCount ?? 0),
    failedCount: Number(row.failedCount ?? 0),
    cancelledCount: Number(row.cancelledCount ?? 0),
    summary: safeJsonParse(row.summaryJson || row.summary_json, null),
    errorMessage: row.errorMessage || row.error_message || "",
    startedAt: mysqlUtcToIso(row.startedAtUtc || row.started_at),
    finishedAt: mysqlUtcToIso(row.finishedAtUtc || row.finished_at),
    createdAt: mysqlUtcToIso(row.createdAtUtc || row.created_at),
    updatedAt: mysqlUtcToIso(row.updatedAtUtc || row.updated_at)
  };
}

function itemFromRow(row = {}) {
  return {
    id: Number(row.id),
    batchId: Number(row.batchId ?? row.batch_id),
    productId: Number(row.productId ?? row.product_id),
    productName: row.productName || row.product_name || "",
    status: row.status || "",
    payload: safeJsonParse(row.payloadJson || row.payload_json, {}),
    display: safeJsonParse(row.displayJson || row.display_json, {}),
    originalSnapshot: safeJsonParse(row.originalSnapshotJson || row.original_snapshot_json, null),
    result: safeJsonParse(row.resultJson || row.result_json, null),
    errorMessage: row.errorMessage || row.error_message || "",
    localAppliedAt: mysqlUtcToIso(row.localAppliedAtUtc || row.local_applied_at),
    remoteAppliedAt: mysqlUtcToIso(row.remoteAppliedAtUtc || row.remote_applied_at),
    createdAt: mysqlUtcToIso(row.createdAtUtc || row.created_at),
    updatedAt: mysqlUtcToIso(row.updatedAtUtc || row.updated_at)
  };
}

async function loadCurrentSnapshot(connection, productId) {
  const [rows] = await connection.query(
    `
      SELECT
        p.id,
        p.name,
        p.visible,
        p.track_inventory AS trackInventory,
        p.inventory,
        ps.on_sale AS onSale,
        ps.sale_discount AS saleDiscount
      FROM products p
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      WHERE p.id = ?
      LIMIT 1
    `,
    [productId]
  );
  const row = rows[0] || null;
  if (!row) {
    throw new Error(`Product ${productId} not found.`);
  }
  return {
    productId: Number(row.id),
    productName: row.name || `Product ${productId}`,
    visible: toFlag(row.visible, 1),
    trackInventory: toFlag(row.trackInventory, 0),
    inventory: Math.max(0, toInteger(row.inventory, 0)),
    onSale: toFlag(row.onSale, 0),
    saleDiscount: normalizeSaleDiscount(row.saleDiscount)
  };
}

function findSnapshotConflicts(current, original, changes) {
  const conflicts = [];
  if (hasChange(changes, "visible") && toFlag(current.visible, 1) !== toFlag(original.visible, 1)) {
    conflicts.push("visible");
  }
  if (
    hasChange(changes, "trackInventory") &&
    toFlag(current.trackInventory, 0) !== toFlag(original.trackInventory, 0)
  ) {
    conflicts.push("trackInventory");
  }
  if (
    hasChange(changes, "inventory") &&
    toInteger(current.inventory, 0) !== toInteger(original.inventory, 0)
  ) {
    conflicts.push("inventory");
  }
  if (hasChange(changes, "onSale") && toFlag(current.onSale, 0) !== toFlag(original.onSale, 0)) {
    conflicts.push("onSale");
  }
  if (
    hasChange(changes, "saleDiscount") &&
    normalizeSaleDiscountComparable(current.saleDiscount) !==
      normalizeSaleDiscountComparable(original.saleDiscount)
  ) {
    conflicts.push("saleDiscount");
  }
  return conflicts;
}

async function findActiveProductConflicts(connection, productIds) {
  if (!productIds.length) return [];
  const [rows] = await connection.query(
    `
      SELECT
        i.product_id AS productId,
        i.product_name AS productName,
        b.id AS batchId,
        b.name AS batchName,
        DATE_FORMAT(b.scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledAtUtc
      FROM pricelist_change_items i
      JOIN pricelist_change_batches b ON b.id = i.batch_id
      WHERE i.product_id IN (?)
        AND b.status IN (?, ?)
        AND i.status IN (?, ?)
      ORDER BY b.scheduled_at ASC
    `,
    [
      productIds,
      BATCH_STATUS_SCHEDULED,
      BATCH_STATUS_RUNNING,
      ITEM_STATUS_PENDING,
      ITEM_STATUS_LOCAL_APPLIED
    ]
  );
  return rows.map((row) => ({
    productId: Number(row.productId),
    productName: row.productName || `Product ${row.productId}`,
    batchId: Number(row.batchId),
    batchName: row.batchName || `Release ${row.batchId}`,
    scheduledAt: mysqlUtcToIso(row.scheduledAtUtc)
  }));
}

function isMissingScheduledPricelistTableError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.code === "ER_NO_SUCH_TABLE" ||
    (
      (message.includes("pricelist_change_items") || message.includes("pricelist_change_batches")) &&
      (message.includes("doesn't exist") || message.includes("no such table"))
    )
  );
}

export async function getActiveScheduledPricelistProductChangeMap(connection = getPool()) {
  let rows = [];
  try {
    [rows] = await connection.query(
      `
        SELECT
          i.product_id AS productId,
          i.product_name AS productName,
          i.payload_json AS payloadJson,
          b.id AS batchId,
          b.name AS batchName,
          DATE_FORMAT(b.scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledAtUtc
        FROM pricelist_change_items i
        JOIN pricelist_change_batches b ON b.id = i.batch_id
        WHERE b.status IN (?, ?)
          AND i.status IN (?, ?)
        ORDER BY b.scheduled_at ASC, b.id ASC
      `,
      [
        BATCH_STATUS_SCHEDULED,
        BATCH_STATUS_RUNNING,
        ITEM_STATUS_PENDING,
        ITEM_STATUS_LOCAL_APPLIED
      ]
    );
  } catch (error) {
    if (isMissingScheduledPricelistTableError(error)) return new Map();
    throw error;
  }

  return rows.reduce((acc, row) => {
    const productId = Number(row.productId);
    if (!Number.isFinite(productId)) return acc;
    const payload = safeJsonParse(row.payloadJson, {});
    const changeKeys = Object.keys(normalizeChangePayload(payload?.changes || {}));
    const entry =
      acc.get(productId) ||
      {
        productId,
        productName: row.productName || `Product ${productId}`,
        changeKeys: new Set(),
        batches: []
      };

    changeKeys.forEach((key) => entry.changeKeys.add(key));
    entry.batches.push({
      batchId: Number(row.batchId),
      batchName: row.batchName || `Release ${row.batchId}`,
      scheduledAt: mysqlUtcToIso(row.scheduledAtUtc),
      changeKeys
    });
    acc.set(productId, entry);
    return acc;
  }, new Map());
}

async function insertBatch(connection, { name, scheduledAt, timezone, createdByUserId, itemCount }) {
  const now = dateToMysqlUtc(new Date());
  const [result] = await connection.query(
    `
      INSERT INTO pricelist_change_batches (
        name, status, scheduled_at, timezone, created_by_user_id, item_count,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      name,
      BATCH_STATUS_SCHEDULED,
      dateToMysqlUtc(scheduledAt),
      timezone,
      createdByUserId || null,
      itemCount,
      now,
      now
    ]
  );
  return Number(result.insertId);
}

async function insertBatchItem(connection, batchId, item, originalSnapshot) {
  const now = dateToMysqlUtc(new Date());
  await connection.query(
    `
      INSERT INTO pricelist_change_items (
        batch_id, product_id, product_name, status, payload_json, display_json,
        original_snapshot_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      batchId,
      item.productId,
      item.productName,
      ITEM_STATUS_PENDING,
      jsonText(item.payload),
      jsonText(item.display),
      jsonText(originalSnapshot),
      now,
      now
    ]
  );
}

export async function createScheduledPricelistBatch({
  name = "",
  scheduledAt,
  timezone = DEFAULT_TIMEZONE,
  rows = [],
  createdByUserId = null
} = {}) {
  await ensureScheduledPricelistSchema();
  const normalizedRows = rows.map(normalizeScheduleItem);
  if (!normalizedRows.length) {
    throw new Error("Add at least one pricelist change before scheduling.");
  }

  const productIds = [...new Set(normalizedRows.map((row) => row.productId))];
  if (productIds.length !== normalizedRows.length) {
    throw new Error("A scheduled release can only include a product once.");
  }

  const releaseTime = normalizeScheduledAt(scheduledAt);
  const releaseName =
    String(name || "").trim() ||
    `Pricelist release ${releaseTime.toISOString().slice(0, 13).replace("T", " ")}`;
  const safeTimezone = String(timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const conflicts = await findActiveProductConflicts(connection, productIds);
    if (conflicts.length) {
      throw new Error(
        `Product ${conflicts[0].productName} is already scheduled in ${conflicts[0].batchName}.`
      );
    }

    const batchId = await insertBatch(connection, {
      name: releaseName,
      scheduledAt: releaseTime,
      timezone: safeTimezone,
      createdByUserId,
      itemCount: normalizedRows.length
    });

    for (const item of normalizedRows) {
      const snapshot = await loadCurrentSnapshot(connection, item.productId);
      await insertBatchItem(connection, batchId, item, snapshot);
    }

    await connection.commit();
    return getScheduledPricelistBatch(batchId);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function selectBatchById(connection, batchId) {
  const [rows] = await connection.query(
    `
      SELECT
        b.*,
        DATE_FORMAT(b.scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledAtUtc,
        DATE_FORMAT(b.started_at, '%Y-%m-%d %H:%i:%s') AS startedAtUtc,
        DATE_FORMAT(b.finished_at, '%Y-%m-%d %H:%i:%s') AS finishedAtUtc,
        DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s') AS createdAtUtc,
        DATE_FORMAT(b.updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAtUtc,
        u.username AS createdByUsername
      FROM pricelist_change_batches b
      LEFT JOIN users u ON u.id = b.created_by_user_id
      WHERE b.id = ?
      LIMIT 1
    `,
    [batchId]
  );
  return rows[0] ? batchFromRow(rows[0]) : null;
}

async function selectItemsForBatch(connection, batchId, statusFilter = null) {
  const params = [batchId];
  let statusSql = "";
  if (Array.isArray(statusFilter) && statusFilter.length) {
    statusSql = "AND status IN (?)";
    params.push(statusFilter);
  }
  const [rows] = await connection.query(
    `
      SELECT
        *,
        DATE_FORMAT(local_applied_at, '%Y-%m-%d %H:%i:%s') AS localAppliedAtUtc,
        DATE_FORMAT(remote_applied_at, '%Y-%m-%d %H:%i:%s') AS remoteAppliedAtUtc,
        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAtUtc,
        DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAtUtc
      FROM pricelist_change_items
      WHERE batch_id = ?
        ${statusSql}
      ORDER BY id ASC
    `,
    params
  );
  return rows.map(itemFromRow);
}

export async function listScheduledPricelistBatches({ limit = 25 } = {}) {
  await ensureScheduledPricelistSchema();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const [rows] = await getPool().query(
    `
      SELECT
        b.*,
        DATE_FORMAT(b.scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledAtUtc,
        DATE_FORMAT(b.started_at, '%Y-%m-%d %H:%i:%s') AS startedAtUtc,
        DATE_FORMAT(b.finished_at, '%Y-%m-%d %H:%i:%s') AS finishedAtUtc,
        DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s') AS createdAtUtc,
        DATE_FORMAT(b.updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAtUtc,
        u.username AS createdByUsername,
        SUM(CASE WHEN i.status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN i.status = 'local_applied' THEN 1 ELSE 0 END) AS localAppliedCount,
        SUM(CASE WHEN i.status = 'remote_applied' THEN 1 ELSE 0 END) AS remoteAppliedCount,
        SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelledCount
      FROM pricelist_change_batches b
      LEFT JOIN users u ON u.id = b.created_by_user_id
      LEFT JOIN pricelist_change_items i ON i.batch_id = b.id
      GROUP BY b.id
      ORDER BY
        FIELD(b.status, 'running', 'scheduled', 'partial', 'failed', 'completed', 'cancelled'),
        b.scheduled_at DESC,
        b.id DESC
      LIMIT ?
    `,
    [safeLimit]
  );
  const batches = rows.map(batchFromRow);
  const batchIds = batches.map((batch) => batch.id).filter((value) => Number.isFinite(value));
  if (!batchIds.length) return batches;

  const [itemRows] = await getPool().query(
    `
      SELECT id, batch_id AS batchId, product_id AS productId, product_name AS productName, status
      FROM pricelist_change_items
      WHERE batch_id IN (?)
      ORDER BY batch_id ASC, id ASC
    `,
    [batchIds]
  );
  const itemsByBatchId = itemRows.reduce((acc, row) => {
    const batchId = Number(row.batchId);
    const list = acc.get(batchId) || [];
    list.push({
      id: Number(row.id),
      batchId,
      productId: Number(row.productId),
      productName: row.productName || `Product ${row.productId}`,
      status: row.status || ""
    });
    acc.set(batchId, list);
    return acc;
  }, new Map());

  return batches.map((batch) => ({
    ...batch,
    items: itemsByBatchId.get(batch.id) || []
  }));
}

export async function getScheduledPricelistBatch(batchId) {
  await ensureScheduledPricelistSchema();
  const safeBatchId = Number(batchId);
  if (!Number.isFinite(safeBatchId) || safeBatchId <= 0) {
    throw new Error("Invalid scheduled release id.");
  }
  const connection = await getPool().getConnection();
  try {
    const batch = await selectBatchById(connection, safeBatchId);
    if (!batch) return null;
    const items = await selectItemsForBatch(connection, safeBatchId);
    return { ...batch, items };
  } finally {
    connection.release();
  }
}

export async function cancelScheduledPricelistBatch(batchId) {
  await ensureScheduledPricelistSchema();
  const safeBatchId = Number(batchId);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `
        UPDATE pricelist_change_batches
        SET status = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
          AND status = ?
      `,
      [
        BATCH_STATUS_CANCELLED,
        dateToMysqlUtc(new Date()),
        dateToMysqlUtc(new Date()),
        safeBatchId,
        BATCH_STATUS_SCHEDULED
      ]
    );
    if (Number(result.affectedRows || 0) !== 1) {
      throw new Error("Only scheduled releases can be cancelled.");
    }
    await connection.query(
      `
        UPDATE pricelist_change_items
        SET status = ?, updated_at = ?
        WHERE batch_id = ?
          AND status = ?
      `,
      [ITEM_STATUS_CANCELLED, dateToMysqlUtc(new Date()), safeBatchId, ITEM_STATUS_PENDING]
    );
    await connection.commit();
    return getScheduledPricelistBatch(safeBatchId);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function claimBatchForRun(connection, batchId, { allowFuture = false } = {}) {
  const now = dateToMysqlUtc(new Date());
  const dueClause = allowFuture ? "" : "AND scheduled_at <= ?";
  const params = [
    BATCH_STATUS_RUNNING,
    now,
    now,
    batchId,
    BATCH_STATUS_SCHEDULED
  ];
  if (!allowFuture) params.push(now);
  const [result] = await connection.query(
    `
      UPDATE pricelist_change_batches
      SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?, error_message = NULL
      WHERE id = ?
        AND status = ?
        ${dueClause}
    `,
    params
  );
  return Number(result.affectedRows || 0) === 1;
}

async function markBatchRunningForRetry(connection, batchId) {
  const now = dateToMysqlUtc(new Date());
  const [result] = await connection.query(
    `
      UPDATE pricelist_change_batches
      SET status = ?, updated_at = ?, error_message = NULL
      WHERE id = ?
        AND status IN (?, ?)
    `,
    [BATCH_STATUS_RUNNING, now, batchId, BATCH_STATUS_PARTIAL, BATCH_STATUS_FAILED]
  );
  return Number(result.affectedRows || 0) === 1;
}

async function applyLocalChanges(connection, productId, changes) {
  const now = dateToMysqlUtc(new Date());
  const productSets = [];
  const productParams = [];
  if (hasChange(changes, "visible")) {
    productSets.push("visible = ?");
    productParams.push(toFlag(changes.visible));
  }
  if (hasChange(changes, "trackInventory")) {
    productSets.push("track_inventory = ?");
    productParams.push(toFlag(changes.trackInventory));
  }
  if (hasChange(changes, "inventory")) {
    productSets.push("inventory = ?");
    productParams.push(Math.max(0, toInteger(changes.inventory, 0)));
  }
  if (productSets.length) {
    productSets.push("updated_at = ?");
    productParams.push(now, productId);
    await connection.query(
      `UPDATE products SET ${productSets.join(", ")} WHERE id = ?`,
      productParams
    );
  }

  const saleChanged = hasChange(changes, "onSale") || hasChange(changes, "saleDiscount");
  const nextOnSale = toFlag(changes.onSale, 0);
  const nextSaleDiscount = hasChange(changes, "saleDiscount")
    ? normalizeSaleDiscount(changes.saleDiscount)
    : null;

  if (saleChanged) {
    await connection.query(
      `
        INSERT INTO product_sales (product_id, on_sale, sale_discount, updated_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          on_sale = VALUES(on_sale),
          sale_discount = VALUES(sale_discount),
          updated_at = VALUES(updated_at)
      `,
      [productId, nextOnSale, nextSaleDiscount, now]
    );
  }

  const profileColumns = [
    "product_id",
    "remote_sync_status",
    "remote_sync_message",
    "created_at",
    "updated_at"
  ];
  const profileValues = [
    productId,
    "pending",
    "Scheduled pricelist release applied locally. Apply to remote store pending.",
    now,
    now
  ];
  const profileUpdates = [
    "remote_sync_status = VALUES(remote_sync_status)",
    "remote_sync_message = VALUES(remote_sync_message)",
    "updated_at = VALUES(updated_at)"
  ];

  if (saleChanged) {
    profileColumns.push("on_sale", "sale_discount", "price_changed_at");
    profileValues.push(nextOnSale, nextSaleDiscount, now);
    profileUpdates.push(
      "on_sale = VALUES(on_sale)",
      "sale_discount = VALUES(sale_discount)",
      "price_changed_at = VALUES(price_changed_at)"
    );
  }

  await connection.query(
    `
      INSERT INTO product_pricing_profiles (${profileColumns.join(", ")})
      VALUES (${profileColumns.map(() => "?").join(", ")})
      ON DUPLICATE KEY UPDATE
        ${profileUpdates.join(", ")}
    `,
    profileValues
  );
}

async function markItemFailed(connection, itemId, message, result) {
  await connection.query(
    `
      UPDATE pricelist_change_items
      SET status = ?, error_message = ?, result_json = ?, updated_at = ?
      WHERE id = ?
    `,
    [
      ITEM_STATUS_FAILED,
      message,
      jsonText(result),
      dateToMysqlUtc(new Date()),
      itemId
    ]
  );
}

async function markItemLocalApplied(connection, itemId, result) {
  const now = dateToMysqlUtc(new Date());
  await connection.query(
    `
      UPDATE pricelist_change_items
      SET status = ?, local_applied_at = COALESCE(local_applied_at, ?),
          result_json = ?, error_message = NULL, updated_at = ?
      WHERE id = ?
    `,
    [ITEM_STATUS_LOCAL_APPLIED, now, jsonText(result), now, itemId]
  );
}

async function markItemRemoteApplied(connection, itemId, result) {
  const now = dateToMysqlUtc(new Date());
  await connection.query(
    `
      UPDATE pricelist_change_items
      SET status = ?, remote_applied_at = ?, result_json = ?, error_message = NULL, updated_at = ?
      WHERE id = ?
    `,
    [ITEM_STATUS_REMOTE_APPLIED, now, jsonText(result), now, itemId]
  );
}

async function markProductRemoteStatus(connection, productId, status, message) {
  const now = dateToMysqlUtc(new Date());
  if (status === "applied") {
    await connection.query(
      `
        UPDATE product_pricing_profiles
        SET remote_sync_status = ?, remote_sync_message = ?, remote_synced_at = ?, updated_at = ?
        WHERE product_id = ?
      `,
      [status, message, now, now, productId]
    );
    return;
  }

  await connection.query(
    `
      UPDATE product_pricing_profiles
      SET remote_sync_status = ?, remote_sync_message = ?, updated_at = ?
      WHERE product_id = ?
    `,
    [status, message, now, productId]
  );
}

async function applyItemLocally(item) {
  const changes = normalizeChangePayload(item.payload?.changes || {});
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const currentSnapshot = await loadCurrentSnapshot(connection, item.productId);
    const conflicts = findSnapshotConflicts(currentSnapshot, item.originalSnapshot || {}, changes);
    if (conflicts.length) {
      const message = `Scheduled release conflict: ${conflicts.join(", ")} changed after scheduling.`;
      await markItemFailed(connection, item.id, message, {
        stage: "conflict",
        conflicts,
        currentSnapshot,
        originalSnapshot: item.originalSnapshot
      });
      await connection.commit();
      return { ok: false, stage: "conflict", message };
    }

    await applyLocalChanges(connection, item.productId, changes);
    await markItemLocalApplied(connection, item.id, {
      stage: "local",
      ok: true,
      appliedAt: new Date().toISOString()
    });
    await connection.commit();
    return { ok: true };
  } catch (error) {
    await connection.rollback().catch(() => {});
    const markConnection = await getPool().getConnection();
    try {
      await markItemFailed(markConnection, item.id, error?.message || "Local apply failed.", {
        stage: "local",
        ok: false,
        error: error?.message || "Local apply failed."
      });
    } finally {
      markConnection.release();
    }
    return { ok: false, stage: "local", message: error?.message || "Local apply failed." };
  } finally {
    connection.release();
  }
}

async function pushItemRemote(item) {
  const changes = normalizeChangePayload(item.payload?.changes || {});
  const remoteChanges = { ...changes };
  if (hasChange(changes, "onSale") || hasChange(changes, "saleDiscount")) {
    remoteChanges.forcePriceSync = true;
  }

  try {
    const remoteResult = await updateLocalLineForProduct(getDb(), item.productId, remoteChanges);
    const remoteFailed =
      isLocalLineEnabled() &&
      (remoteResult.inventoryOk === false || remoteResult.priceOk === false || remoteResult.imagesOk === false);

    const connection = await getPool().getConnection();
    try {
      if (remoteFailed) {
        await markProductRemoteStatus(
          connection,
          item.productId,
          "failed",
          "Scheduled release applied locally, but Local Line sync failed."
        );
        await markItemFailed(connection, item.id, "Local Line sync failed.", {
          stage: "remote",
          ok: false,
          remoteResult
        });
        return { ok: false, stage: "remote", message: "Local Line sync failed." };
      }

      await markProductRemoteStatus(
        connection,
        item.productId,
        "applied",
        "Scheduled pricelist release applied to Local Line."
      );
      await markItemRemoteApplied(connection, item.id, {
        stage: "remote",
        ok: true,
        remoteResult
      });
      return { ok: true, remoteResult };
    } finally {
      connection.release();
    }
  } catch (error) {
    const connection = await getPool().getConnection();
    try {
      await markProductRemoteStatus(
        connection,
        item.productId,
        "failed",
        "Scheduled release applied locally, but Local Line sync failed."
      );
      await markItemFailed(connection, item.id, error?.message || "Local Line sync failed.", {
        stage: "remote",
        ok: false,
        error: error?.message || "Local Line sync failed."
      });
    } finally {
      connection.release();
    }
    return { ok: false, stage: "remote", message: error?.message || "Local Line sync failed." };
  }
}

async function updateBatchFinalStatus(batchId) {
  const connection = await getPool().getConnection();
  try {
    const [rows] = await connection.query(
      `
        SELECT status, COUNT(*) AS count
        FROM pricelist_change_items
        WHERE batch_id = ?
        GROUP BY status
      `,
      [batchId]
    );
    const counts = rows.reduce((acc, row) => {
      acc[row.status] = Number(row.count || 0);
      return acc;
    }, {});
    const totalActive =
      (counts[ITEM_STATUS_PENDING] || 0) +
      (counts[ITEM_STATUS_LOCAL_APPLIED] || 0) +
      (counts[ITEM_STATUS_REMOTE_APPLIED] || 0) +
      (counts[ITEM_STATUS_FAILED] || 0);
    const remoteApplied = counts[ITEM_STATUS_REMOTE_APPLIED] || 0;
    const failed = counts[ITEM_STATUS_FAILED] || 0;
    let status = BATCH_STATUS_COMPLETED;
    if (failed > 0 && remoteApplied > 0) {
      status = BATCH_STATUS_PARTIAL;
    } else if (failed > 0) {
      status = BATCH_STATUS_FAILED;
    } else if (remoteApplied < totalActive) {
      status = BATCH_STATUS_PARTIAL;
    }

    const summary = {
      counts,
      totalActive,
      remoteApplied,
      failed
    };
    const now = dateToMysqlUtc(new Date());
    await connection.query(
      `
        UPDATE pricelist_change_batches
        SET status = ?, summary_json = ?, error_message = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [
        status,
        jsonText(summary),
        failed ? `${failed} scheduled change${failed === 1 ? "" : "s"} failed.` : null,
        now,
        now,
        batchId
      ]
    );
    return status;
  } finally {
    connection.release();
  }
}

async function executeItems(batchId, items) {
  for (const item of items) {
    let latestItem = item;
    if (!latestItem.localAppliedAt) {
      const localResult = await applyItemLocally(latestItem);
      if (!localResult.ok) {
        continue;
      }
      latestItem = {
        ...latestItem,
        localAppliedAt: new Date().toISOString()
      };
    }
    if (!latestItem.remoteAppliedAt) {
      await pushItemRemote(latestItem);
    }
  }
  await updateBatchFinalStatus(batchId);
  return getScheduledPricelistBatch(batchId);
}

export async function runScheduledPricelistBatch(batchId, { allowFuture = false } = {}) {
  await ensureScheduledPricelistSchema();
  const safeBatchId = Number(batchId);
  if (!Number.isFinite(safeBatchId) || safeBatchId <= 0) {
    throw new Error("Invalid scheduled release id.");
  }

  const connection = await getPool().getConnection();
  try {
    const claimed = await claimBatchForRun(connection, safeBatchId, { allowFuture });
    if (!claimed) {
      throw new Error("Scheduled release is not ready to run.");
    }
  } finally {
    connection.release();
  }

  const items = await selectItemsForBatch(getPool(), safeBatchId, [ITEM_STATUS_PENDING]);
  return executeItems(safeBatchId, items);
}

export async function retryScheduledPricelistBatch(batchId) {
  await ensureScheduledPricelistSchema();
  const safeBatchId = Number(batchId);
  if (!Number.isFinite(safeBatchId) || safeBatchId <= 0) {
    throw new Error("Invalid scheduled release id.");
  }

  const connection = await getPool().getConnection();
  try {
    const claimed = await markBatchRunningForRetry(connection, safeBatchId);
    if (!claimed) {
      throw new Error("Only failed or partial releases can be retried.");
    }
  } finally {
    connection.release();
  }

  const items = (await selectItemsForBatch(getPool(), safeBatchId, [ITEM_STATUS_FAILED]))
    .filter((item) => item.localAppliedAt && !item.remoteAppliedAt);
  if (!items.length) {
    await updateBatchFinalStatus(safeBatchId);
    return getScheduledPricelistBatch(safeBatchId);
  }
  return executeItems(safeBatchId, items);
}

export async function runDueScheduledPricelistBatches({ limit = 10 } = {}) {
  await ensureScheduledPricelistSchema();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const [rows] = await getPool().query(
    `
      SELECT id
      FROM pricelist_change_batches
      WHERE status = ?
        AND scheduled_at <= ?
      ORDER BY scheduled_at ASC, id ASC
      LIMIT ?
    `,
    [BATCH_STATUS_SCHEDULED, dateToMysqlUtc(new Date()), safeLimit]
  );
  const results = [];
  for (const row of rows) {
    try {
      const batch = await runScheduledPricelistBatch(row.id);
      results.push({ id: Number(row.id), ok: true, batch });
    } catch (error) {
      results.push({ id: Number(row.id), ok: false, error: error?.message || "Scheduled release failed." });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    count: results.length,
    results
  };
}

export const scheduledPricelistStatuses = {
  batch: {
    scheduled: BATCH_STATUS_SCHEDULED,
    running: BATCH_STATUS_RUNNING,
    completed: BATCH_STATUS_COMPLETED,
    partial: BATCH_STATUS_PARTIAL,
    failed: BATCH_STATUS_FAILED,
    cancelled: BATCH_STATUS_CANCELLED
  },
  item: {
    pending: ITEM_STATUS_PENDING,
    localApplied: ITEM_STATUS_LOCAL_APPLIED,
    remoteApplied: ITEM_STATUS_REMOTE_APPLIED,
    failed: ITEM_STATUS_FAILED,
    cancelled: ITEM_STATUS_CANCELLED
  }
};
