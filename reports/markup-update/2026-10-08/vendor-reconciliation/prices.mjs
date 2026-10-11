import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { getDb, getPool } from '../../../../apps/api/db.js';
import * as schema from '../../../../apps/api/schema.js';
import { loadLocalLineSyncContext, fetchLocalLineProduct, resolveLocalLineVendor, buildLocalLinePricePayload, upsertLocalLineProductMeta } from '../../../../apps/api/localLine.js';
import { getLocalLineAccessToken } from '../../../../apps/api/localLineAuth.js';
import { computeProductPricingSnapshot, computeFinalPrice, getPriceListDefinitions } from '../../../../apps/api/lib/productPricing.js';
import { saveProductMarkupOverride } from '../../../../apps/api/lib/productMarkup.js';
import { localLineInputs, localLineMapping, localLineProjection, inspectAction, executeAction } from '../../../../apps/api/lib/productSyncAdapters.js';
import { same, executeProductActions, releaseStatus, authorizeRelease } from '../../../../apps/api/lib/productSyncCore.js';
import { ensureProductSyncSchema, withSyncLock } from '../../../../apps/api/lib/productSyncSchema.js';
import { loadCurrentSnapshot, createProductSyncRelease, getProductSyncRelease } from '../../../../apps/api/lib/productSync.js';

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
  return JSON.parse(JSON.stringify(data));
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

