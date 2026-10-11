import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { getDb, getPool } from '../../../apps/api/db.js';
import * as schema from '../../../apps/api/schema.js';
import { loadLocalLineSyncContext, fetchLocalLineProduct, resolveLocalLineVendor, buildLocalLinePricePayload, upsertLocalLineProductMeta } from '../../../apps/api/localLine.js';
import { getLocalLineAccessToken } from '../../../apps/api/localLineAuth.js';
import { computeProductPricingSnapshot, computeFinalPrice, getPriceListDefinitions } from '../../../apps/api/lib/productPricing.js';
import { saveProductMarkupOverride } from '../../../apps/api/lib/productMarkup.js';
import { localLineInputs, localLineMapping, localLineProjection, inspectAction, executeAction } from '../../../apps/api/lib/productSyncAdapters.js';
import { same, executeProductActions, releaseStatus, authorizeRelease } from '../../../apps/api/lib/productSyncCore.js';
import { ensureProductSyncSchema, withSyncLock } from '../../../apps/api/lib/productSyncSchema.js';
import { loadCurrentSnapshot, createProductSyncRelease, getProductSyncRelease } from '../../../apps/api/lib/productSync.js';

const pool = getPool();
const directory = new URL('./', import.meta.url);
const files = ['vendors','categories','products','packages','productPricingProfiles','productSales','localLineProductMeta','localLinePackageMeta'];
const fields = ['guestMarkup','memberMarkup','herdShareMarkup','snapMarkup'];
const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
async function maybeRead(name) { try { return await read(name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function save(name, value, exclusive = false) {
  const path = new URL(name, directory);
  if (exclusive) return writeFile(path, JSON.stringify(value, null, 2)+'\n', { flag: 'wx' });
  const temp = new URL(name+'.tmp', directory);
  await writeFile(temp, JSON.stringify(value, null, 2)+'\n'); await rename(temp,path);
}
async function catalog() {
  const data={};
  for (const key of files) data[key] = await getDb().select().from(schema[key]);
  return data;
}
function contextFrom(data, p) {
  return { product:p, vendor:data.vendors.find(v=>v.id===p.vendorId), categoryName:data.categories.find(c=>c.id===p.categoryId)?.name || '',
    profile:data.productPricingProfiles.find(x=>x.productId===p.id) || null, sale:data.productSales.find(x=>x.productId===p.id) || {},
    packages:data.packages.filter(x=>x.productId===p.id), packageMeta:data.localLinePackageMeta.filter(x=>x.productId===p.id),
    remoteId:Number(data.localLineProductMeta.find(x=>x.productId===p.id)?.localLineProductId)||null };
}
const snapshot = c => computeProductPricingSnapshot({...c, profile:{...c.profile,...c.sale}, packageMetaByPackageId:new Map(c.packageMeta.map(p=>[p.packageId,p]))});
function reason(c) {
  if (/deck|hyland|creamy cow/i.test(c.vendor?.name||'')) return 'Excluded vendor: Deck / Hyland / Creamy Cow';
  if (/deck|hyland|creamy cow/i.test(c.product.name||'')) return 'Excluded product name: Deck / Hyland / Creamy Cow';
  if (/deposit/i.test(c.product.name)) return 'Deposit: no markup';
  if (c.categoryName.trim().toLowerCase()==='membership') return 'Membership';
  if (c.product.isDeleted) return 'Deleted product';
  if (!c.vendor?.id || !String(c.vendor.name).trim()) return 'Missing vendor';
  const s=snapshot(c);
  if (fields.every(k=>s.profile[k]===0.45)) return 'Already 45% (previous trial)';
  if (!fields.every(k=>s.profile[k]===0.4)) return 'Current markup differs from 40%';
  return null;
}
async function actor() {
  const [[row]]=await pool.query(`SELECT u.id,u.username,GROUP_CONCAT(r.role_key ORDER BY r.role_key) AS roles FROM users u
    JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id
    WHERE u.username=? AND COALESCE(u.active,1)=1 GROUP BY u.id,u.username`,[process.env.ADMIN_USER||'deck.john']);
  assert.ok(row); const user={userId:row.id,adminRoles:row.roles.split(',')};
  assert.ok(user.adminRoles.includes('admin')||user.adminRoles.includes('localline_push'));
  assert.ok(user.adminRoles.some(r=>['admin','pricing_admin','local_pricelist_admin'].includes(r)));
  return {user,username:row.username};
}
async function parallelRead(items, operation, count=4) {
  let index=0;
  const results=await Promise.allSettled(Array.from({length:Math.min(count,items.length)},async()=>{while(index<items.length) await operation(items[index++]);}));
  for(const r of results) if(r.status==='rejected') throw r.reason;
}
const sorted = rows => rows.slice().sort((a,b)=>Number(a.id??a.productId)-Number(b.id??b.productId));
const stableRows = rows => sorted(rows).map(row=>Object.fromEntries(Object.entries(row).filter(([k])=>!['updatedAt','createdAt','priceChangedAt','remoteSyncedAt','remoteSyncStatus','remoteSyncMessage'].includes(k))));
function preservation(before, after, changedIds) {
  const checks={};
  for(const key of ['vendors','products','packages','productSales']) checks[key]=same(stableRows(before[key]),stableRows(after[key]));
  checks.excludedProfiles=same(stableRows(before.productPricingProfiles.filter(p=>!changedIds.has(p.productId))),stableRows(after.productPricingProfiles.filter(p=>!changedIds.has(p.productId))));
  return checks;
}
const round=n=>Number(Number(n).toFixed(2));
function actualPrice(base,entry) {
  if (!entry.adjustment) return round(base);
  const n=Number(entry.adjustment_value);
  return Number(entry.adjustment_type)===1?round(base+n):Number(entry.adjustment_type)===2?round(base*(1+n/100)):round(n);
}
function priceRows(c, remote, payload) {
  const s=snapshot(c);
  const map=localLineMapping(c);
  const lists=getPriceListDefinitions(s.profile);
  return c.packages.flatMap(pkg=>{
    const remoteId=map.packages.find(p=>p.packageId===pkg.id)?.remoteId;
    const rp=remote?.packages.find(p=>Number(p.id)===remoteId);
    return lists.map(list=>{
      const old=rp?.price_list_entries?.find(e=>Number(e.price_list_id??e.price_list)===list.id);
      const proposed=payload?.packages.find(p=>p.id===remoteId)?.price_list_entries.find(e=>e.price_list===list.id);
      return {productId:c.product.id,product:c.product.name,vendor:c.vendor.name,packageId:pkg.id,package:pkg.name,priceList:list.name,
        visible:Boolean(c.product.visible),basePrice:Number(pkg.price),markupBefore:list.markup*100,markupAfter:45,
        saleDiscount:s.profile.onSale?s.profile.saleDiscount*100:0,
        localPriceBefore:computeFinalPrice(pkg.price,list.markup,s.profile.onSale,s.profile.saleDiscount).final,
        localPriceAfter:computeFinalPrice(pkg.price,0.45,s.profile.onSale,s.profile.saleDiscount).final,
        remoteBasePrice:rp?.unit_price??null,remoteAdjustmentType:old?.adjustment_type??null,remoteAdjustmentBefore:old?.adjustment_value??null,
        remoteAdjustmentAfter:proposed?.adjustment_value??null,remotePriceBefore:old?actualPrice(Number(rp.unit_price),old):null,
        remotePriceAfter:proposed?actualPrice(Number(rp.unit_price),proposed):null};
    });
  });
}

async function inventory() {
  await mkdir(new URL('audit/',directory),{recursive:true});
  await mkdir(new URL('verification/',directory),{recursive:true});
  const before=await catalog(); await save('catalog-before.json',before,true);
  const scope=before.products.map(p=>{
    const c=contextFrom(before,p); const excluded=reason(c);
    return {id:p.id,name:p.name,vendor:c.vendor?.name||'',vendorId:p.vendorId,category:c.categoryName,visible:Boolean(p.visible),reason:excluded};
  });
  const plan={createdAt:new Date().toISOString(),...(await actor()),eligible:scope.filter(p=>!p.reason),excluded:scope.filter(p=>p.reason),catalogCount:scope.length};
  await save('scope.json',plan,true);
  const vendors={};for(const row of plan.eligible) vendors[row.vendor]=(vendors[row.vendor]||0)+1;
  const reasons={};for(const row of plan.excluded) reasons[row.reason]=(reasons[row.reason]||0)+1;
  console.log(JSON.stringify({eligible:plan.eligible.length,excluded:plan.excluded.length,vendors,reasons},null,2));
}

async function audit() {
  const scope=await read('scope.json'); const before=await read('catalog-before.json');
  let done=0;const outcomes={};const vendorIds=new Map();
  // Verify each distinct vendor once while preparing. The release worker verifies it live again.
  for(const row of scope.eligible) if(!vendorIds.has(row.vendorId)) {
    const c=contextFrom(before,before.products.find(p=>p.id===row.id));
    vendorIds.set(row.vendorId,await resolveLocalLineVendor(c,await getLocalLineAccessToken()));
  }
  await parallelRead(scope.eligible,async row=>{
    let record=await maybeRead(`audit/${row.id}.json`);
    if(!record) {
      const c=await loadLocalLineSyncContext(getDb(),row.id);
      const problems=[];let remote=null,payload=null;
      try {
        assert.equal(reason(c),null,'Product scope or markup changed');
        assert.ok(c.remoteId,'No Local Line link');
        remote=await fetchLocalLineProduct(c.remoteId,await getLocalLineAccessToken());
        assert.ok(!remote.is_deleted,'Local Line product is deleted');
        c.localLineVendorId=vendorIds.get(row.vendorId);
        assert.equal(Number(remote.vendor?.id??remote.vendor),c.localLineVendorId,'Local Line vendor mismatch');
        const old=buildLocalLinePricePayload(c,remote,c.sale);
        const next=buildLocalLinePricePayload({...c,profile:{...c.profile,markupOverride:0.45}},remote,c.sale);
        const expectedListIds=new Set(getPriceListDefinitions(snapshot(c).profile).map(x=>x.id));
        assert.equal(expectedListIds.size,4,'Four configured customer lists required');
        const packages=[];
        for(const pkg of next.packages) {
          const rp=remote.packages.find(p=>Number(p.id)===Number(pkg.id));
          assert.ok(rp);
          assert.ok(Math.abs(Number(rp.unit_price)-Number(pkg.unit_price))<0.005,`Base price drift on package ${pkg.id}: local ${pkg.unit_price}, remote ${rp.unit_price}`);
          const oldPkg=old.packages.find(p=>p.id===pkg.id);
          assert.equal(pkg.price_list_entries.length,4,`Missing customer price-list entry on package ${pkg.id}`);
          const entries=pkg.price_list_entries.map(entry=>{
            const prior=oldPkg.price_list_entries.find(e=>e.price_list===entry.price_list);
            const live=rp.price_list_entries.find(e=>Number(e.price_list_id??e.price_list)===entry.price_list);
            assert.ok(live,`Missing live entry ${entry.price_list}`);
            assert.equal(Boolean(live.on_sale_toggle),Boolean(prior.on_sale_toggle),`Sale drift on package ${pkg.id}, list ${entry.price_list}`);
            // Only publish a known 40%-based entry. Preserve existing per-order limits and unrelated flags.
            assert.ok(Math.abs(actualPrice(Number(rp.unit_price),live)-actualPrice(Number(rp.unit_price),prior))<=0.01,
              `Existing price drift on package ${pkg.id}, list ${entry.price_list}: remote ${actualPrice(Number(rp.unit_price),live)}, local ${actualPrice(Number(rp.unit_price),prior)}`);
            return {...entry,max_units_per_order:live.max_units_per_order??null};
          });
          packages.push({id:pkg.id,unit_price:Number(rp.unit_price),price_list_entries:entries});
        }
        assert.equal(packages.length,c.packages.length,'Not every local package can be priced');
        payload={vendor:c.localLineVendorId,packages};
      } catch(error) {problems.push(error.message);}
      record={productId:row.id,context:c,remote,payload:problems.length?null:payload,problems,status:problems.length?'exception':'ready',
        auditedAt:new Date().toISOString(),rows:priceRows(c,remote,problems.length?null:payload)};
      await save(`audit/${row.id}.json`,record,true);
    }
    outcomes[record.status]=(outcomes[record.status]||0)+1;
    if(++done%25===0 || done===scope.eligible.length) console.log(JSON.stringify({audited:done,total:scope.eligible.length,outcomes}));
  });
  const records=[];for(const row of scope.eligible) records.push(await read(`audit/${row.id}.json`));
  await save('audit-summary.json',{completedAt:new Date().toISOString(),counts:outcomes,exceptions:records.filter(r=>r.problems.length).map(r=>({id:r.productId,name:r.context.product.name,vendor:r.context.vendor.name,problems:r.problems}))});
  console.log(JSON.stringify(await read('audit-summary.json'),null,2));
}

async function review() {
  const scope=await read('scope.json'); const counts={}; const exceptions=[];
  for(const row of scope.eligible) {
    const record=await read(`audit/${row.id}.json`);
    const {context:c,remote}=record; const warnings=[]; const problems=[];let payload=null;
    try {
      assert.equal(reason(c),null,'Product is outside the approved 40% scope');
      assert.ok(c.remoteId && remote,record.connectionError||'No confirmed Local Line product link');
      assert.ok(!remote.is_deleted,'Local Line product is deleted');
      assert.equal(Number(remote.vendor?.id??remote.vendor),c.localLineVendorId,'Local Line vendor differs from the saved local vendor');
      // A markup-only operation preserves each system's existing base prices.
      // A remote base-price difference is disclosed, never back-captured or overwritten.
      const remoteContext=structuredClone(c);
      const mapping=localLineMapping(c);
      for(const pkg of remoteContext.packages) {
        const id=mapping.packages.find(m=>m.packageId===pkg.id)?.remoteId;
        const rp=remote.packages.find(p=>Number(p.id)===id);
        assert.ok(rp,`Package ${pkg.id} has no confirmed remote match`);
        assert.ok(Number.isFinite(Number(rp.unit_price))&&Number(rp.unit_price)>=0,'Invalid remote base price');
        if(Number(pkg.price)!==Number(rp.unit_price)) warnings.push(`Package ${pkg.name}: local base $${pkg.price}, Local Line base $${rp.unit_price}; both bases preserved.`);
        pkg.price=Number(rp.unit_price);
      }
      const old=buildLocalLinePricePayload(remoteContext,remote,c.sale);
      const next=buildLocalLinePricePayload({...remoteContext,profile:{...c.profile,markupOverride:0.45}},remote,c.sale);
      const lists=getPriceListDefinitions(snapshot(c).profile);
      const packages=next.packages.map(pkg=>{
        const rp=remote.packages.find(p=>Number(p.id)===Number(pkg.id));
        const previous=old.packages.find(p=>p.id===pkg.id);
        const entries=pkg.price_list_entries.map(entry=>{
          const live=rp.price_list_entries.find(e=>Number(e.price_list_id??e.price_list)===entry.price_list);
          const prior=previous.price_list_entries.find(e=>e.price_list===entry.price_list);
          assert.ok(live);
          assert.equal(Boolean(live.on_sale_toggle),Boolean(prior.on_sale_toggle),`Sale status differs on package ${pkg.id}, list ${entry.price_list}; sale retained for review`);
          if(Math.abs(actualPrice(Number(rp.unit_price),live)-actualPrice(Number(rp.unit_price),prior))>0.01) {
            warnings.push(`${live.price_list_name||entry.price_list}: remote adjustment ${live.adjustment_value} (type ${live.adjustment_type}) differed from local 40%; set to approved 45% pricing.`);
          }
          return {...entry,max_units_per_order:live.max_units_per_order??null};
        });
        const present=new Set(entries.map(e=>e.price_list));
        for(const list of lists) if(!present.has(list.id)) warnings.push(`${list.name} is not present for package ${pkg.name}; no listing created.`);
        return {id:pkg.id,unit_price:Number(rp.unit_price),price_list_entries:entries};
      });
      assert.equal(packages.length,c.packages.length,'Not all packages have price-list entries');
      payload={vendor:c.localLineVendorId,packages};
    } catch(error) {problems.push(error.message.split('\n')[0]);}
    const next={...record,payload:problems.length?null:payload,problems,warnings,status:problems.length?'exception':'ready',reviewedAt:new Date().toISOString(),rows:priceRows(c,remote,problems.length?null:payload)};
    await save(`audit/${row.id}.json`,next);
    counts[next.status]=(counts[next.status]||0)+1;
    if(problems.length) exceptions.push({id:row.id,name:row.name,vendor:row.vendor,problems});
  }
  await save('audit-summary.json',{completedAt:new Date().toISOString(),counts,exceptions});
  console.log(JSON.stringify({counts,exceptionReasons:exceptions.reduce((out,row)=>{const k=row.problems[0];out[k]=(out[k]||0)+1;return out;},{})},null,2));
}

async function saveLocal() {
  const scope=await read('scope.json');const before=await read('catalog-before.json');
  const ids=scope.eligible.map(p=>p.id);assert.equal(ids.length,534);
  const previous=await maybeRead('local-save.json');
  if(previous) {console.log(JSON.stringify({alreadySaved:true,...previous}));return;}
  const connection=await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM products WHERE id IN (?) FOR UPDATE',[ids]);
    await connection.query('SELECT id FROM vendors WHERE id IN (?) FOR UPDATE',[[...new Set(scope.eligible.map(p=>p.vendorId))]]);
    await connection.query('SELECT product_id FROM product_pricing_profiles WHERE product_id IN (?) FOR UPDATE',[ids]);
    await connection.query('SELECT id FROM packages WHERE product_id IN (?) FOR UPDATE',[ids]);
    await connection.query('SELECT product_id FROM product_sales WHERE product_id IN (?) FOR UPDATE',[ids]);
    const now=await catalog();
    const contexts=ids.map(id=>contextFrom(now,now.products.find(p=>p.id===id)));
    const alreadySaved=contexts.every(c=>Number(c.profile?.markupOverride)===0.45&&c.profile.remoteSyncMessage?.startsWith('Markup rollout 2026-10-08:'));
    if(!alreadySaved) {
      for(const c of contexts) {
        assert.equal(reason(c),null,`Product ${c.product.id} no longer eligible`);
        const original=contextFrom(before,before.products.find(p=>p.id===c.product.id));
        assert.ok(same(localLineInputs(c,false,false),localLineInputs(original,false,false)),`Local pricing inputs changed for ${c.product.id}; review first`);
      }
      const [result]=await connection.query(`INSERT INTO product_pricing_profiles
        (product_id,markup_override,guest_markup,member_markup,herd_share_markup,snap_markup,on_sale,sale_discount,
         remote_sync_status,remote_sync_message,price_changed_at,created_at,updated_at)
        SELECT p.id,0.45,0.45,0.45,0.45,0.45,COALESCE(ps.on_sale,0),ps.sale_discount,'pending',
          'Markup rollout 2026-10-08: 40% to 45%. Local Line publication pending.',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP()
        FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id WHERE p.id IN (?)
        ON DUPLICATE KEY UPDATE markup_override=VALUES(markup_override),guest_markup=VALUES(guest_markup),member_markup=VALUES(member_markup),
          herd_share_markup=VALUES(herd_share_markup),snap_markup=VALUES(snap_markup),remote_sync_status=VALUES(remote_sync_status),
          remote_sync_message=VALUES(remote_sync_message),price_changed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP()`,[ids]);
      assert.ok(result.affectedRows>=ids.length);
    }
    await connection.commit();
    const record={savedAt:new Date().toISOString(),productIds:ids,count:ids.length};
    await save('local-save.json',record,true);
    const after=await catalog();
    const checks=preservation(before,after,new Set(ids));
    assert.ok(Object.values(checks).every(Boolean),'Unrelated catalog data changed');
    for(const id of ids) {
      const c=contextFrom(after,after.products.find(p=>p.id===id));
      assert.equal(Number(c.profile.markupOverride),0.45);
      assert.ok(fields.every(f=>snapshot(c).profile[f]===0.45));
    }
    await save('local-verification.json',{verifiedAt:new Date().toISOString(),count:ids.length,checks});
    console.log(JSON.stringify({saved:ids.length,checks},null,2));
  } catch(error) {await connection.rollback();throw error;} finally {connection.release();}
}

async function approve() {
  const scope=await read('scope.json');await read('local-save.json');
  await ensureProductSyncSchema();
  let state=await maybeRead('state.json')||{};
  const operationId='non-deck-markup-45-2026-10-08';
  if(!state.auditId) {
    const [[existing]]=await pool.query("SELECT id FROM product_sync_audits WHERE JSON_UNQUOTE(JSON_EXTRACT(options_json,'$.operationId'))=? ORDER BY id DESC LIMIT 1",[operationId]);
    if(existing) {state.auditId=existing.id;await save('state.json',state);}
  }
  if(!state.auditId) {
    const current=await catalog(); const records=[];
    for(const row of scope.eligible) records.push(await read(`audit/${row.id}.json`));
    const actions=records.map(r=>{
      const c={...r.context,profile:current.productPricingProfiles.find(p=>p.productId===r.productId)};
      assert.equal(Number(c.profile?.markupOverride),0.45);
      if(!r.payload) return {direction:'outgoing',platform:'localline',kind:'error',productId:r.productId,productName:c.product.name,vendorName:c.vendor.name,status:'blocked',message:r.problems.join(' ')};
      const action={direction:'outgoing',platform:'localline',kind:'update',productId:r.productId,productName:c.product.name,vendorName:c.vendor.name,status:'changed',
        staged:{},includeInventory:false,includeVisibility:false,mapping:localLineMapping(c),localBefore:localLineInputs(c,false,false),localAfter:localLineInputs(c,false,false),
        payload:r.payload,createPayload:null,imageSources:[],remoteBefore:{fields:localLineProjection(r.remote,r.payload),images:null},desired:{fields:localLineProjection(r.payload,r.payload,true),images:null},
        localSnapshot:{productId:c.product.id,productName:c.product.name,visible:Number(c.product.visible||0),trackInventory:Number(c.product.trackInventory||0),inventory:Number(c.product.inventory||0),
          onSale:Number(c.sale.onSale??c.profile.onSale??0),saleDiscount:Number(c.sale.saleDiscount??c.profile.saleDiscount??0)},
        message:'Approved non-Deck markup rollout to 45%. Preserve existing base prices and unrelated fields.',warnings:r.warnings};
      action.display={current:action.remoteBefore,proposed:action.desired};return action;
    });
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [audit]=await connection.query(`INSERT INTO product_sync_audits(status,options_json,summary_json,created_by,created_at,finished_at,localline_refreshed_at)
        VALUES ('completed',?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
      [JSON.stringify({operationId,platforms:['localline'],productIds:scope.eligible.map(p=>p.id),productScope:'selected',vendorGroup:'all',incoming:false,staged:{},auditedProductCount:scope.eligible.length,priceOnly:true}),
        JSON.stringify(['changed','blocked'].map(status=>({platform:'localline',direction:'outgoing',status,count:actions.filter(a=>a.status===status).length}))),scope.user.userId]);
      await connection.query('INSERT INTO product_sync_actions(audit_id,product_id,product_name,vendor_name,platform,direction,status,data_json) VALUES ?',
        [actions.map(a=>[audit.insertId,a.productId,a.productName,a.vendorName,a.platform,a.direction,a.status,JSON.stringify(a)])]);
      await connection.commit();state.auditId=Number(audit.insertId);await save('state.json',state);
    } catch(error) {await connection.rollback();throw error;}finally{connection.release();}
  }
  if(!state.releaseId) {
    const [[existing]]=await pool.query('SELECT id FROM product_sync_releases WHERE audit_id=? ORDER BY id DESC LIMIT 1',[state.auditId]);
    if(existing) state.releaseId=Number(existing.id);
    else {
      const [actions]=await pool.query("SELECT id FROM product_sync_actions WHERE audit_id=? AND status='changed' ORDER BY id",[state.auditId]);
      assert.ok(actions.length>0);
      const release=await createProductSyncRelease({auditId:state.auditId,actionIds:actions.map(a=>a.id),name:'Non-Deck products: markup 40% → 45% (October 8, 2026)'},scope.user);
      state.releaseId=release.id;
    }
    await save('state.json',state);
  }
  const release=await getProductSyncRelease(state.releaseId);
  console.log(JSON.stringify({...state,actions:release.actions.length,status:release.status},null,2));
}

async function publish() {
  const scope=await read('scope.json');const state=await read('state.json');
  // Reuse the standard durable action executor under the standard execution lock.
  // Every action has empty staging, so workers never share a local-edit transaction.
  await withSyncLock('csa-store:scheduled-pricelist-releases',async()=>{
    const release=await getProductSyncRelease(state.releaseId);
    authorizeRelease(scope.user.adminRoles,release.actions,false);
    if(release.status==='completed') {console.log('Release already completed.');return;}
    assert.ok(release.status!=='cancelled');
    const ids=new Set(scope.eligible.map(p=>p.id));
    for(const action of release.actions) {
      assert.ok(ids.has(action.productId)&&action.platform==='localline'&&action.kind==='update');
      assert.deepEqual(action.staged,{});assert.deepEqual(action.imageSources,[]);
      assert.deepEqual(Object.keys(action.payload).sort(),['packages','vendor']);
    }
    await pool.query("UPDATE product_sync_releases SET status='running',started_at=COALESCE(started_at,UTC_TIMESTAMP()),finished_at=NULL WHERE id=?",[state.releaseId]);
    let done=0;const statuses={};
    await parallelRead(release.actions,async action=>{
      await executeProductActions([action],{
        inspect:a=>inspectAction(a,async checkpoint=>{
          await pool.query('UPDATE product_sync_release_actions SET checkpoint_json=?,updated_at=UTC_TIMESTAMP() WHERE id=?',[JSON.stringify(checkpoint),a.releaseActionId]);
          a.checkpoint=structuredClone(checkpoint);
        }),
        isLocalApplied:async()=>true,
        applyLocalOnce:async()=>pool.query('UPDATE product_sync_release_products SET local_applied_at=COALESCE(local_applied_at,UTC_TIMESTAMP()) WHERE release_id=? AND product_id=?',[state.releaseId,action.productId]),
        save:async(a,result)=>{
          await pool.query("UPDATE product_sync_release_actions SET status=?,message=?,updated_at=UTC_TIMESTAMP(),completed_at=IF(?='completed',UTC_TIMESTAMP(),completed_at) WHERE id=?",[result.status,result.message,result.status,a.releaseActionId]);
          a.status=result.status;a.message=result.message;
          if(result.status==='completed') await pool.query("UPDATE product_pricing_profiles SET remote_sync_status='synced',remote_sync_message=?,remote_synced_at=UTC_TIMESTAMP() WHERE product_id=? AND markup_override=0.45",[result.message,a.productId]);
        },
        execute:(a,current)=>executeAction(a,current,async checkpoint=>{
          await pool.query('UPDATE product_sync_release_actions SET checkpoint_json=?,updated_at=UTC_TIMESTAMP() WHERE id=?',[JSON.stringify(checkpoint),a.releaseActionId]);
          a.checkpoint=structuredClone(checkpoint);
        })
      });
      statuses[action.status]=(statuses[action.status]||0)+1;
      if(++done%10===0||done===release.actions.length) console.log(JSON.stringify({processed:done,total:release.actions.length,statuses}));
    },4);
    const status=releaseStatus(release.actions);
    await pool.query('UPDATE product_sync_releases SET status=?,finished_at=UTC_TIMESTAMP() WHERE id=?',[status,state.releaseId]);
  });
  const result=await getProductSyncRelease(state.releaseId);await save('release.json',result);
  console.log(JSON.stringify({releaseId:state.releaseId,status:result.status,counts:result.actions.reduce((o,a)=>(o[a.status]=(o[a.status]||0)+1,o),{})},null,2));
}

function protectedRemote(remote) {
  const keys=['id','name','vendor','description','visible','track_inventory','images','package_codes_enabled'];
  return {product:Object.fromEntries(keys.map(k=>[k,remote[k]??null])),packages:remote.packages.map(p=>Object.fromEntries(['id','name','unit_price','inventory_per_unit','package_code','vendor_package_code','track_type'].map(k=>[k,p[k]??null])))};
}
async function verify() {
  const scope=await read('scope.json');const state=await read('state.json');
  const release=await getProductSyncRelease(state.releaseId);await save('release.json',release);
  const complete=release.actions.filter(a=>a.status==='completed');let done=0;
  await parallelRead(complete,async action=>{
    const record=await read(`audit/${action.productId}.json`);
    const remote=await fetchLocalLineProduct(action.mapping.productId,await getLocalLineAccessToken());
    const priceConfirmed=same(localLineProjection(remote,action.payload),localLineProjection(action.payload,action.payload,true));
    const otherFieldsUnchanged=same(protectedRemote(remote),protectedRemote(record.remote));
    await save(`verification/${action.productId}.json`,{verifiedAt:new Date().toISOString(),productId:action.productId,priceConfirmed,otherFieldsUnchanged,remote});
    if(priceConfirmed) await upsertLocalLineProductMeta(getDb(),action.productId,action.mapping.productId,{rawJson:JSON.stringify(remote),lastSyncedAt:new Date()});
    if(++done%25===0||done===complete.length)console.log(JSON.stringify({verified:done,total:complete.length,latestPriceConfirmed:priceConfirmed}));
  });
  const before=await read('catalog-before.json');const after=await catalog();await save('catalog-after.json',after);
  const ids=new Set(scope.eligible.map(p=>p.id));const checks=preservation(before,after,ids);
  const allLocal45=scope.eligible.every(p=>{const c=contextFrom(after,after.products.find(x=>x.id===p.id));return fields.every(f=>snapshot(c).profile[f]===0.45)&&Number(c.profile.markupOverride)===0.45;});
  let remoteConfirmed=0,unrelatedRemoteChanges=0;
  for(const a of complete){const v=await read(`verification/${a.productId}.json`);if(v.priceConfirmed)remoteConfirmed++;if(!v.otherFieldsUnchanged)unrelatedRemoteChanges++;}
  const verification={verifiedAt:new Date().toISOString(),catalogCount:after.products.length,localUpdated:scope.eligible.length,allLocal45,checks,
    remoteApproved:release.actions.length,remoteCompleted:complete.length,remoteConfirmed,unrelatedRemoteChanges,remoteHeld:scope.eligible.length-remoteConfirmed,
    excluded:scope.excluded.length,auditId:state.auditId,releaseId:state.releaseId,releaseStatus:release.status};
  await save('verification-summary.json',verification);console.log(JSON.stringify(verification,null,2));
}

async function finalizeScope() {
  const scope=await read('scope.json');
  if(!await maybeRead('scope-original.json')) await save('scope-original.json',scope,true);
  const protectedNames=scope.eligible.filter(p=>/deck|hyland|creamy cow/i.test(p.name));
  scope.eligible=scope.eligible.filter(p=>!protectedNames.includes(p));
  scope.excluded.push(...protectedNames.map(p=>({...p,reason:'Excluded product name: Deck / Hyland / Creamy Cow'})));
  await save('scope.json',scope);
  await parallelRead(scope.eligible,async row=>{
    const record=await read(`audit/${row.id}.json`);
    if(record.remote) return;
    if(!record.context.remoteId) record.connectionError='No saved Local Line product link';
    else {
      try {
        record.remote=await fetchLocalLineProduct(record.context.remoteId,await getLocalLineAccessToken());
        record.context.localLineVendorId=await resolveLocalLineVendor(record.context,await getLocalLineAccessToken());
        delete record.connectionError;
      } catch(error) {
        record.connectionError=error.message.includes('product_is_box')?'Local Line box/bundle: product endpoint does not support this item':
          error.message.includes('404')?'Local Line product not found (404)':error.message;
      }
    }
    await save(`audit/${row.id}.json`,record);
  });
  console.log(JSON.stringify({eligible:scope.eligible.length,excluded:scope.excluded.length,protectedNames:protectedNames.map(p=>p.name)}));
}

try {
  const phase=process.argv[2];
  if(phase==='inventory') await inventory();
  else if(phase==='audit') await audit();
  else if(phase==='review') await review();
  else if(phase==='save-local') await saveLocal();
  else if(phase==='approve') await approve();
  else if(phase==='publish') await publish();
  else if(phase==='verify') await verify();
  else if(phase==='finalize-scope') await finalizeScope();
  else throw new Error('Unknown phase');
} finally { await pool.end(); }
