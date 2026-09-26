import { getLocalLineAccessToken } from "../localLineAuth.js";
import { isLocalLineEnabled, patchLocalLineProduct, fetchLocalLineProduct } from "../localLine.js";
import { ensureProductSyncSchema, withSyncLock } from "./productSyncSchema.js";
import { fail, hasGrant, normalizeIds } from "./productSyncCore.js";

export function inventoryChanges(changes = {}) {
  const keys = Object.keys(changes);
  if (!keys.length || keys.some(key => !["inventory", "trackInventory", "visible"].includes(key))) fail("Inventory saves accept stock, inventory tracking, and visibility only.");
  const result = {};
  for (const key of keys) {
    const value = changes[key];
    if (value === null || value === "" || !["number", "boolean"].includes(typeof value)) fail(`Invalid ${key}.`);
    const number = Number(value);
    if (key === "inventory" && (typeof value !== "number" || !Number.isInteger(number) || number < 0 || number > 2147483647)) fail("Stock must be a nonnegative whole number.");
    if (["trackInventory", "visible"].includes(key) && ![0, 1].includes(number)) fail("Inventory tracking and visibility must be on or off.");
    result[key] = number;
  }
  return result;
}

export async function saveInventoryToLocalLine(productId, input, user) {
  const [id] = normalizeIds([productId]);
  const changes = inventoryChanges(input);
  const roles = user.adminRoles || [];
  if (!hasGrant(roles, "localline_push") || !["inventory_admin", "pricing_admin", "local_pricelist_admin"].some(role => hasGrant(roles, role))) fail("Saving inventory requires product editing and Local Line Push permissions.", 403);
  if (!isLocalLineEnabled() || process.env.LOCALLINE_TEST === "true") fail("Local Line inventory publishing is not enabled.");
  await ensureProductSyncSchema();
  // Serialize with product publications, preserving their existing frozen approvals.
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    await connection.beginTransaction();
    try {
      const [[product]] = await connection.query(`SELECT p.id, p.is_deleted, c.name AS categoryName, lm.local_line_product_id AS remoteId
        FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id
        WHERE p.id=? FOR UPDATE`, [id]);
      if (!product || product.is_deleted || product.categoryName?.trim().toLowerCase() === "membership") fail("This product is not available in Inventory.");
      if (!(Number(product.remoteId) > 0)) fail("Create and link this product through Product Sync before updating its Local Line inventory.");
      const payload = {};
      if (Object.hasOwn(changes, "inventory")) payload.set_inventory = changes.inventory;
      if (Object.hasOwn(changes, "trackInventory")) payload.track_inventory = Boolean(changes.trackInventory);
      if (Object.hasOwn(changes, "visible")) payload.visible = Boolean(changes.visible);
      const token = await getLocalLineAccessToken();
      await patchLocalLineProduct(Number(product.remoteId), token, payload);
      const remote = await fetchLocalLineProduct(Number(product.remoteId), token);
      if ((Object.hasOwn(changes, "inventory") && (remote.inventory == null || Number(remote.inventory) !== changes.inventory)) ||
        (Object.hasOwn(changes, "trackInventory") && remote.track_inventory !== Boolean(changes.trackInventory)) ||
        (Object.hasOwn(changes, "visible") && remote.visible !== Boolean(changes.visible))) {
        fail("Local Line did not confirm the requested inventory. Check its stock before retrying; local inventory was not changed.");
      }
      const columns = { inventory: "inventory", trackInventory: "track_inventory", visible: "visible" };
      await connection.query(`UPDATE products SET ${Object.keys(changes).map(key => `${columns[key]}=?`).join(", ")}, updated_at=UTC_TIMESTAMP() WHERE id=?`, [...Object.values(changes), id]);
      // Pricing profiles, sales, images, and their pending flags are deliberately untouched.
      await connection.query(`UPDATE local_line_product_meta SET product_inventory=?, track_inventory=?, visible=?, raw_json=?, last_synced_at=UTC_TIMESTAMP() WHERE product_id=?`, [remote.inventory ?? null, Number(Boolean(remote.track_inventory)), Number(Boolean(remote.visible)), JSON.stringify(remote), id]);
      await connection.commit();
      return { ok: true, productId: id, localLineUpdate: true, savedFields: Object.keys(changes) };
    } catch (error) { await connection.rollback(); throw error; }
  });
}
