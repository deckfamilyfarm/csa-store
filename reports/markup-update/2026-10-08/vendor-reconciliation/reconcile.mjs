import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import XLSX from '../../../../apps/api/node_modules/xlsx/xlsx.js';
import {getDb,getPool} from '../../../../apps/api/db.js';
import * as schema from '../../../../apps/api/schema.js';
import {getLocalLineAccessToken,getLocalLineBaseUrl} from '../../../../apps/api/localLineAuth.js';
import {fetchLocalLineProduct} from '../../../../apps/api/localLine.js';
import {same} from '../../../../apps/api/lib/productSyncCore.js';
import {computeProductPricingSnapshot} from '../../../../apps/api/lib/productPricing.js';
const directory=new URL('./',import.meta.url), pool=getPool();
const read=async name=>JSON.parse(await readFile(new URL(name,directory),'utf8'));
const maybeRead=async name=>{try{return await read(name);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function save(name,value,exclusive=false){const file=new URL(name,directory);if(exclusive)return writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});const temp=new URL(name+'.tmp',directory);await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,file);}
const files=['vendors','categories','products','packages','productPricingProfiles','productSales','localLineProductMeta','localLinePackageMeta'];
async function catalog(connection=null){const result={};for(const key of files)result[key]=await getDb().select().from(schema[key]);return JSON.parse(JSON.stringify(result));}
const normalized=value=>String(value||'').trim().toLowerCase();
async function collection(path){const base=getLocalLineBaseUrl(),out=[];let next=new URL(path,base).href;while(next){assert.equal(new URL(next).origin,new URL(base).origin);const response=await fetch(next,{headers:{Authorization:`Bearer ${await getLocalLineAccessToken()}`},signal:AbortSignal.timeout(120000)});assert.ok(response.ok,`Local Line collection HTTP ${response.status}`);const data=await response.json();if(Array.isArray(data)){out.push(...data);break;}assert.ok(Array.isArray(data.results));out.push(...data.results);next=data.next?new URL(data.next,base).href:null;}return out;}
async function snapshot(){
  await mkdir(new URL('details/',directory),{recursive:true});
  if(!await maybeRead('catalog-before.json'))await save('catalog-before.json',await catalog(),true);
  const vendors=await collection('vendors/?page_size=100');await save('remote-vendors.json',vendors);
  const response=await fetch(new URL('products/export/?direct=true',getLocalLineBaseUrl()),{headers:{Authorization:`Bearer ${await getLocalLineAccessToken()}`},signal:AbortSignal.timeout(120000)});
  assert.ok(response.ok,`Local Line export HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());await writeFile(new URL('live-products-export.xlsx',directory),bytes);
  const book=XLSX.read(bytes,{type:'buffer'});assert.ok(book.Sheets.Availability);
  const products=XLSX.utils.sheet_to_json(book.Sheets.Availability);await save('remote-products.json',products);
  console.log(JSON.stringify({vendors:vendors.length,vendorFields:Object.keys(vendors[0]||{}),vendorNames:vendors.map(v=>({id:v.id,name:v.name})),products:products.length,exportFields:Object.keys(products[0]||{})},null,2));
}
async function parallel(items,operation){let i=0;const results=await Promise.allSettled(Array.from({length:4},async()=>{while(i<items.length)await operation(items[i++]);}));for(const r of results)if(r.status==='rejected')throw r.reason;}
async function plan(){
  const before=await read('catalog-before.json'),vendors=await read('remote-vendors.json'),exportRows=await read('remote-products.json');
  const remoteById=new Map(exportRows.map(p=>[Number(p['Local Line Product ID']),p]));
  const changes=[],unchanged=[],exceptions=[];let done=0;
  const oldExceptions=(await read('../audit-summary.json')).exceptions;
  await parallel(before.products,async product=>{
    const meta=before.localLineProductMeta.find(m=>m.productId===product.id);
    const remoteId=Number(meta?.localLineProductId)||product.id;
    const row=remoteById.get(remoteId);const matches=vendors.filter(v=>normalized(v.name)===normalized(row?.Vendor));
    let vendorId=matches.length===1?Number(matches[0].id):null;
    const oldVendor=before.vendors.find(v=>v.id===product.vendorId);
    const record={id:product.id,name:product.name,remoteId,oldVendorId:product.vendorId,oldVendor:oldVendor?.name||'',vendorId,vendor:matches[0]?.name||'',source:'Live Local Line export + /vendors/',hasLink:Boolean(meta?.localLineProductId)};
    if(!row||vendorId!==product.vendorId||oldExceptions.some(x=>x.id===product.id)){
      let detail=await maybeRead(`details/${product.id}.json`);
      if(!detail){try{detail={remote:await fetchLocalLineProduct(remoteId,await getLocalLineAccessToken()),fetchedAt:new Date().toISOString()};}catch(e){detail={error:e.message,fetchedAt:new Date().toISOString()};}await save(`details/${product.id}.json`,detail,true);}
      if(detail.remote){
        assert.equal(Number(detail.remote.id),remoteId);
        vendorId=Number(detail.remote.vendor?.id??detail.remote.vendor)||null;
        const vendor=vendors.find(v=>Number(v.id)===vendorId);assert.ok(!vendorId||vendor,'Remote product references unknown live vendor');
        Object.assign(record,{vendorId,vendor:vendor?.name||'',source:'Live product detail + /vendors/',remoteName:detail.remote.name});
        if(detail.remote.is_deleted)record.issue='Local Line product is deleted';
      }else if(!row)record.issue=detail.error;
      else record.detailWarning=detail.error;
    }
    if(!record.issue&&!record.vendorId)record.issue='Local Line has no vendor assigned; cannot assign a valid vendor or publish prices';
    if(!record.issue&&!record.hasLink)record.issue='No saved Local Line product link; requires reviewed mapping';
    if(record.issue)exceptions.push(record);
    else if(record.vendorId!==product.vendorId)changes.push(record);
    else unchanged.push(record);
    if(++done%100===0)console.log(JSON.stringify({checked:done,total:before.products.length}));
  });
  const vendorChanges=vendors.filter(v=>!before.vendors.some(l=>l.id===Number(v.id)&&l.name===v.name)).map(v=>({id:Number(v.id),name:v.name,oldName:before.vendors.find(l=>l.id===Number(v.id))?.name??null}));
  const result={createdAt:new Date().toISOString(),vendorChanges,changes:changes.sort((a,b)=>a.id-b.id),unchanged,exceptions};await save('vendor-plan.json',result);
  console.log(JSON.stringify({vendorChanges,productChanges:changes.length,missingVendorsResolved:changes.filter(x=>!x.oldVendorId).length,protectedVendorChanges:changes.filter(x=>/deck|hyland|creamy cow/i.test(x.oldVendor+' '+x.vendor)),exceptions:exceptions.map(x=>({id:x.id,name:x.name,reason:x.issue}))},null,2));
}
const sorted=rows=>rows.slice().sort((a,b)=>Number(a.id??a.productId)-Number(b.id??b.productId));
const without=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
function pricing(data,id){const product=data.products.find(p=>p.id===id);return computeProductPricingSnapshot({product,vendor:data.vendors.find(v=>v.id===product.vendorId),profile:{...data.productPricingProfiles.find(p=>p.productId===id),...data.productSales.find(p=>p.productId===id)},packages:data.packages.filter(p=>p.productId===id),packageMetaByPackageId:new Map(data.localLinePackageMeta.filter(p=>p.productId===id).map(p=>[p.packageId,p]))});}
async function applyVendors(){
  const done=await maybeRead('vendor-save.json');if(done){console.log(JSON.stringify(done));return;}
  const before=await read('catalog-before.json'),plan=await read('vendor-plan.json');
  // Do not invent assignments for missing/deleted remote products or unnamed vendors.
  assert.equal(plan.changes.length,123);assert.equal(plan.vendorChanges.length,6);
  const connection=await pool.getConnection();
  try{
    await connection.beginTransaction();
    for(const table of ['vendors','products','packages','product_pricing_profiles','product_sales','local_line_product_meta'])await connection.query(`SELECT * FROM ${table} FOR UPDATE`);
    const current=await catalog();for(const key of files)assert.ok(same(sorted(current[key]),sorted(before[key])),`${key} changed after preview`);
    for(const vendor of plan.vendorChanges){assert.equal(vendor.oldName,null);await connection.query('INSERT INTO vendors (id,name) VALUES (?,?)',[vendor.id,vendor.name]);}
    for(const product of plan.changes){
      const [result]=await connection.query('UPDATE products SET vendor_id=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND vendor_id <=> ?',[product.vendorId,product.id,product.oldVendorId]);assert.equal(result.affectedRows,1);
    }
    let cacheUpdated=0;
    for(const record of [...plan.changes,...plan.unchanged]){
      const [result]=await connection.query('UPDATE local_line_product_meta SET vendor_name=? WHERE product_id=? AND local_line_product_id=? AND NOT (vendor_name <=> ?)',[record.vendor,record.id,record.remoteId,record.vendor]);cacheUpdated+=result.affectedRows;
    }
    await connection.commit();
    const after=await catalog();await save('catalog-after-vendors.json',after);
    const ids=new Set(plan.changes.map(p=>p.id));const checks={};
    for(const key of ['categories','packages','productPricingProfiles','productSales','localLinePackageMeta'])checks[key]=same(sorted(before[key]),sorted(after[key]));
    checks.existingVendorPricing=before.vendors.every(v=>same(v,after.vendors.find(a=>a.id===v.id)));
    checks.onlyProductVendorsChanged=before.products.every(p=>same(without(p,['vendorId','updatedAt']),without(after.products.find(a=>a.id===p.id),['vendorId','updatedAt'])));
    checks.otherAssignments=before.products.filter(p=>!ids.has(p.id)).every(p=>same(p,after.products.find(a=>a.id===p.id)));
    checks.assignmentsConfirmed=plan.changes.every(p=>after.products.find(a=>a.id===p.id).vendorId===p.vendorId);
    checks.protectedPrices=before.products.filter(p=>/deck|hyland|creamy cow/i.test(before.vendors.find(v=>v.id===p.vendorId)?.name||'')).every(p=>same(pricing(before,p.id).packages,pricing(after,p.id).packages));
    const result={savedAt:new Date().toISOString(),vendorsInserted:6,productsReassigned:plan.changes.length,missingVendorsResolved:plan.changes.filter(p=>!p.oldVendorId).length,cacheUpdated,checks};await save('vendor-save.json',result,true);
    assert.ok(Object.values(checks).every(Boolean),'Vendor preservation check failed');console.log(JSON.stringify(result,null,2));
  }catch(e){await connection.rollback();throw e;}finally{connection.release();}
}
async function drift(){const before=await read('catalog-before.json'),after=await catalog();await save('catalog-current.json',after);for(const key of files){const rows=[];for(const row of after[key]){const prior=before[key].find(p=>(p.id??p.productId)===(row.id??row.productId));if(!same(row,prior))rows.push({id:row.id??row.productId,changes:Object.keys(row).filter(k=>!same(row[k],prior?.[k])).map(k=>({key:k,before:prior?.[k],after:row[k]}))});}console.log(JSON.stringify({table:key,count:rows.length,rows:rows.slice(0,6)},null,2));}}
async function refresh(){
  assert.equal(await maybeRead('vendor-save.json'),null,'Vendor save already completed');
  const archive=`preview-${new Date().toISOString().replace(/[:.]/g,'-')}/`;await mkdir(new URL(archive,directory));
  for(const file of ['catalog-before.json','remote-vendors.json','remote-products.json','live-products-export.xlsx','vendor-plan.json','details']){
    try{await rename(new URL(file,directory),new URL(archive+file,directory));}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  await snapshot();await plan();
}
try{const phase=process.argv[2];if(phase==='snapshot')await snapshot();else if(phase==='plan')await plan();else if(phase==='refresh-plan')await refresh();else if(phase==='apply-vendors')await applyVendors();else if(phase==='drift')await drift();else await (await import('./prices.mjs')).run(phase);}finally{await pool.end();}
