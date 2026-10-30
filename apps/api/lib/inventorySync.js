import { getPool } from "../db.js";
import { getLocalLineAccessToken } from "../localLineAuth.js";
import { isLocalLineEnabled, patchLocalLineProduct, fetchLocalLineProduct, resolveLocalLineVendor } from "../localLine.js";
import { validateSavedProductVendor, confirmLocalLineVendor } from "./productVendor.js";
import { ensureProductSyncSchema, withSyncLock } from "./productSyncSchema.js";
import { fail, normalizeIds } from "./productSyncCore.js";
import { canPublishInventory } from "./adminRoles.js";

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

export async function saveInventoryToLocalLine(productId, input, user, expected = null) {
  const [id] = normalizeIds([productId]);
  const changes = inventoryChanges(input);
  const roles = user.adminRoles || [];
  if (!canPublishInventory(roles)) fail("Saving inventory requires Inventory Admin, or product editing and Local Line Push permissions.", 403);
  if (!isLocalLineEnabled() || process.env.LOCALLINE_TEST === "true") fail("Local Line inventory publishing is not enabled.");
  await ensureProductSyncSchema();
  // Serialize with product publications, preserving their existing frozen approvals.
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    await connection.beginTransaction();
    try {
      const [[product]] = await connection.query(`SELECT p.id, p.inventory, p.track_inventory, p.is_deleted, c.name AS categoryName, lm.local_line_product_id AS remoteId
        FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id
        WHERE p.id=? FOR UPDATE`, [id]);
      if (!product || product.is_deleted || product.categoryName?.trim().toLowerCase() === "membership") fail("This product is not available in Inventory.");
      if (!(Number(product.remoteId) > 0)) fail("Create and link this product through Product Sync before updating its Local Line inventory.");
      const vendor = await validateSavedProductVendor(connection, id);
      const payload = {};
      if (Object.hasOwn(changes, "inventory")) payload.set_inventory = changes.inventory;
      if (Object.hasOwn(changes, "trackInventory")) payload.track_inventory = Boolean(changes.trackInventory);
      if (Object.hasOwn(changes, "visible")) payload.visible = Boolean(changes.visible);
      const token = await getLocalLineAccessToken();
      const vendorId = await resolveLocalLineVendor({ product: { vendorId: vendor.id }, vendor }, token);
      // Inventory never changes vendors; repair a mismatch through a reviewed Product Sync action.
      const before=await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(before, vendorId);
      if(Object.hasOwn(changes,'inventory')) {
        const baseline=expected || {inventory:product.inventory,trackInventory:Boolean(product.track_inventory)};
        const conflict=inventoryConflict(before,baseline);
        if(conflict) {
          await connection.query('UPDATE products SET inventory=?,track_inventory=? WHERE id=?',[conflict.inventory,Number(conflict.trackInventory),id]);
          await connection.commit();
          throw Object.assign(new Error(`FF inventory changed in Local Line from ${baseline.inventory ?? 'unknown'} to ${conflict.inventory ?? 'unknown'}. No update was sent. Review the current stock before trying again.`),{status:409,inventoryConflict:conflict});
        }
        if(!before.track_inventory && changes.trackInventory!==1) fail('Full Farm inventory tracking is off. Refresh before editing stock.',409);
      }
      await patchLocalLineProduct(Number(product.remoteId), token, payload);
      const remote = await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(remote, vendorId);
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
      return { ok: true, productId: id, localLineUpdate: true, savedFields: Object.keys(changes), currentInventory: remoteInventory(remote) };
    } catch (error) { await connection.rollback(); throw error; }
  });
}


export function remoteInventory(remote) {
  const quantity=remote?.inventory;
  if(quantity!==null && quantity!==undefined && (!Number.isSafeInteger(Number(quantity))||Number(quantity)<0)) fail('Local Line returned an invalid inventory count.');
  if(typeof remote?.track_inventory!=='boolean') fail('Local Line did not return inventory tracking status.');
  return {inventory:quantity==null?null:Number(quantity),trackInventory:remote.track_inventory,checkedAt:new Date().toISOString()};
}
export function inventoryConflict(remote,expected) {
  const current=remoteInventory(remote);
  if(!expected || !Object.hasOwn(expected,'inventory') || typeof expected.trackInventory!=='boolean' ||
    (expected.inventory!==null&&(!Number.isSafeInteger(expected.inventory)||expected.inventory<0))) fail('Refresh FF inventory before editing its quantity.',428);
  return current.inventory!==expected.inventory||current.trackInventory!==expected.trackInventory ? current : null;
}
export async function refreshFullFarmInventory(productIds) {
  const ids=normalizeIds(productIds);
  if(!ids.length||ids.length>100) fail('Select between 1 and 100 products.');
  if(process.env.CSA_LOCAL_ONLY==='true'||!isLocalLineEnabled()||process.env.LOCALLINE_TEST==='true') fail('Local Line inventory checks are not enabled.');
  const token=await getLocalLineAccessToken();
  const rows=[];let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(cursor<ids.length) {
      const id=ids[cursor++], db=await getPool().getConnection();
      try {
        await db.beginTransaction();
        const [[p]]=await db.query(`SELECT p.id,p.is_deleted,c.name AS categoryName,m.local_line_product_id AS remoteId
          FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN local_line_product_meta m ON m.product_id=p.id WHERE p.id=? FOR UPDATE`,[id]);
        if(!p||p.is_deleted||p.categoryName?.toLowerCase()==='membership'||!p.remoteId) fail('Link this product to Local Line before checking inventory.');
        const vendor=await validateSavedProductVendor(db,id);
        const vendorId=await resolveLocalLineVendor({product:{vendorId:vendor.id},vendor},token);
        const remote=await fetchLocalLineProduct(Number(p.remoteId),token);confirmLocalLineVendor(remote,vendorId);
        const current=remoteInventory(remote);
        await db.query('UPDATE products SET inventory=?,track_inventory=? WHERE id=?',[current.inventory,Number(current.trackInventory),id]);
        await db.commit();rows.push({productId:id,...current});
      }catch(e){await db.rollback();rows.push({productId:id,error:e.message});}finally{db.release();}
    }
  }));
  return {rows};
}