async function approve() {
  const scope=await read('scope.json');await read('local-save.json');
  await ensureProductSyncSchema();
  let state=await maybeRead('state.json')||{};
  const operationId='vendor-reconciled-markup-45-2026-10-08';
  if(!state.auditId) {
    const [[existing]]=await pool.query("SELECT id FROM product_sync_audits WHERE JSON_UNQUOTE(JSON_EXTRACT(options_json,'$.operationId'))=? ORDER BY id DESC LIMIT 1",[operationId]);
    if(existing) {state.auditId=existing.id;await save('state.json',state);}
  }
  if(!state.auditId) {
    const current=await catalog(); const records=[];
    for(const row of scope.eligible) records.push(await read(`audit/${row.id}.json`));
    const actions=records.map(r=>{
      const c={...r.context,profile:current.productPricingProfiles.find(p=>p.productId===r.productId)};
      if(r.productId!==1011876)assert.equal(Number(c.profile?.markupOverride),0.45);
      if(!r.payload) return {direction:'outgoing',platform:'localline',kind:'error',productId:r.productId,productName:c.product.name,vendorName:c.vendor.name,status:'blocked',message:r.problems.join(' ')};
      const action={direction:'outgoing',platform:'localline',kind:'update',productId:r.productId,productName:c.product.name,vendorName:c.vendor.name,status:'changed',
        staged:{},includeInventory:false,includeVisibility:false,mapping:localLineMapping(c),localBefore:localLineInputs(c,false,false),localAfter:localLineInputs(c,false,false),
        payload:r.payload,createPayload:null,imageSources:[],remoteBefore:{fields:localLineProjection(r.remote,r.payload),images:null},desired:{fields:localLineProjection(r.payload,r.payload,true),images:null},
        localSnapshot:{productId:c.product.id,productName:c.product.name,visible:Number(c.product.visible||0),trackInventory:Number(c.product.trackInventory||0),inventory:Number(c.product.inventory||0),
          onSale:Number(c.sale.onSale??c.profile?.onSale??0),saleDiscount:Number(c.sale.saleDiscount??c.profile?.saleDiscount??0)},
        message:r.productId===1011876?'Approved vendor assignment only; Classic Pork Broth pricing excluded.':'Approved vendor reconciliation and markup 45%; existing base prices and unrelated fields preserved.',warnings:r.warnings};
      action.display={current:action.remoteBefore,proposed:action.desired};return action;
    });
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [audit]=await connection.query(`INSERT INTO product_sync_audits(status,options_json,summary_json,created_by,created_at,finished_at,localline_refreshed_at)
        VALUES ('completed',?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
      [JSON.stringify({operationId,platforms:['localline'],productIds:scope.eligible.map(p=>p.id),productScope:'selected',vendorGroup:'all',incoming:false,staged:{},auditedProductCount:scope.eligible.length,priceOnly:false,vendorReconciliation:true}),
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
      const release=await createProductSyncRelease({auditId:state.auditId,actionIds:actions.map(a=>a.id),name:'Vendor corrections and remaining markup updates (October 9, 2026)'},scope.user);
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
      assert.deepEqual(Object.keys(action.payload).sort(),action.productId===1011876?['vendor']:['packages','vendor']);
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

const approvedLocalVendors = new Map([[928741,4547],[928742,4547],[957990,3182],[981122,3182],[981124,3182],[1011876,3694]]);
function protection(c) {
  if(c.product.id===1011876) return 'Classic Pork Broth: expressly excluded from markup';
  if(/deck|hyland|creamy cow/i.test(`${c.vendor?.name||''} ${c.product.name||''}`)) return 'Deck / Hyland / Creamy Cow exclusion';
  if(/deposit/i.test(c.product.name||'')) return 'Deposit';
  if(c.categoryName.trim().toLowerCase()==='membership') return 'Membership';
  if(c.product.isDeleted) return 'Deleted';
  if(!c.vendor?.id||!c.vendor.name.trim()) return 'Missing vendor';
  return null;
}
async function preparePrices() {
  await read('vendor-save.json');
  await mkdir(new URL('audit/',directory),{recursive:true});await mkdir(new URL('verification/',directory),{recursive:true});
  assert.equal(await maybeRead('state.json'),null,'A release exists; use its saved scope');
  const before=await catalog();await save('pricing-before.json',before,true);
  const previous=(await read('../audit-summary.json')).exceptions;
  const assignments=(await read('vendor-plan.json')).changes;
  const targets=new Set([...previous.map(p=>p.id),...assignments.map(p=>p.id),1011876]);
  const rows=before.products.map(p=>{const c=contextFrom(before,p);return {id:p.id,name:p.name,vendorId:p.vendorId,vendor:c.vendor?.name||'',category:c.categoryName,visible:Boolean(p.visible),reason:protection(c),vendorOnly:p.id===1011876,newLocalMarkup:targets.has(p.id)&&!protection(c)&&Number(c.profile?.markupOverride)!==0.45};});
  const eligible=rows.filter(p=>targets.has(p.id)&&(!p.reason||p.vendorOnly));
  assert.equal(eligible.length,151);assert.equal(eligible.filter(p=>p.newLocalMarkup).length,62);
  const scope={createdAt:new Date().toISOString(),...(await actor()),eligible,excluded:rows.filter(p=>!eligible.includes(p)),catalogCount:rows.length};await save('scope.json',scope,true);
  const resolvedVendors=new Map();
  for(const row of eligible)if(!resolvedVendors.has(row.vendorId))resolvedVendors.set(row.vendorId,await resolveLocalLineVendor(contextFrom(before,before.products.find(p=>p.id===row.id)),await getLocalLineAccessToken()));
  let done=0;const counts={};
  await parallelRead(eligible,async row=>{
    const c=await loadLocalLineSyncContext(getDb(),row.id);let remote=null,payload=null;const problems=[],warnings=[];
    c.localLineVendorId=resolvedVendors.get(row.vendorId);
    try{
      assert.ok(c.remoteId,'No saved Local Line product link');
      remote=await fetchLocalLineProduct(c.remoteId,await getLocalLineAccessToken());assert.ok(!remote.is_deleted,'Remote product is deleted');
      const remoteVendorId=Number(remote.vendor?.id??remote.vendor)||null;
      if(approvedLocalVendors.has(row.id)){
        assert.equal(c.localLineVendorId,approvedLocalVendors.get(row.id));
        assert.ok(remoteVendorId===null||remoteVendorId===c.localLineVendorId,'Remote vendor changed after user review');
        if(remoteVendorId===null)warnings.push('User approved using the current local vendor for this unassigned Local Line product.');
      }else assert.equal(remoteVendorId,c.localLineVendorId,'Live vendor differs from the reconciled local vendor');
      if(row.vendorOnly){payload={vendor:c.localLineVendorId};warnings.push('Vendor assignment only. No markup, prices, packages or sales sent.');}
      else{
        assert.equal(protection(c),null);
        const remoteContext=structuredClone(c),mapping=localLineMapping(c);
        for(const pkg of remoteContext.packages){
          const remoteId=mapping.packages.find(m=>m.packageId===pkg.id)?.remoteId,rp=remote.packages.find(p=>Number(p.id)===remoteId);assert.ok(rp,`No confirmed remote package for ${pkg.id}`);
          assert.ok(Number.isFinite(Number(rp.unit_price))&&Number(rp.unit_price)>=0);
          if(Number(pkg.price)!==Number(rp.unit_price))warnings.push(`Package ${pkg.id}: local and remote base prices differ; each preserved.`);
          pkg.price=Number(rp.unit_price);
        }
        const next=buildLocalLinePricePayload({...remoteContext,profile:{...c.profile,markupOverride:0.45}},remote,c.sale);
        const packages=next.packages.map(pkg=>{
          const rp=remote.packages.find(p=>Number(p.id)===Number(pkg.id));
          const entries=pkg.price_list_entries.filter(entry=>rp.price_list_entries.some(e=>Number(e.price_list_id??e.price_list)===entry.price_list)).map(entry=>{
            const live=rp.price_list_entries.find(e=>Number(e.price_list_id??e.price_list)===entry.price_list);assert.ok(live);
            assert.equal(Boolean(live.on_sale_toggle),Boolean(entry.on_sale_toggle),`Sale status differs on package ${pkg.id}, list ${entry.price_list}; held for separate review`);
            return {...entry,max_units_per_order:live.max_units_per_order??null};
          });
          return {id:pkg.id,unit_price:Number(rp.unit_price),price_list_entries:entries};
        });
        assert.equal(packages.length,c.packages.length,'Not every local package is supported');
        payload={vendor:c.localLineVendorId,packages};
      }
    }catch(e){problems.push(e.message.includes('product_is_box')?'Unsupported Local Line box/bundle':e.message.includes('404')?'Local Line product not found (404)':e.message.split('\n')[0]);payload=null;}
    const record={productId:row.id,context:c,remote,payload,problems,warnings,status:payload?'ready':'exception',auditedAt:new Date().toISOString(),vendorOnly:row.vendorOnly,rows:row.vendorOnly?[]:priceRows(c,remote,payload)};
    await save(`audit/${row.id}.json`,record,true);counts[record.status]=(counts[record.status]||0)+1;
    if(++done%20===0||done===eligible.length)console.log(JSON.stringify({audited:done,total:eligible.length,counts}));
  });
  const exceptions=[];for(const row of eligible){const r=await read(`audit/${row.id}.json`);if(r.problems.length)exceptions.push({id:row.id,name:row.name,vendor:row.vendor,problems:r.problems});}
  await save('audit-summary.json',{createdAt:new Date().toISOString(),counts,exceptions});console.log(JSON.stringify({counts,newLocalMarkup:62,exceptions},null,2));
}
async function savePricing(){
  if(await maybeRead('local-save.json')){console.log('Local pricing already saved');return;}
  const scope=await read('scope.json'),before=await read('pricing-before.json'),ids=scope.eligible.filter(p=>p.newLocalMarkup).map(p=>p.id);
  assert.equal(ids.length,62);assert.ok(!ids.includes(1011876));
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    await connection.query('SELECT id FROM products WHERE id IN (?) FOR UPDATE',[ids]);
    await connection.query('SELECT product_id FROM product_pricing_profiles WHERE product_id IN (?) FOR UPDATE',[ids]);
    await connection.query('SELECT id FROM vendors FOR UPDATE');
    const current=await catalog();
    for(const id of ids){const c=contextFrom(current,current.products.find(p=>p.id===id)),prior=contextFrom(before,before.products.find(p=>p.id===id));assert.equal(protection(c),null);assert.ok(same(localLineInputs(c,false,false),localLineInputs(prior,false,false)),`Local pricing changed for ${id}`);}
    await connection.query(`INSERT INTO product_pricing_profiles
      (product_id,markup_override,guest_markup,member_markup,herd_share_markup,snap_markup,on_sale,sale_discount,remote_sync_status,remote_sync_message,price_changed_at,created_at,updated_at)
      SELECT p.id,0.45,0.45,0.45,0.45,0.45,COALESCE(ps.on_sale,0),ps.sale_discount,'pending',
      'Vendor reconciliation: approved product markup 45%; Local Line publication pending.',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP()
      FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id WHERE p.id IN (?)
      ON DUPLICATE KEY UPDATE markup_override=VALUES(markup_override),guest_markup=VALUES(guest_markup),member_markup=VALUES(member_markup),
      herd_share_markup=VALUES(herd_share_markup),snap_markup=VALUES(snap_markup),remote_sync_status=VALUES(remote_sync_status),remote_sync_message=VALUES(remote_sync_message),price_changed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP()`,[ids]);
    await connection.commit();
    await save('local-save.json',{savedAt:new Date().toISOString(),count:ids.length,productIds:ids},true);
    const after=await catalog(),checks=preservation(before,after,new Set(ids));assert.ok(Object.values(checks).every(Boolean));
    for(const row of scope.eligible.filter(p=>!p.vendorOnly)){const c=contextFrom(after,after.products.find(p=>p.id===row.id));assert.ok(fields.every(f=>snapshot(c).profile[f]===0.45));}
    await save('local-verification.json',{verifiedAt:new Date().toISOString(),checks,newlyUpdated:ids.length,totalAt45:scope.eligible.filter(p=>!p.vendorOnly).length});
    console.log(JSON.stringify({saved:ids.length,checks}));
  }catch(e){await connection.rollback();throw e;}finally{connection.release();}
}
function protectedRemote(remote,allowVendorChange=false){
  const keys=['id','name',...allowVendorChange?[]:['vendor'],'description','visible','track_inventory','images','package_codes_enabled'];
  return {product:Object.fromEntries(keys.map(k=>[k,remote[k]??null])),packages:remote.packages.map(p=>Object.fromEntries(['id','name','unit_price','inventory_per_unit','package_code','vendor_package_code','track_type'].map(k=>[k,p[k]??null])))};
}
async function verifyPricing(){
  const scope=await read('scope.json'),state=await read('state.json'),release=await getProductSyncRelease(state.releaseId);await save('release.json',release);
  const complete=release.actions.filter(a=>a.status==='completed');let done=0;
  await parallelRead(complete,async a=>{
    const r=await read(`audit/${a.productId}.json`),remote=await fetchLocalLineProduct(a.mapping.productId,await getLocalLineAccessToken());
    const priceConfirmed=same(localLineProjection(remote,a.payload),localLineProjection(a.payload,a.payload,true));
    const otherFieldsUnchanged=same(protectedRemote(remote,approvedLocalVendors.has(a.productId)),protectedRemote(r.remote,approvedLocalVendors.has(a.productId)));
    const classicPricesUnchanged=a.productId!==1011876||same(remote.packages,r.remote.packages);
    await save(`verification/${a.productId}.json`,{verifiedAt:new Date().toISOString(),productId:a.productId,priceConfirmed,otherFieldsUnchanged,classicPricesUnchanged,remote});
    assert.ok(priceConfirmed&&otherFieldsUnchanged&&classicPricesUnchanged,`Readback failed for ${a.productId}`);
    await upsertLocalLineProductMeta(getDb(),a.productId,a.mapping.productId,{vendorName:r.context.vendor.name,rawJson:JSON.stringify(remote),lastSyncedAt:new Date()});
    if(++done%20===0||done===complete.length)console.log(JSON.stringify({verified:done,total:complete.length}));
  });
  const before=await read('pricing-before.json'),after=await catalog();await save('catalog-after.json',after);
  const checks=preservation(before,after,new Set(scope.eligible.filter(p=>!p.vendorOnly).map(p=>p.id)));
  const classicBefore=contextFrom(before,before.products.find(p=>p.id===1011876)),classicAfter=contextFrom(after,after.products.find(p=>p.id===1011876));
  checks.classicPorkBrothPricing=same(snapshot(classicBefore),snapshot(classicAfter));
  checks.local45=scope.eligible.filter(p=>!p.vendorOnly).every(p=>fields.every(f=>snapshot(contextFrom(after,after.products.find(x=>x.id===p.id))).profile[f]===0.45));
  assert.ok(Object.values(checks).every(Boolean));
  const summary={verifiedAt:new Date().toISOString(),newLocal45:scope.eligible.filter(p=>p.newLocalMarkup).length,remotePriceProducts:complete.filter(a=>a.productId!==1011876).length,
    remoteVendorOnlyProducts:complete.filter(a=>a.productId===1011876).length,remoteVendorsFilled:complete.filter(a=>approvedLocalVendors.has(a.productId)).length,
    remoteHeld:scope.eligible.length-complete.length,checks,...state,releaseStatus:release.status};await save('verification-summary.json',summary);console.log(JSON.stringify(summary,null,2));
}
export async function run(phase){
  if(phase==='prepare-prices')await preparePrices();
  else if(phase==='review-sparse-entry'){
    const r=await read('audit/1163510.json'),c=r.context,remote=r.remote;
    assert.equal(r.status,'exception');assert.equal(Number(remote.vendor),c.localLineVendorId);
    const next=buildLocalLinePricePayload({...c,profile:{...c.profile,markupOverride:0.45}},remote,c.sale);
    const packages=next.packages.map(pkg=>{const rp=remote.packages.find(p=>p.id===pkg.id);assert.equal(Number(rp.unit_price),Number(pkg.unit_price));return {id:pkg.id,unit_price:Number(rp.unit_price),price_list_entries:pkg.price_list_entries.filter(entry=>rp.price_list_entries.some(e=>Number(e.price_list_id??e.price_list)===entry.price_list)).map(entry=>{const live=rp.price_list_entries.find(e=>Number(e.price_list_id??e.price_list)===entry.price_list);assert.equal(Boolean(live.on_sale_toggle),Boolean(entry.on_sale_toggle));return {...entry,max_units_per_order:live.max_units_per_order??null};})};});
    assert.equal(packages.reduce((n,p)=>n+p.price_list_entries.length,0),7);
    r.payload={vendor:c.localLineVendorId,packages};r.problems=[];r.status='ready';r.warnings.push('The 10 lb bag has no CSA Members entry; its other existing listings are updated, and no missing listing is created.');r.rows=priceRows(c,remote,r.payload);await save('audit/1163510.json',r);
    const scope=await read('scope.json'),records=[];for(const row of scope.eligible)records.push(await read(`audit/${row.id}.json`));
    const result={createdAt:new Date().toISOString(),counts:{ready:records.filter(x=>x.payload).length,exception:records.filter(x=>!x.payload).length},exceptions:records.filter(x=>!x.payload).map(x=>({id:x.productId,name:x.context.product.name,vendor:x.context.vendor.name,problems:x.problems}))};await save('audit-summary.json',result);console.log(JSON.stringify(result.counts));
  }
  else if(phase==='save-prices')await savePricing();
  else if(phase==='approve-prices')await approve();
  else if(phase==='publish-prices')await publish();
  else if(phase==='verify-prices')await verifyPricing();
  else throw new Error('Unknown price phase');
}

