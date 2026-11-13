import { remoteInventory, stockPayload } from "./inventorySnapshot.js";
export { remoteInventory, inventoryConflict } from "./inventorySnapshot.js";
import { getPool } from "../db.js";
import { getLocalLineAccessToken } from "../localLineAuth.js";
import { isLocalLineEnabled, patchLocalLineProduct, patchReviewedLocalLineInventory, fetchLocalLineProduct, fetchLocalLineVendors } from "../localLine.js";
import { requireProductVendor, matchLocalLineVendor, confirmLocalLineVendor } from "./productVendor.js";
import { ensureProductSyncSchema, withSyncLock } from "./productSyncSchema.js";
import { fail, normalizeIds } from "./productSyncCore.js";
import { canPublishInventory } from "./adminRoles.js";
import { randomUUID } from 'node:crypto';
import { hash } from './memberFinancialOperations.js';
import { assertInventoryOperationsSchema } from './inventoryOperationsSchema.js';

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

function inventoryRequest(productId, input, user, expected) {
  const [id] = normalizeIds([productId]);
  const changes = inventoryChanges(input);
  const roles = user.adminRoles || [];
  if (!canPublishInventory(roles)) fail("Saving inventory requires Inventory Admin, or product editing and Local Line Push permissions.", 403);
  const quantityEdit = Object.hasOwn(changes,'inventory') || Boolean(changes.packageInventory);
  if (quantityEdit && !expected) fail('Refresh FF inventory before editing its quantity.',428);
  if (!isLocalLineEnabled() || process.env.LOCALLINE_TEST === "true") fail("Local Line inventory publishing is not enabled.");
  return {id,changes,expected,quantityEdit};
}

function inventoryContext() {
  let promise;
  return { remote: () => promise ||= getLocalLineAccessToken().then(async token => ({token,vendors:await fetchLocalLineVendors(token)})) };
}

export async function saveInventoryToLocalLine(productId, input, user, expected = null) {
  const request=inventoryRequest(productId,input,user,expected);
  await ensureProductSyncSchema();
  return withSyncLock("csa-store:scheduled-pricelist-releases", async connection => {
    await assertInventoryOperationsSchema(connection);
    return saveInventoryRequest(request,user,connection,inventoryContext());
  });
}

// Small batches share one vendor read/readiness check and publication lock.
// Each product retains its own transaction, baseline, PATCH and durable receipt.
export async function saveInventoryBatch(items, user) {
  if(!canPublishInventory(user.adminRoles || []))fail('Inventory publishing permission is required.',403);
  if(!Array.isArray(items)||!items.length||items.length>6)fail('Select between 1 and 6 products per inventory save batch.');
  const ids=items.map(item=>Number(item?.productId));
  if(ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length)fail('Inventory batches require unique product IDs.');
  await ensureProductSyncSchema();
  return withSyncLock("csa-store:scheduled-pricelist-releases", async control => {
    await assertInventoryOperationsSchema(control);
    const context=inventoryContext(),rows=new Array(items.length);
    let cursor=0;
    const workerCount=Math.min(3,items.length,getPool().pool.config.connectionLimit || 1);
    const workers=await Promise.allSettled(Array.from({length:workerCount},async(_,worker)=>{
      const connection=worker===0?control:await getPool().getConnection();
      try {
        while(cursor<items.length) {
          const index=cursor++,item=items[index];
          try{rows[index]=await saveInventoryRequest(inventoryRequest(item.productId,item.changes,user,item.expectedInventory),user,connection,context);}
          catch(error){rows[index]={productId:ids[index],ok:false,error:error.message,status:error.status || 400,...(error.inventoryConflict?{inventoryConflict:error.inventoryConflict}:{})};}
        }
      } finally {if(worker!==0)connection.release();}
    }));
    const failed=workers.find(result=>result.status==='rejected');
    if(failed)throw failed.reason;
    return {rows};
  });
}

