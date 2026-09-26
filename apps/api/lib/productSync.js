import { getPool } from "../db.js";
import { isLocalLineEnabled } from "../localLine.js";
import { isSquareEnabled, syncSquareCatalogCache, buildSquareMatchReview } from "./squareStoreSync.js";
import { prepareLocalLineAction, prepareSquareActions, inspectAction, executeAction } from "./productSyncAdapters.js";
import { prepareIncomingActions, applyIncomingAction } from "./productSyncIncoming.js";
import { ensureProductSyncSchema, parseJson, utcNow, isoUtc, withSyncLock } from "./productSyncSchema.js";
import { listScheduledPricelistBatches } from "./scheduledPricelistReleases.js";
import { normalizeIds, normalizeStaged, hasGrant, fail, authorizeRelease, releaseTime, same, executeProductActions, releaseStatus } from "./productSyncCore.js";
import { auditVendorGroup, auditProducts } from "./productSyncScope.js";
import { PRICELIST_PENDING_REMOTE_APPLY_SQL } from "./productWorkspaceFilters.js";

export async function loadCurrentSnapshot(connection, productId) {
  const [rows] = await connection.query(`SELECT p.id AS productId, p.name AS productName, p.visible, p.track_inventory AS trackInventory, p.inventory,
    COALESCE(ps.on_sale, pp.on_sale, 0) AS onSale, COALESCE(ps.sale_discount, pp.sale_discount, 0) AS saleDiscount
    FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id WHERE p.id=?`, [productId]);
  if (!rows.length) fail("Product no longer exists.");
  const row = rows[0];
  for (const key of ["productId", "visible", "trackInventory", "inventory", "onSale", "saleDiscount"]) row[key] = Number(row[key] || 0);
  return row;
}
export async function applyLocalChanges(connection, productId, changes) {
  const columns = { visible: "visible", trackInventory: "track_inventory", inventory: "inventory" };
  const fields = Object.keys(columns).filter(key => Object.hasOwn(changes, key));
  if (fields.length) await connection.query(`UPDATE products SET ${fields.map(key => `${columns[key]}=?`).join(", ")}, updated_at=UTC_TIMESTAMP() WHERE id=?`, [...fields.map(key => changes[key]), productId]);
  if (Object.hasOwn(changes, "onSale")) {
    await connection.query(`INSERT INTO product_sales (product_id, on_sale, sale_discount, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE on_sale=VALUES(on_sale), sale_discount=VALUES(sale_discount), updated_at=VALUES(updated_at)`, [productId, changes.onSale, changes.saleDiscount]);
    await connection.query("UPDATE product_pricing_profiles SET on_sale=?, sale_discount=?, price_changed_at=UTC_TIMESTAMP() WHERE product_id=?", [changes.onSale, changes.saleDiscount, productId]);
  }
  await connection.query("UPDATE product_pricing_profiles SET remote_sync_status='pending', remote_sync_message='Product release applied locally.', updated_at=UTC_TIMESTAMP() WHERE product_id=?", [productId]);
}
const PLATFORM_LABEL = { localline: "Local Line", square: "Square" };
export async function syncCatalog() {
  const [rows] = await getPool().query(`SELECT p.id, p.name, v.name AS vendorName, c.name AS categoryName, lm.local_line_product_id AS localLineProductId
    FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id
    WHERE COALESCE(p.is_deleted, 0)=0 ORDER BY p.name, p.id`);
  return rows;
}
function actionFromRow(row) {
  return { ...parseJson(row.data_json, {}), id: Number(row.id), auditId: Number(row.audit_id), status: row.status,
    result: parseJson(row.result_json), released: Boolean(row.released_at) };
}
async function storeAction(auditId, action) {
  await getPool().query("UPDATE product_sync_audits SET progress_at=UTC_TIMESTAMP() WHERE id=?", [auditId]);
  await getPool().query(`INSERT INTO product_sync_actions (audit_id, product_id, product_name, vendor_name, platform, direction, status, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [auditId, action.productId, action.productName || "Unknown product", action.vendorName || "", action.platform, action.direction, action.status, JSON.stringify(action)]);
}
export async function createProductSyncAudit(options, user) {
  await ensureProductSyncSchema();
  const roles = user.adminRoles || [];
  const platforms = [...new Set(options.platforms || [])];
  if (!platforms.length || platforms.some(platform => !PLATFORM_LABEL[platform])) fail("Select Local Line, Square, or both.");
  for (const platform of platforms) {
    if (![`${platform}_pull`, `${platform}_push`, "pricing_admin"].some(role => hasGrant(roles, role))) fail(`You cannot audit ${PLATFORM_LABEL[platform]}.`, 403);
  }
  const staged = normalizeStaged(options.staged || []);
  if (Object.keys(staged).length && !["inventory_admin", "pricing_admin", "local_pricelist_admin"].some(role => hasGrant(roles, role))) fail("Staging requires local editing permission.", 403);
  if (options.incoming && (!platforms.includes("localline") || !hasGrant(roles, "localline_pull"))) fail("Incoming repairs require Local Line Pull.", 403);
  const productIds = options.productIds?.length ? normalizeIds(options.productIds) : [];
  if (Object.keys(staged).some(id => productIds.length && !productIds.includes(Number(id)))) fail("Staged products must be in the audit scope.");
  const normalized = { platforms, staged, productIds, incoming: Boolean(options.incoming), vendorGroup: auditVendorGroup(options) };
  const [result] = await getPool().query(`INSERT INTO product_sync_audits (status, options_json, created_by, created_at) VALUES ('running', ?, ?, UTC_TIMESTAMP())`, [JSON.stringify(normalized), user.userId || user.adminId || null]);
  const id = Number(result.insertId);
  // Work survives navigation. All progress and results are stored centrally.
  void runProductSyncAudit(id, normalized, user.userId || user.adminId).catch(async error => {
    await getPool().query("UPDATE product_sync_audits SET status='failed', error_message=?, finished_at=UTC_TIMESTAMP() WHERE id=?", [error.message, id]);
  }).catch(error => console.error("Product sync audit persistence failed:", error.message));
  return { id, status: "running" };
}
async function runProductSyncAudit(id, options, userId) {
  const catalog = await syncCatalog();
  const products = auditProducts(catalog, options);
  const scopedIds = products.map(row => Number(row.id));
  const productSet = new Set(products.map(row => Number(row.id)));
  if (Object.keys(options.staged).some(productId => !productSet.has(Number(productId)))) fail("A staged product is outside the audit scope. Check the vendor selection; missing, deleted, and Membership products cannot be audited.");
  const snapshots = new Map();
  const save = async action => {
    if ((action.direction === "outgoing" || options.vendorGroup === "deck-enterprises") && !productSet.has(Number(action.productId))) return;
    if (action.direction === "outgoing" && productSet.has(action.productId)) {
      if (!snapshots.has(action.productId)) snapshots.set(action.productId, await loadCurrentSnapshot(getPool(), action.productId));
      action.localSnapshot = snapshots.get(action.productId);
      if (action.status === "synced" && Object.keys(action.staged || {}).length) action.status = "changed";
    }
    await storeAction(id, action);
  };
  const errors = [];
  for (const platform of options.platforms) {
    try {
      if (platform === "square") {
        if (!scopedIds.length) continue;
        await syncSquareCatalogCache({ userId });
        await getPool().query("UPDATE product_sync_audits SET square_refreshed_at=UTC_TIMESTAMP(), progress_at=UTC_TIMESTAMP() WHERE id=?", [id]);
        for (const action of await prepareSquareActions({ ...options, productIds: scopedIds, includeAllProducts: true })) await save(action);
        const matches = await buildSquareMatchReview({ includeAllProducts: true, productIds: scopedIds });
        for (const row of matches.rows || []) {
          if (row.linked || !productSet.has(Number(row.productId))) continue;
          await save({ direction: "outgoing", platform, kind: "unmatched", productId: Number(row.productId), productName: row.productName, packageId: row.packageId, packageName: row.packageName, vendorName: row.vendorName, status: "blocked", message: "Approve a Square variation match in Product Matches, then audit again." });
        }
      } else {
        let nextIndex = 0;
        await Promise.all(Array.from({ length: Math.min(4, products.length) }, async () => {
          while (nextIndex < products.length) {
            const product = products[nextIndex++];
            try { await save(await prepareLocalLineAction(product, options.staged[product.id] || {}, { onRefresh: () => getPool().query("UPDATE product_sync_audits SET localline_refreshed_at=UTC_TIMESTAMP(), progress_at=UTC_TIMESTAMP() WHERE id=?", [id]) })); }
            catch (error) { await save({ direction: "outgoing", platform, kind: "error", productId: Number(product.id), productName: product.name, vendorName: product.vendorName, status: "blocked", message: error.message }); }
          }
        }));
        const incomingIds = options.vendorGroup === "deck-enterprises" ? scopedIds : options.productIds;
        if (options.incoming && (options.vendorGroup === "all" || incomingIds.length)) {
          for (const action of await prepareIncomingActions(catalog, incomingIds)) await save(action);
        }
      }
    } catch (error) { errors.push(`${PLATFORM_LABEL[platform]}: ${error.message}`); }
  }
  const [counts] = await getPool().query("SELECT platform, direction, status, COUNT(*) AS count FROM product_sync_actions WHERE audit_id=? GROUP BY platform, direction, status", [id]);
  await getPool().query("UPDATE product_sync_audits SET status=?, summary_json=?, error_message=?, finished_at=UTC_TIMESTAMP() WHERE id=?", [errors.length ? "partial" : "completed", JSON.stringify(counts), errors.join(" ") || null, id]);
}
export async function getProductSyncAudit(id) {
  await ensureProductSyncSchema();
  await getPool().query("UPDATE product_sync_audits SET status='failed', error_message='Audit was interrupted. Run a new audit.', finished_at=UTC_TIMESTAMP() WHERE status='running' AND COALESCE(progress_at, created_at)<UTC_TIMESTAMP()-INTERVAL 1 HOUR");
  const [rows] = await getPool().query(`SELECT id, status, options_json, summary_json, error_message,
    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdUtc, DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS finishedUtc
    FROM product_sync_audits ${id === "latest" ? "ORDER BY id DESC LIMIT 1" : "WHERE id=?"}`, id === "latest" ? [] : [id]);
  if (!rows.length) return null;
  const row = rows[0];
  return { id: row.id, status: row.status, options: parseJson(row.options_json), summary: parseJson(row.summary_json, []), error: row.error_message, createdAt: isoUtc(row.createdUtc), finishedAt: isoUtc(row.finishedUtc) };
}
export function actionFilter(auditId, filters = {}) {
  const params = [auditId];
  const where = ["audit_id=?"];
  for (const [input, column, values] of [["direction", "direction", ["incoming", "outgoing"]], ["platform", "platform", ["localline", "square"]], ["status", "status", ["changed", "synced", "blocked", "review", "applied", "held"]]]) {
    if (values.includes(filters[input])) { where.push(`${column}=?`); params.push(filters[input]); }
  }
  if (filters.vendor) { where.push("vendor_name=?"); params.push(filters.vendor); }
  if (filters.search) { where.push("(product_name LIKE ? OR vendor_name LIKE ? OR product_id=?)"); params.push(`%${filters.search}%`, `%${filters.search}%`, Number(filters.search) || 0); }
  return { sql: where.join(" AND "), params };
}
export async function listProductSyncActions(id, filters, idsOnly = false, roles = []) {
  await ensureProductSyncSchema();
  const { sql, params } = actionFilter(id, filters);
  if (idsOnly) {
    const [rows] = await getPool().query(`SELECT id, platform, direction FROM product_sync_actions WHERE ${sql} AND status='changed' AND released_at IS NULL ORDER BY id`, params);
    return { ids: rows.filter(row => hasGrant(roles, row.direction === "incoming" ? "localline_pull" : `${row.platform}_push`)).map(row => Number(row.id)) };
  }
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(filters.pageSize) || 30)));
  const [counts] = await getPool().query(`SELECT COUNT(*) AS count FROM product_sync_actions WHERE ${sql}`, params);
  // Paginate by product so Local Line and Square actions for a product stay together.
  const [productRows] = await getPool().query(`SELECT product_id, MIN(product_name) AS name FROM product_sync_actions WHERE ${sql} GROUP BY product_id ORDER BY name, product_id LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const productIds = productRows.map(row => row.product_id);
  const [rows] = productIds.length ? await getPool().query(`SELECT * FROM product_sync_actions WHERE ${sql} AND product_id IN (?) ORDER BY product_name, product_id, platform, id`, [...params, productIds]) : [[]];
  const [productCount] = await getPool().query(`SELECT COUNT(DISTINCT product_id) AS count FROM product_sync_actions WHERE ${sql}`, params);
  const [vendors] = await getPool().query("SELECT DISTINCT vendor_name AS name FROM product_sync_actions WHERE audit_id=? AND vendor_name<>'' ORDER BY vendor_name", [id]);
  return { rows: rows.map(actionFromRow), total: Number(counts[0].count), productCount: Number(productCount[0].count), page, pageSize, vendors: vendors.map(row => row.name) };
}
export async function selectedActions(auditId, ids, connection = getPool(), lock = false) {
  const clean = normalizeIds(ids);
  const [rows] = await connection.query(`SELECT * FROM product_sync_actions WHERE audit_id=? AND id IN (?) ${lock ? "FOR UPDATE" : ""}`, [auditId, clean]);
  if (rows.length !== clean.length) fail("Some selected actions do not belong to this audit.");
  return rows.map(actionFromRow);
}
export async function createProductSyncRelease(body, user) {
  await ensureProductSyncSchema();
  const scheduledAt = releaseTime(body.scheduledAt);
  return withSyncLock("csa-store:product-sync-approval", async connection => {
    await connection.beginTransaction();
    try {
      const audit = await getProductSyncAudit(body.auditId);
      if (!audit || !["completed", "partial"].includes(audit.status)) fail("Wait for the audit to finish before approving actions.");
      const actions = await selectedActions(body.auditId, body.actionIds, connection, true);
      authorizeRelease(user.adminRoles || [], actions, Boolean(scheduledAt));
      if (actions.some(action => action.status !== "changed" || action.released)) fail("Only eligible, unreleased actions can be approved. Audit again for new changes.");
      const productIds = [...new Set(actions.map(action => action.productId))];
      // Serialize against other approvals and legacy releases; no product can have conflicting staged plans.
      await connection.query("SELECT id FROM products WHERE id IN (?) FOR UPDATE", [productIds]);
      const [conflicts] = await connection.query(`SELECT DISTINCT a.product_name FROM product_sync_release_actions ra
        JOIN product_sync_actions a ON a.id=ra.action_id JOIN product_sync_releases r ON r.id=ra.release_id
        WHERE a.product_id IN (?) AND r.status <> 'cancelled' AND ra.status IN ('pending','working','failed','held')`, [productIds]);
      const [legacy] = await connection.query(`SELECT i.product_name FROM pricelist_change_items i JOIN pricelist_change_batches b ON b.id=i.batch_id
        WHERE i.product_id IN (?) AND b.status IN ('scheduled','running') AND i.status IN ('pending','local_applied')`, [productIds]);
      if (conflicts.length || legacy.length) fail(`${conflicts[0]?.product_name || legacy[0]?.product_name} already has unfinished release actions. Resolve or review that release first.`, 409);
      const [result] = await connection.query(`INSERT INTO product_sync_releases (audit_id, name, status, scheduled_at, is_scheduled, created_by, created_at)
        VALUES (?, ?, 'scheduled', ?, ?, ?, UTC_TIMESTAMP())`, [body.auditId, String(body.name || "Product release").slice(0, 255), scheduledAt || utcNow(), Number(Boolean(scheduledAt)), user.userId || user.adminId || null]);
      const releaseId = Number(result.insertId);
      for (const productId of productIds) {
        const productActions = actions.filter(action => action.productId === productId);
        const first = productActions[0];
        if (productActions.some(action => !same(action.staged || {}, first.staged || {}) || !same(action.localSnapshot, first.localSnapshot))) fail("Selected actions have different staged changes; audit again.");
        await connection.query("INSERT INTO product_sync_release_products (release_id, product_id, staged_json, original_json) VALUES (?, ?, ?, ?)", [releaseId, productId, JSON.stringify(first.staged || {}), JSON.stringify(first.localSnapshot)]);
      }
      for (const action of actions) {
        await connection.query("INSERT INTO product_sync_release_actions (release_id, action_id) VALUES (?, ?)", [releaseId, action.id]);
        await connection.query("UPDATE product_sync_actions SET released_at=UTC_TIMESTAMP() WHERE id=?", [action.id]);
      }
      await connection.commit();
      return { id: releaseId, scheduled: Boolean(scheduledAt) };
    } catch (error) { await connection.rollback(); throw error; }
  });
}
export async function getProductSyncRelease(id) {
  await ensureProductSyncSchema();
  const [rows] = await getPool().query(`SELECT *, DATE_FORMAT(scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledUtc,
    DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS startedUtc, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdUtc
    FROM product_sync_releases WHERE id=?`, [id]);
  if (!rows.length) fail("Release not found.", 404);
  const [actions] = await getPool().query(`SELECT a.*, ra.id AS releaseActionId, ra.status AS releaseStatus, ra.message AS releaseMessage,
    ra.checkpoint_json FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id WHERE ra.release_id=? ORDER BY a.product_id, a.platform, a.id`, [id]);
  const row = rows[0];
  return { id: row.id, auditId: row.audit_id, name: row.name, status: row.status, isScheduled: Boolean(row.is_scheduled), scheduledAt: isoUtc(row.scheduledUtc), startedAt: isoUtc(row.startedUtc), createdAt: isoUtc(row.createdUtc),
    actions: actions.map(a => ({ ...actionFromRow(a), releaseActionId: a.releaseActionId, status: a.releaseStatus, message: a.releaseMessage, checkpoint: parseJson(a.checkpoint_json, {}) })) };
}
export async function listProductSyncReleases() {
  await ensureProductSyncSchema();
  const [rows] = await getPool().query(`SELECT id, audit_id, name, status, is_scheduled,
    DATE_FORMAT(scheduled_at, '%Y-%m-%d %H:%i:%s') AS scheduledUtc,
    DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS startedUtc
    FROM product_sync_releases ORDER BY scheduled_at DESC, id DESC LIMIT 50`);
  const [actions] = rows.length ? await getPool().query(`SELECT ra.release_id AS releaseId, a.id, a.product_id AS productId,
    a.product_name AS productName, a.platform, ra.status, ra.message,
    JSON_UNQUOTE(JSON_EXTRACT(a.data_json, '$.packageName')) AS packageName,
    JSON_UNQUOTE(JSON_EXTRACT(ra.checkpoint_json, '$.remoteId')) AS remoteId
    FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id
    WHERE ra.release_id IN (?) ORDER BY a.product_name, a.platform, a.id`, [rows.map(row => row.id)]) : [[]];
  const releases = rows.map(row => ({ id: row.id, auditId: row.audit_id, name: row.name, status: row.status,
    isScheduled: Boolean(row.is_scheduled), scheduledAt: isoUtc(row.scheduledUtc), startedAt: isoUtc(row.startedUtc),
    actions: actions.filter(action => action.releaseId === row.id).map(action => ({ ...action, checkpoint: action.remoteId ? { remoteId: action.remoteId } : {} })) }));
  const legacy = await listScheduledPricelistBatches({ limit: 50 });
  return { releases, legacy: Array.isArray(legacy) ? legacy : legacy.batches || [] };
}
export async function runProductSyncRelease(id, { user = null, allowFuture = false } = {}) {
  await ensureProductSyncSchema();
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => runReleaseLocked(id, connection, { user, allowFuture }));
}
async function runReleaseLocked(id, connection, { user, allowFuture }) {
  const release = await getProductSyncRelease(id);
  if (user) authorizeRelease(user.adminRoles || [], release.actions.filter(action => !["completed", "cancelled"].includes(action.status)), release.isScheduled);
  if (release.status === "cancelled") fail("This release was cancelled.");
  if (!allowFuture && Date.parse(release.scheduledAt) > Date.now()) fail("Release is not due yet.");
  if (release.status === "completed") return release;
  await connection.query("UPDATE product_sync_releases SET status='running', started_at=COALESCE(started_at, UTC_TIMESTAMP()), finished_at=NULL WHERE id=?", [id]);
  const [products] = await connection.query("SELECT * FROM product_sync_release_products WHERE release_id=? ORDER BY product_id", [id]);
  for (const product of products) {
    let applied = Boolean(product.local_applied_at);
    const changes = parseJson(product.staged_json, {});
    const original = parseJson(product.original_json, {});
    const actions = release.actions.filter(action => action.productId === Number(product.product_id));
    await executeProductActions(actions, {
      inspect: action => inspectAction(action, async checkpoint => {
        await connection.query("UPDATE product_sync_release_actions SET checkpoint_json=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(checkpoint), action.releaseActionId]);
        action.checkpoint = structuredClone(checkpoint);
      }),
      isLocalApplied: async () => applied,
      applyLocalOnce: async () => {
        if (applied) return;
        await connection.beginTransaction();
        try {
          await connection.query("SELECT id FROM products WHERE id=? FOR UPDATE", [product.product_id]);
          const current = await loadCurrentSnapshot(connection, product.product_id);
          if (Object.keys(changes).some(key => !same(current[key], original[key]))) throw new Error("Staged local fields changed. Audit and approve again.");
          if (Object.keys(changes).length) {
            const completeChanges = { ...changes };
            if (Object.hasOwn(changes, "onSale") || Object.hasOwn(changes, "saleDiscount")) {
              completeChanges.onSale = changes.onSale ?? current.onSale;
              completeChanges.saleDiscount = changes.saleDiscount ?? current.saleDiscount;
            }
            await applyLocalChanges(connection, product.product_id, completeChanges);
          }
          await connection.query("UPDATE product_sync_release_products SET local_applied_at=UTC_TIMESTAMP() WHERE release_id=? AND product_id=?", [id, product.product_id]);
          await connection.commit();
          applied = true;
        } catch (error) { await connection.rollback(); throw error; }
      },
      save: async (action, result) => {
        await connection.query(`UPDATE product_sync_release_actions SET status=?, message=?, updated_at=UTC_TIMESTAMP(), completed_at=IF(?='completed', UTC_TIMESTAMP(), completed_at) WHERE id=?`, [result.status, result.message, result.status, action.releaseActionId]);
        action.status = result.status;
        if (result.status === "completed" && action.platform === "localline") await connection.query("UPDATE product_pricing_profiles SET remote_sync_status='synced', remote_sync_message=?, remote_synced_at=UTC_TIMESTAMP() WHERE product_id=?", [result.message, action.productId]);
      },
      execute: async (action, current) => executeAction(action, current, async checkpoint => {
        await connection.query("UPDATE product_sync_release_actions SET checkpoint_json=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(checkpoint), action.releaseActionId]);
        action.checkpoint = structuredClone(checkpoint);
      })
    });
  }
  const status = releaseStatus(release.actions);
  await connection.query("UPDATE product_sync_releases SET status=?, finished_at=UTC_TIMESTAMP() WHERE id=?", [status, id]);
  return getProductSyncRelease(id);
}
export async function runDueProductSyncReleases({ lockConnection = null } = {}) {
  await ensureProductSyncSchema();
  const [rows] = await getPool().query("SELECT id FROM product_sync_releases WHERE status IN ('scheduled','running') AND scheduled_at <= UTC_TIMESTAMP() ORDER BY scheduled_at, id");
  const results = [];
  for (const row of rows) {
    try { results.push(lockConnection ? await runReleaseLocked(row.id, lockConnection, { user: null, allowFuture: false }) : await runProductSyncRelease(row.id)); }
    catch (error) { results.push({ id: row.id, error: error.message }); }
  }
  return results;
}
export async function cancelProductSyncRelease(id, user) {
  await ensureProductSyncSchema();
  if (!hasGrant(user.adminRoles || [], "pricing_admin")) fail("Cancelling releases requires Pricing Admin.", 403);
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    await connection.beginTransaction();
    try {
      const [result] = await connection.query("UPDATE product_sync_releases SET status='cancelled', finished_at=UTC_TIMESTAMP() WHERE id=? AND started_at IS NULL AND status='scheduled'", [id]);
      if (!result.affectedRows) fail("Only unstarted releases can be cancelled.");
      await connection.query("UPDATE product_sync_release_actions SET status='cancelled' WHERE release_id=?", [id]);
      await connection.commit();
      return getProductSyncRelease(id);
    } catch (error) { await connection.rollback(); throw error; }
  });
}
export async function reviewProductSyncRelease(id, user) {
  // Abandon only held/failed actions, preserving successful results; the replacement audit needs fresh approval.
  const release = await getProductSyncRelease(id);
  authorizeRelease(user.adminRoles || [], release.actions.filter(action => ["held", "failed"].includes(action.status)), release.isScheduled);
  await withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    if (["scheduled", "running"].includes(release.status)) fail("Wait for this release to finish, or cancel it before auditing again.");
    await connection.query("UPDATE product_sync_release_actions SET status='cancelled', message='Superseded by a new review.' WHERE release_id=? AND status IN ('held','failed')", [id]);
  });
  const unfinished = release.actions.filter(action => ["held", "failed"].includes(action.status));
  if (!unfinished.length) fail("No unfinished actions need review.");
  const [products] = await getPool().query("SELECT * FROM product_sync_release_products WHERE release_id=?", [id]);
  return createProductSyncAudit({ platforms: [...new Set(unfinished.map(action => action.platform))], productIds: [...new Set(unfinished.map(action => action.productId))], includeAllProducts: true,
    staged: products.filter(product => unfinished.some(action => action.productId === Number(product.product_id)) && !product.local_applied_at && Object.keys(parseJson(product.staged_json, {})).length).map(product => ({ productId: product.product_id, changes: parseJson(product.staged_json) })) }, user);
}
export async function applyProductSyncIncoming(body, user) {
  await ensureProductSyncSchema();
  if (!hasGrant(user.adminRoles || [], "localline_pull")) fail("Incoming repairs require Local Line Pull.", 403);
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    const actions = await selectedActions(body.auditId, body.actionIds);
    if (actions.some(action => action.direction !== "incoming" || action.status !== "changed")) fail("Select eligible incoming repairs.");
    const fresh = await prepareIncomingActions(await syncCatalog(), [...new Set(actions.map(action => action.productId))]);
    const hashes = new Set(fresh.filter(action => action.status === "changed").map(action => action.proposalHash));
    const results = [];
    for (const action of actions) {
      const result = await applyIncomingAction(action, hashes, connection);
      if (result.status !== "applied") await connection.query("UPDATE product_sync_actions SET status=?, result_json=? WHERE id=?", [result.status, JSON.stringify(result), action.id]);
      results.push({ id: action.id, ...result });
    }
    return { results };
  });
}
export async function pendingProductSync(options = {}) {
  await ensureProductSyncSchema();
  const [rows] = await getPool().query(`SELECT p.id, p.name, v.name AS vendorName, c.name AS categoryName,
    lm.local_line_product_id AS localLineProductId
    FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id
    WHERE COALESCE(p.is_deleted, 0)=0 AND ${PRICELIST_PENDING_REMOTE_APPLY_SQL} ORDER BY p.name, p.id`);
  return { rows: auditProducts(rows, options).map(row => ({ productId: Number(row.id), productName: row.name,
    vendorName: row.vendorName || "", kind: Number(row.localLineProductId) > 0 ? "update" : "create" })) };
}
export async function productSyncStatus() {
  await ensureProductSyncSchema();
  const [counts] = await getPool().query(`SELECT a.platform,
    SUM(ra.status IN ('pending','working')) AS pending, SUM(ra.status IN ('failed','held')) AS failed,
    DATE_FORMAT(MAX(ra.completed_at), '%Y-%m-%d %H:%i:%s') AS lastPush
    FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id GROUP BY a.platform`);
  const [refreshes] = await getPool().query(`SELECT 'localline' AS platform, DATE_FORMAT(MAX(localline_refreshed_at), '%Y-%m-%d %H:%i:%s') AS lastRefresh FROM product_sync_audits
    UNION ALL SELECT 'square' AS platform, DATE_FORMAT(MAX(square_refreshed_at), '%Y-%m-%d %H:%i:%s') AS lastRefresh FROM product_sync_audits`);
  const [earlierPushes] = await getPool().query(`SELECT 'localline' AS platform, DATE_FORMAT(MAX(remote_synced_at), '%Y-%m-%d %H:%i:%s') AS lastPush,
    (SELECT DATE_FORMAT(MAX(last_synced_at), '%Y-%m-%d %H:%i:%s') FROM local_line_product_meta) AS lastRefresh FROM product_pricing_profiles
    UNION ALL SELECT 'square' AS platform, DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i:%s') AS lastPush,
    (SELECT DATE_FORMAT(MAX(finished_at), '%Y-%m-%d %H:%i:%s') FROM square_sync_runs WHERE mode='cache-sync' AND status='complete') AS lastRefresh
    FROM square_sync_runs r JOIN square_sync_results sr ON sr.sync_run_id=r.id WHERE r.mode='apply-prices' AND sr.status='updated'`);
  return { platforms: ["localline", "square"].map(platform => {
    const row = counts.find(row => row.platform === platform) || {};
    return { platform, label: PLATFORM_LABEL[platform], enabled: platform === "square" ? isSquareEnabled() : isLocalLineEnabled(), pending: Number(row.pending || 0), failed: Number(row.failed || 0), lastPush: isoUtc([row.lastPush, earlierPushes.find(item => item.platform === platform)?.lastPush].filter(Boolean).sort().at(-1)), lastRefresh: isoUtc([refreshes.find(row => row.platform === platform)?.lastRefresh, earlierPushes.find(row => row.platform === platform)?.lastRefresh].filter(Boolean).sort().at(-1)) };
  }) };
}
