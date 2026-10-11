import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getPool, ensureProductPricingSchema } from '../../../apps/api/db.js';
import { getLocalLineAccessToken, getLocalLineBaseUrl } from '../../../apps/api/localLineAuth.js';
import { computeProductPricingSnapshot, computeCustomerPrice, getPriceListDefinitions } from '../../../apps/api/lib/productPricing.js';
import { normalizeCustomerPriceOverrides } from '../../../apps/api/lib/customerPriceOverrides.js';
import { buildLocalLinePricePayload } from '../../../apps/api/localLine.js';
import { localLineProjection } from '../../../apps/api/lib/productSyncAdapters.js';
import jwt from '../../../apps/api/node_modules/jsonwebtoken/index.js';

const pool = getPool();
const directory = new URL('./selected-fixes/', import.meta.url);
const vendorIds = [805889, 1168459, 1168460, 1168461, 1168462, 1168463];
const saleIds = [805855, 805986, 978368, 1000029];
const ids = [...vendorIds, ...saleIds];
const tables = ['vendors', 'products', 'packages', 'product_pricing_profiles', 'product_sales', 'local_line_product_meta', 'local_line_package_meta'];
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const serialize = value => JSON.parse(JSON.stringify(value));
const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
const save = async (name, value) => writeFile(new URL(name, directory), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
async function catalog(connection = pool) {
  const result = {};
  for (const table of tables) [result[table]] = await connection.query(`SELECT * FROM ${table}`);
  return serialize(result);
}
async function get(path) {
  const response = await fetch(new URL(path, getLocalLineBaseUrl()), { headers: { Authorization: `Bearer ${await getLocalLineAccessToken()}` }, signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function remoteSnapshot() {
  const vendors = [];
  let path = 'vendors/?page_size=100';
  while (path) {
    assert.equal(new URL(path, getLocalLineBaseUrl()).origin, new URL(getLocalLineBaseUrl()).origin);
    const page = await get(path);
    vendors.push(...(Array.isArray(page) ? page : page.results));
    path = Array.isArray(page) ? null : page.next;
  }
  const products = [];
  for (const id of ids) {
    const product = await get(`products/${id}/?expand=packages,product_price_list_entries`);
    assert.equal(Number(product.id), id);
    products.push(product);
  }
  return { checkedAt: new Date().toISOString(), vendors, products };
}
function compactRemote(product) {
  return { id: product.id, name: product.name, vendor: product.vendor, packages: product.packages.map(p => ({ id: p.id, base: p.unit_price, entries: p.price_list_entries.map(e => ({ list: e.price_list_id, adjustment: e.adjustment, type: e.adjustment_type, value: e.adjustment_value, onSale: e.on_sale_toggle, strike: e.strikethrough_display_value })) })) };
}
function makePlan(local, remote) {
  const vendors = vendorIds.map(id => {
    const product = local.products.find(p => p.id === id);
    const remoteProduct = remote.products.find(p => p.id === id);
    const remoteVendorId = Number(remoteProduct.vendor?.id ?? remoteProduct.vendor);
    const remoteVendor = remote.vendors.find(v => Number(v.id) === remoteVendorId);
    assert.ok(remoteVendor?.name, `Missing remote vendor for ${id}`);
    const matches = local.vendors.filter(v => normalize(v.name) === normalize(remoteVendor.name));
    const vendor = matches.find(v => v.id === remoteVendorId) || (matches.length === 1 ? matches[0] : null);
    assert.ok(vendor, `No unique named local vendor for ${remoteVendor.name}`);
    assert.ok(!/deck|hyland|creamy cow|deposit/i.test(vendor.name + ' ' + product.name));
    const meta = local.local_line_product_meta.find(m => m.product_id === id);
    assert.equal(Number(meta?.local_line_product_id), id);
    const profile = local.product_pricing_profiles.find(p => p.product_id === id);
    const setMarkup = id !== 805889 && Number(profile?.markup_override) !== 0.45;
    if (setMarkup) {
      assert.ok(!profile, 'Newly imported product unexpectedly has a pricing profile; review before overwriting');
      assert.ok(remoteProduct.packages.length > 0);
      for (const pkg of remoteProduct.packages) {
        assert.ok(pkg.price_list_entries.length > 0);
        for (const e of pkg.price_list_entries) assert.ok(e.adjustment && Number(e.adjustment_type) === 2 && Number(e.adjustment_value) === 45 && !e.on_sale_toggle);
      }
    }
    return { id, name: product.name, beforeVendorId: product.vendor_id, beforeVendor: local.vendors.find(v => v.id === product.vendor_id)?.name || 'Unassigned', vendorId: vendor.id, vendor: vendor.name, setMarkup45: setMarkup };
  });
  return { createdAt: new Date().toISOString(), vendors, sales: remote.products.filter(p => saleIds.includes(p.id)).map(compactRemote), localOnly: true };
}
async function preview() {
  await mkdir(directory, { recursive: true });
  const local = await catalog(), remote = await remoteSnapshot();
  const plan = makePlan(local, remote);
  await save('local-before.json', local); await save('remote-before.json', remote); await save('plan.json', plan);
  console.log(JSON.stringify(plan, null, 2));
}
async function applyVendors() {
  const before = await read('local-before.json'), expected = await read('remote-before.json'), plan = await read('plan.json');
  const live = await remoteSnapshot();
  assert.deepEqual(live.products.map(compactRemote), expected.products.map(compactRemote), 'Remote vendor/pricing changed since preview');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const slots = vendorIds.map(() => '?').join(',');
    for (const table of ['products', 'product_pricing_profiles', 'product_sales', 'local_line_product_meta']) {
      await connection.query(`SELECT * FROM ${table} WHERE ${table === 'products' ? 'id' : 'product_id'} IN (${slots}) FOR UPDATE`, vendorIds);
    }
    const current = await catalog(connection);
    for (const table of tables) {
      const select = data => data[table].filter(r => table === 'vendors' || vendorIds.includes(r.product_id ?? r.id));
      assert.deepEqual(select(current), select(before), `${table} changed since preview`);
    }
    await save('apply-baseline.json', current);
    for (const row of plan.vendors) {
      const [result] = await connection.query('UPDATE products SET vendor_id=?, updated_at=UTC_TIMESTAMP() WHERE id=? AND vendor_id <=> ?', [row.vendorId, row.id, row.beforeVendorId]);
      assert.equal(result.affectedRows, 1);
      await connection.query('UPDATE local_line_product_meta SET vendor_name=? WHERE product_id=? AND local_line_product_id=?', [row.vendor, row.id, row.id]);
      if (row.setMarkup45) {
        const sale = current.product_sales.find(s => s.product_id === row.id);
        assert.ok(!sale?.on_sale);
        await connection.query(`INSERT INTO product_pricing_profiles (product_id, markup_override, guest_markup, member_markup, herd_share_markup, snap_markup, on_sale, sale_discount, remote_sync_status, remote_sync_message, price_changed_at, created_at, updated_at)
          VALUES (?,0.45,0.45,0.45,0.45,0.45,0,NULL,'pending','Local vendor and approved 45% markup reconciled; verify through Product Sync before publication.',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [row.id]);
      }
    }
    const after = await catalog(connection);
    for (const table of ['vendors', 'packages', 'product_sales', 'local_line_package_meta']) assert.deepEqual(after[table], current[table], `Unexpected changes: ${table}`);
    const omit = (row, fields) => Object.fromEntries(Object.entries(row).filter(([k]) => !fields.includes(k)));
    for (const p of current.products) {
      const result = after.products.find(a => a.id === p.id);
      const change = plan.vendors.find(a => a.id === p.id);
      if (change) { assert.equal(result.vendor_id, change.vendorId); assert.deepEqual(omit(result, ['vendor_id','updated_at']), omit(p, ['vendor_id','updated_at'])); }
      else assert.deepEqual(result, p);
    }
    for (const p of current.product_pricing_profiles) assert.deepEqual(after.product_pricing_profiles.find(a => a.product_id === p.product_id), p);
    const addedProfiles = after.product_pricing_profiles.filter(p => !current.product_pricing_profiles.some(a => a.product_id === p.product_id));
    assert.deepEqual(addedProfiles.map(p => p.product_id).sort(), plan.vendors.filter(p => p.setMarkup45).map(p => p.id).sort());
    for (const p of current.local_line_product_meta) {
      const result = after.local_line_product_meta.find(a => a.product_id === p.product_id);
      assert.deepEqual(omit(result, vendorIds.includes(p.product_id) ? ['vendor_name'] : []), omit(p, vendorIds.includes(p.product_id) ? ['vendor_name'] : []));
    }
    await connection.commit();
    await save('local-after-vendors.json', after);
    const receipt = { completedAt: new Date().toISOString(), vendorAssignments: plan.vendors, markupProfilesAdded: addedProfiles.map(p => p.product_id), remoteWrites: 0, salesUnchanged: true, allOtherCatalogFieldsPreserved: true };
    await save('vendor-receipt.json', receipt); console.log(JSON.stringify(receipt, null, 2));
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
const camel = row => row ? Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g, (_,c) => c.toUpperCase()),value])) : null;
function pricingContext(local, remoteProduct) {
  const product = camel(local.products.find(p => p.id === remoteProduct.id));
  const vendor = camel(local.vendors.find(v => v.id === product.vendorId));
  const remoteVendorId = Number(remoteProduct.vendor?.id ?? remoteProduct.vendor);
  assert.equal(vendor.id, remoteVendorId);
  assert.ok(!/deck|hyland|creamy cow|deposit/i.test(vendor.name + ' ' + product.name));
  return { product, vendor, profile: camel(local.product_pricing_profiles.find(p => p.product_id === product.id)),
    sale: camel(local.product_sales.find(p => p.product_id === product.id)) || {},
    packages: local.packages.filter(p => p.product_id === product.id).map(camel),
    packageMeta: local.local_line_package_meta.filter(p => p.product_id === product.id).map(camel), localLineVendorId: remoteVendorId };
}
function importedSettings(context, remoteProduct) {
  const rows = [];
  const configured = new Set(getPriceListDefinitions({ guestMarkup:0,memberMarkup:0,herdShareMarkup:0,snapMarkup:0 }).map(l => l.id));
  for (const pkg of context.packages) {
    const remoteId = Number(context.packageMeta.find(p => p.packageId === pkg.id)?.localLinePackageId) || pkg.id;
    const remote = remoteProduct.packages.find(p => Number(p.id) === remoteId);
    assert.ok(remote); assert.equal(Number(pkg.price), Number(remote.unit_price));
    for (const entry of remote.price_list_entries) {
      const listId = Number(entry.price_list_id ?? entry.price_list);
      assert.ok(configured.has(listId), 'Unexpected customer list');
      rows.push({ packageId:pkg.id,priceListId:listId,adjustment:Boolean(entry.adjustment),adjustmentType:Number(entry.adjustment_type),adjustmentValue:Number(entry.adjustment_value),onSale:Boolean(entry.on_sale_toggle),strikethrough:entry.strikethrough_display_value ?? null });
    }
  }
  return normalizeCustomerPriceOverrides(rows);
}
function verifyPrices(local, remote) {
  const verified = [];
  for (const product of remote.products) {
    const context = pricingContext(local,product);
    const snapshot = computeProductPricingSnapshot({ ...context, profile:{ ...context.profile,...context.sale }, packageMetaByPackageId:new Map(context.packageMeta.map(p=>[p.packageId,p])) });
    let entries = 0;
    for (const pkg of context.packages) {
      const remoteId = Number(context.packageMeta.find(p => p.packageId === pkg.id)?.localLinePackageId) || pkg.id;
      const rp = product.packages.find(p => Number(p.id) === remoteId);
      assert.ok(rp); assert.equal(Number(pkg.price),Number(rp.unit_price));
      for (const list of getPriceListDefinitions(snapshot.profile)) {
        const entry = rp.price_list_entries.find(e => Number(e.price_list_id ?? e.price_list) === list.id);
        if (!entry) continue;
        const remotePrice = !entry.adjustment ? Number(rp.unit_price) : Number(entry.adjustment_type) === 1 ? Number(rp.unit_price)+Number(entry.adjustment_value) : Number(entry.adjustment_type) === 2 ? Number(rp.unit_price)*(1+Number(entry.adjustment_value)/100) : Number(entry.adjustment_value);
        const expected = computeCustomerPrice(Number(pkg.price),snapshot.profile,pkg.id,list);
        assert.equal(expected.final,Number(remotePrice.toFixed(2)),`Price ${product.id}/${list.id}`);
        assert.equal(expected.onSale,Boolean(entry.on_sale_toggle));
        assert.equal(expected.strikethrough,entry.strikethrough_display_value == null ? null : Number(entry.strikethrough_display_value));
        entries++;
      }
    }
    const payload = buildLocalLinePricePayload(context,product);
    for (const pkg of payload.packages) {
      const remotePackage = product.packages.find(p => Number(p.id) === Number(pkg.id));
      const pricesOnly = { id:pkg.id,unit_price:pkg.unit_price,price_list_entries:pkg.price_list_entries };
      assert.deepEqual(localLineProjection(remotePackage,pricesOnly),localLineProjection(pricesOnly,pricesOnly,true),`Publication would change approved pricing for ${product.id}`);
    }
    verified.push({id:product.id,name:product.name,vendor:context.vendor.name,customerEntries:entries,pricesSalesAndStrikethroughMatch:true});
  }
  return verified;
}
async function prepareSales() {
  await ensureProductPricingSchema(); // Add only the nullable pricing-settings column if missing.
  const local = await catalog(),remote = await remoteSnapshot();
  const plan = saleIds.map(id => {
    const product = remote.products.find(p => p.id === id),context = pricingContext(local,product);
    assert.ok(context.profile); assert.ok(!context.profile.customerPriceOverridesJson,'Existing customer settings need a new review');
    assert.equal(Number(context.profile.markupOverride),.45);
    return {id,name:product.name,customerPriceOverrides:importedSettings(context,product)};
  });
  await save('sales-local-before.json',local); await save('sales-remote-before.json',remote); await save('sales-plan.json',plan);
  console.log(JSON.stringify({preparedAt:new Date().toISOString(),products:plan,remoteWrites:0},null,2));
}
async function applySales() {
  const before = await read('sales-local-before.json'),plan = await read('sales-plan.json'),expected = await read('sales-remote-before.json');
  const remote = await remoteSnapshot();
  assert.deepEqual(remote.products.map(compactRemote),expected.products.map(compactRemote),'Live settings changed after sale preview');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const table of ['products','product_pricing_profiles','product_sales','packages','local_line_package_meta','local_line_product_meta']) {
      await connection.query(`SELECT * FROM ${table} WHERE ${table === 'products' ? 'id' : 'product_id'} IN (?,?,?,?) FOR UPDATE`,saleIds);
    }
    const current = await catalog(connection);
    for (const table of tables) {
      const selected = data => data[table].filter(p=>table==='vendors'||saleIds.includes(p.product_id ?? p.id));
      assert.deepEqual(selected(current),selected(before),`${table} changed since sale preview`);
    }
    await save('sales-apply-baseline.json',current);
    for (const row of plan) {
      assert.equal(row.customerPriceOverrides.length,4);
      const [result] = await connection.query(`UPDATE product_pricing_profiles SET customer_price_overrides_json=?,remote_sync_status='pending',remote_sync_message='Explicitly approved Local Line customer-group prices and sales imported locally; review Product Sync before publication.',price_changed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE product_id=? AND customer_price_overrides_json IS NULL`,[JSON.stringify(row.customerPriceOverrides),row.id]);
      assert.equal(result.affectedRows,1);
    }
    const after = await catalog(connection);
    for (const table of tables.filter(t=>t!=='product_pricing_profiles')) assert.deepEqual(after[table],current[table],`${table} unexpectedly changed`);
    const allowed = ['customer_price_overrides_json','remote_sync_status','remote_sync_message','price_changed_at','updated_at'];
    const omit = (row,keys) => Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
    for (const row of current.product_pricing_profiles) {
      const result=after.product_pricing_profiles.find(p=>p.product_id===row.product_id);
      assert.deepEqual(omit(result,saleIds.includes(row.product_id)?allowed:[]),omit(row,saleIds.includes(row.product_id)?allowed:[]));
    }
    const verification=verifyPrices(after,remote);
    await connection.commit();
    await save('sales-local-after.json',after);
    await save('sales-receipt.json',{completedAt:new Date().toISOString(),productsImported:4,customerSettingsImported:16,remoteWrites:0,otherCatalogFieldsPreserved:true,verification});
    console.log(JSON.stringify({productsImported:4,customerSettingsImported:16,remoteWrites:0,verification},null,2));
  } catch(error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function verify() {
  const local=await catalog(),remote=await remoteSnapshot();
  const verification=verifyPrices(local,remote);
  const result={checkedAt:new Date().toISOString(),verification,remoteWrites:0};
  await save('final-verification.json',result);console.log(JSON.stringify(result,null,2));
}
async function verifyApi() {
  const [[admin]] = await pool.query(`SELECT u.id,u.username FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id WHERE COALESCE(u.active,1)=1 AND r.role_key='admin' ORDER BY u.id LIMIT 1`);
  assert.ok(admin,'No local administrator available for read-only API verification');
  const token=jwt.sign({userId:admin.id,username:admin.username,role:'admin',adminRoles:['admin']},process.env.JWT_SECRET||'dev-secret',{expiresIn:'5m'});
  const api=async path=>{const response=await fetch(`http://127.0.0.1:5177/api/admin/${path}`,{headers:{Authorization:`Bearer ${token}`}});assert.ok(response.ok,`API ${response.status}`);return response.json();};
  const plan=await read('sales-plan.json'),verified=[];
  for(const row of plan){
    const {product}=await api(`products/${row.id}`);
    assert.deepEqual(product.pricingProfile.customerPriceOverrides,row.customerPriceOverrides);
    assert.equal(product.pricingProfile.customerPriceLists.length,4);
    const result=await api(`pricelist?search=${encodeURIComponent(row.name)}&visibility=all&vendorGroup=all&sale=onSale`);
    const grid=result.rows.find(p=>p.productId===row.id);assert.ok(grid,`${row.name} missing from on-sale filter`);
    assert.equal(grid.customerPriceOverrides.length,4);
    const expected={805855:3.50,805986:3.08,978368:5.60,1000029:4.55}[row.id];
    for(const key of ['guestPrice','memberPrice','herdSharePrice','snapPrice'])assert.equal(grid[key],expected,`${row.name} ${key}`);
    verified.push({id:row.id,name:row.name,customerSettings:4,gridPrice:expected,onSaleFilter:true,detailsMatch:true});
  }
  const result={checkedAt:new Date().toISOString(),readOnly:true,verified};await save('api-verification.json',result);console.log(JSON.stringify(result,null,2));
}
try {
  if (process.argv[2] === 'preview') await preview();
  else if (process.argv[2] === 'apply-vendors') await applyVendors();
  else if (process.argv[2] === 'prepare-sales') await prepareSales();
  else if (process.argv[2] === 'apply-sales') await applySales();
  else if (process.argv[2] === 'verify') await verify();
  else if (process.argv[2] === 'verify-api') await verifyApi();
  else throw new Error('Expected preview or apply-vendors');
} finally { await pool.end(); }