async function saveInventoryRequest({id,changes,expected,quantityEdit},user,connection,context) {
    await connection.beginTransaction();
    try {
      const [[product]] = await connection.query(`SELECT p.id, p.inventory, p.track_inventory, p.is_deleted, c.name AS categoryName, lm.local_line_product_id AS remoteId, p.vendor_id AS vendorId, v.name AS vendorName
        FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id
        WHERE p.id=? FOR UPDATE OF p, lm`, [id]);
      if (!product || product.is_deleted || product.categoryName?.trim().toLowerCase() === "membership") fail("This product is not available in Inventory.");
      if (!(Number(product.remoteId) > 0)) fail("Create and link this product through Product Sync before updating its Local Line inventory.");
      const vendor = requireProductVendor(product,{id:product.vendorId,name:product.vendorName});
      let payload = {};

      if (Object.hasOwn(changes, "trackInventory")) payload.track_inventory = Boolean(changes.trackInventory);
      if (Object.hasOwn(changes, "visible")) payload.visible = Boolean(changes.visible);
      const {token,vendors}=await context.remote();
      const vendorId=matchLocalLineVendor(product,vendor,vendors);
      // Inventory never changes vendors; repair a mismatch through a reviewed Product Sync action.
      const before=await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(before, vendorId);
      const [mappings]=await connection.query('SELECT package_id AS packageId,local_line_package_id AS remoteId FROM local_line_package_meta WHERE product_id=?',[id]);
      const requestHash=hash(quantityEdit ? {remoteId:Number(product.remoteId),changes,expected} : {remoteId:Number(product.remoteId),payload});
      const [[pending]]=await connection.query("SELECT * FROM local_line_inventory_operations WHERE product_id=? AND status='attempted' ORDER BY created_at LIMIT 1",[id]);
      if (quantityEdit && pending) fail('An earlier inventory publication has an uncertain outcome. No repeat was sent. Review its receipt and reconcile stock in Local Line before another quantity change.',409);
      if (quantityEdit) {
        const [[confirmed]] = await connection.query("SELECT id FROM local_line_inventory_operations WHERE product_id=? AND request_hash=? AND status='confirmed' LIMIT 1",[id,requestHash]);
        if (confirmed) {
          const currentInventory=await cacheInventory(connection,id,before,mappings);
          await connection.commit();
          return {ok:true,productId:id,localLineUpdate:true,savedFields:Object.keys(changes),currentInventory,replayed:true};
        }
        const stock=stockPayload(before,changes,expected,mappings);
        if(stock.conflict) throw Object.assign(new Error('Full Farm stock changed. Review the current count before saving again.'),{status:409,inventoryConflict:stock.conflict});
        payload={...payload,...stock.payload};
      }
      const alreadyApplied=Object.entries(payload).every(([key,value])=>key==='set_inventory'?before.inventory===value:key==='packages'?value.every(p=>!Object.hasOwn(p,'set_inventory')||Number(before.packages.find(old=>old.id===p.id)?.current_inventory)===p.set_inventory):before[key]===value);
      if(pending && (pending.request_hash!==requestHash || Number(pending.remote_id)!==Number(product.remoteId))) fail('An earlier inventory publication needs reconciliation. Refresh and confirm its original request before sending another.',409);
      if(pending && !alreadyApplied) fail('An earlier Local Line inventory request has an uncertain outcome. No repeat was sent. Review its receipt and current Local Line settings.',409);
      const operationId=pending?.id || randomUUID();
      if(!alreadyApplied) {
        await connection.query(`INSERT INTO local_line_inventory_operations (id,product_id,user_id,remote_id,request_hash,payload_json,receipt_json,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'attempted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[operationId,id,user.userId || user.adminId,Number(product.remoteId),requestHash,JSON.stringify(payload),quantityEdit?JSON.stringify({expectedInventory:expected,before:remoteInventory(before,mappings)}):null]);
        // The publication receipt must survive a process crash or lost response.
        await connection.commit();
        if (quantityEdit) await patchReviewedLocalLineInventory(Number(product.remoteId), token, payload);
        else await patchLocalLineProduct(Number(product.remoteId), token, payload);
        await connection.beginTransaction();
      }
      const remote = await fetchLocalLineProduct(Number(product.remoteId), token);
      confirmLocalLineVendor(remote, vendorId);
      if ((Object.hasOwn(changes, "inventory") && Number(remote.inventory) !== changes.inventory) ||
        (Object.hasOwn(changes, "trackInventory") && remote.track_inventory !== Boolean(changes.trackInventory)) ||
        (Object.hasOwn(changes, "visible") && remote.visible !== Boolean(changes.visible))) {
        fail("Local Line did not confirm the requested inventory. Check its stock before retrying; local inventory was not changed.");
      }
      const current=remoteInventory(remote,mappings);
      if((before.inventory_type||'product')!==(remote.inventory_type||'product') || changes.packageInventory?.some(target=>!current.packages?.some(p=>p.packageId===target.packageId&&p.inventory===target.inventory)) ||
        changes.packageInventory&&before.packages.some(p=>!remote.packages?.some(after=>after.id===p.id)))fail('Local Line did not confirm the requested package inventory. Refresh before retrying.');
      const columns = { trackInventory: "track_inventory", visible: "visible" };
      const fields=Object.keys(changes).filter(key=>!['packageInventory','inventory'].includes(key));
      if(fields.length)await connection.query(`UPDATE products SET ${fields.map(key=>`${columns[key]}=?`).join(', ')}, updated_at=UTC_TIMESTAMP() WHERE id=?`,[...fields.map(k=>changes[k]),id]);
      await cacheInventory(connection,id,remote,mappings);
      if(pending || !alreadyApplied)await connection.query("UPDATE local_line_inventory_operations SET status='confirmed',receipt_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[JSON.stringify({visible:remote.visible,track_inventory:remote.track_inventory,currentInventory:current,...(quantityEdit?{expectedInventory:expected,before:remoteInventory(before,mappings)}:{})}),operationId]);
      await connection.commit();
      return { ok: true, productId: id, localLineUpdate: true, savedFields: Object.keys(changes), currentInventory: current };
    } catch (error) { await connection.rollback(); throw error; }
}


async function cacheInventory(db,id,remote,mappings){
 const current=remoteInventory(remote,mappings);
 // The product-level count remains separate; never replace it with a sum of package counts.
 await db.query('UPDATE products SET inventory=?,track_inventory=? WHERE id=?',[remote.inventory??null,Number(current.trackInventory),id]);
 await db.query('UPDATE local_line_product_meta SET inventory_type=?,product_inventory=?,track_inventory=?,visible=?,raw_json=?,last_synced_at=UTC_TIMESTAMP() WHERE product_id=?',[current.inventoryType||'product',remote.inventory??null,Number(current.trackInventory),Number(Boolean(remote.visible)),JSON.stringify(remote),id]);
 const packages=(current.packages||[]).filter(p=>p.packageId);
 if(packages.length) {
  const cases=packages.map(()=> 'WHEN ? THEN ?').join(' '),values=packages.flatMap(p=>[p.packageId,p.inventory]),ids=packages.map(p=>p.packageId);
  await db.query(`UPDATE packages SET inventory=CASE id ${cases} END WHERE product_id=? AND id IN (?)`,[...values,id,ids]);
  await db.query(`UPDATE local_line_package_meta SET package_inventory=CASE package_id ${cases} END,last_synced_at=UTC_TIMESTAMP() WHERE product_id=? AND package_id IN (?)`,[...values,id,ids]);
 }
 return current;
}
const inventoryProductRead=`SELECT p.id,p.is_deleted,p.inventory,p.track_inventory,p.vendor_id AS vendorId,v.name AS vendorName,
  c.name AS categoryName,m.local_line_product_id AS remoteId,SHA2(COALESCE(m.raw_json,''),256) AS cacheVersion
  FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN local_line_product_meta m ON m.product_id=p.id`;

export async function refreshFullFarmInventory(productIds) {
  const ids=normalizeIds(productIds);
  if(!ids.length||ids.length>100) fail('Select between 1 and 100 products.');
  if(process.env.CSA_LOCAL_ONLY==='true'||!isLocalLineEnabled()||process.env.LOCALLINE_TEST==='true') fail('Local Line inventory checks are not enabled.');
  const token=await getLocalLineAccessToken();
  const [vendors,[products]]=await Promise.all([fetchLocalLineVendors(token),getPool().query(`${inventoryProductRead} WHERE p.id IN (?)`,[ids])]);
  const byId=new Map(products.map(p=>[Number(p.id),p]));
  const rows=[];let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(cursor<ids.length) {
      const id=ids[cursor++];
      let db;
      try {
        const p=byId.get(id);
        if(!p||p.is_deleted||p.categoryName?.toLowerCase()==='membership'||!p.remoteId) fail('Link this product to Local Line before checking inventory.');
        const vendor=requireProductVendor(p,{id:p.vendorId,name:p.vendorName});
        const vendorId=matchLocalLineVendor(p,vendor,vendors);
        // No database connection or row lock is held while waiting on Local Line.
        const remote=await fetchLocalLineProduct(Number(p.remoteId),token);confirmLocalLineVendor(remote,vendorId);
        db=await getPool().getConnection();
        await db.beginTransaction();
        const [[currentProduct]]=await db.query(`${inventoryProductRead} WHERE p.id=? FOR UPDATE OF p, m`,[id]);
        if(!currentProduct||JSON.stringify(currentProduct)!==JSON.stringify(p))fail('Inventory changed during this refresh. Refresh this product again.',409);
        const [mappings]=await db.query('SELECT package_id AS packageId,local_line_package_id AS remoteId FROM local_line_package_meta WHERE product_id=?',[id]);
        const current=await cacheInventory(db,id,remote,mappings);
        await db.commit();rows.push({productId:id,...current});
      }catch(e){if(db)await db.rollback();rows.push({productId:id,error:e.message});}finally{db?.release();}
    }
  }));
  return {rows};
}
