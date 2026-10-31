import { remoteInventory, inventoryConflict, stockPayload } from "./inventorySnapshot.js";
export { remoteInventory, inventoryConflict } from "./inventorySnapshot.js";
import { getPool } from "../db.js";
import { getLocalLineAccessToken } from "../localLineAuth.js";
import { isLocalLineEnabled, patchLocalLineProduct, fetchLocalLineProduct, resolveLocalLineVendor } from "../localLine.js";
import { validateSavedProductVendor, confirmLocalLineVendor } from "./productVendor.js";
import { ensureProductSyncSchema, withSyncLock } from "./productSyncSchema.js";
import { fail, normalizeIds } from "./productSyncCore.js";
import { canPublishInventory } from "./adminRoles.js";

export function inventoryChanges(changes = {}) {
  const keys = Object.keys(changes);
  if (!keys.length || keys.some(key => !["inventory", "packageInventory", "trackInventory", "visible"].includes(key))) fail("Inventory saves accept stock, inventory tracking, and visibility only.");
  const result = {};
  for (const key of keys) {
    const value = changes[key];
    if(key==='packageInventory'){
      if(Object.hasOwn(changes,'inventory')||!Array.isArray(value)||!value.length||value.length>100)fail('Choose individual package quantities, not a product total.');
      const ids=new Set();
      result[key]=value.map(row=>{if(!Number.isSafeInteger(row.packageId)||row.packageId<=0||ids.has(row.packageId)||!Number.isInteger(row.inventory)||row.inventory<0||row.inventory>2147483647)fail('Invalid package inventory.');ids.add(row.packageId);return {packageId:row.packageId,inventory:row.inventory};});
      continue;
    }
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

      if (Object.hasOwn(changes, "trackInventory")) payload.track_inventory = Boolean(changes.trackInventory);
      if (Object.hasOwn(changes, "visible")) payload.visible = Boolean(changes.visible);
      const token = await getLocalLineAccessToken();
      const vendorId = await resolveLocalLineVendor({ product: { vendorId: vendor.id }, vendor }, token);
      // Inventory never changes vendors; repair a mismatch through a reviewed Product Sync action.
      const before=await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(before, vendorId);
      const [mappings]=await connection.query('SELECT package_id AS packageId,local_line_package_id AS remoteId FROM local_line_package_meta WHERE product_id=?',[id]);
      if(Object.hasOwn(changes,'inventory')||changes.packageInventory) {
        const baseline=expected || {inventory:product.inventory,trackInventory:Boolean(product.track_inventory)};
        const {payload:stock,conflict}=stockPayload(before,changes,baseline,mappings);
        if(conflict){
          await cacheInventory(connection,id,before,mappings);await connection.commit();
          throw Object.assign(new Error('FF inventory or package mapping changed in Local Line. No update was sent. Review current stock before trying again.'),{status:409,inventoryConflict:conflict});
        }
        Object.assign(payload,stock);
      }
      await patchLocalLineProduct(Number(product.remoteId), token, payload);
      const remote = await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(remote, vendorId);
      if ((Object.hasOwn(changes, "inventory") && (remote.inventory == null || Number(remote.inventory) !== changes.inventory)) ||
        (Object.hasOwn(changes, "trackInventory") && remote.track_inventory !== Boolean(changes.trackInventory)) ||
        (Object.hasOwn(changes, "visible") && remote.visible !== Boolean(changes.visible))) {
        fail("Local Line did not confirm the requested inventory. Check its stock before retrying; local inventory was not changed.");
      }
      const current=remoteInventory(remote,mappings);
      if((before.inventory_type||'product')!==(remote.inventory_type||'product') || changes.packageInventory?.some(target=>!current.packages?.some(p=>p.packageId===target.packageId&&p.inventory===target.inventory)) ||
        changes.packageInventory&&before.packages.some(p=>!remote.packages?.some(after=>after.id===p.id)))fail('Local Line did not confirm the requested package inventory. Refresh before retrying.');
      const columns = { inventory: "inventory", trackInventory: "track_inventory", visible: "visible" };
      const fields=Object.keys(changes).filter(key=>key!=='packageInventory');
      if(fields.length)await connection.query(`UPDATE products SET ${fields.map(key=>`${columns[key]}=?`).join(', ')}, updated_at=UTC_TIMESTAMP() WHERE id=?`,[...fields.map(k=>changes[k]),id]);
      await cacheInventory(connection,id,remote,mappings);
      await connection.commit();
      return { ok: true, productId: id, localLineUpdate: true, savedFields: Object.keys(changes), currentInventory: current };
    } catch (error) { await connection.rollback(); throw error; }
  });
}


async function cacheInventory(db,id,remote,mappings){
 const current=remoteInventory(remote,mappings);
 // The product-level count remains separate; never replace it with a sum of package counts.
 await db.query('UPDATE products SET inventory=?,track_inventory=? WHERE id=?',[remote.inventory??null,Number(current.trackInventory),id]);
 await db.query('UPDATE local_line_product_meta SET inventory_type=?,product_inventory=?,track_inventory=?,visible=?,raw_json=?,last_synced_at=UTC_TIMESTAMP() WHERE product_id=?',[current.inventoryType||'product',remote.inventory??null,Number(current.trackInventory),Number(Boolean(remote.visible)),JSON.stringify(remote),id]);
 for(const p of current.packages||[]){if(!p.packageId)continue;
  await db.query('UPDATE packages SET inventory=? WHERE id=? AND product_id=?',[p.inventory,p.packageId,id]);
  await db.query('UPDATE local_line_package_meta SET package_inventory=?,last_synced_at=UTC_TIMESTAMP() WHERE package_id=? AND product_id=?',[p.inventory,p.packageId,id]);
 }
 return current;
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
        const [mappings]=await db.query('SELECT package_id AS packageId,local_line_package_id AS remoteId FROM local_line_package_meta WHERE product_id=?',[id]);
        const current=await cacheInventory(db,id,remote,mappings);
        await db.commit();rows.push({productId:id,...current});
      }catch(e){await db.rollback();rows.push({productId:id,error:e.message});}finally{db.release();}
    }
  }));
  return {rows};
}
