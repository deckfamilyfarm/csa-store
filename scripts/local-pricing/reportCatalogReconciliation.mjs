// Offline verification and workbook; never loads credentials or opens a database.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as XLSX from '../../apps/api/node_modules/xlsx/xlsx.mjs';
import {fingerprint} from '../../apps/api/lib/productSyncCore.js';
import {remoteEntryCents} from './catalogReconciliationPlan.mjs';
const root=process.argv.find(arg=>arg.startsWith('--snapshot='))?.slice(11);
if(!root)throw new Error('Provide --snapshot=<reconciliation folder>.');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const plan=read('plan.json'),before=read('local-before.json').tables,after=read('local-after.json').tables;
assert.ok(plan.applied,'Apply the reviewed plan before verification.');
const hash=rows=>fingerprint(rows.map(fingerprint).sort());
const protectedTables=Object.keys(before).filter(name=>name.startsWith('enterprise_')||['product_pricing_profiles','product_sales','square_variation_links'].includes(name));
for(const table of protectedTables)assert.equal(hash(after[table]),hash(before[table]),`${table} must be preserved`);
const products=new Map(after.products.map(p=>[p.id,p])),vendors=new Map(after.vendors.map(v=>[v.id,v.name]));
for(const p of before.products){const current=products.get(p.id);assert.ok(current);
  for(const field of ['stock_on_farm','stock_on_farm_lbs','farm_stock_revision'])assert.deepEqual(current[field],p[field],`${p.name}: ${field}`);
}
for(const change of plan.products)for(const[field,value]of Object.entries(change.updates))assert.deepEqual(products.get(change.id)[field],value,`Product ${change.id} ${field}`);
for(const pkg of before.packages){const current=after.packages.find(p=>p.id===pkg.id);assert.deepEqual(current,pkg,`Existing package ${pkg.id} must be preserved`);}
for(const product of plan.newProducts){assert.ok(products.has(product.id));assert.equal(products.get(product.id).stock_on_farm,null);}
for(const row of plan.channelPrices){
  const cached=after.local_line_price_list_entries.find(e=>e.product_id===row.productId&&e.package_id===row.packageId&&e.local_line_price_list_id===row.listId);
  assert.ok(cached,`Missing price observation ${row.packageId}/${row.listId}`);
  assert.equal(cached.final_price_cache==null?null:Math.round(Number(cached.final_price_cache)*100),row.currentCents);
}
const square=read('remote/square-catalog.json');let variations=0;
for(const item of square.objects.filter(o=>o.type==='ITEM'))for(const variation of item.item_data.variations||[]){
  const cached=after.square_catalog_variations.find(v=>v.square_variation_id===variation.id);
  assert.ok(cached);assert.deepEqual(JSON.parse(cached.raw_json),variation);variations++;
}
const revisionById=new Map(after.enterprise_pricing_revisions.map(r=>[r.id,r]));
const stateByProduct=new Map(after.enterprise_pricing_product_state.map(s=>[s.product_id,s]));
const buyDrafts=new Map(after.enterprise_pricing_buy_price_drafts.map(d=>[d.product_id,d]));
const pricing=id=>{const r=revisionById.get(stateByProduct.get(id)?.latest_revision_id);return r?{input:JSON.parse(r.input_json),output:JSON.parse(r.output_json)}:null;};
const pricingColumns=(id,packageId)=>{
  const p=pricing(id),pkg=p?.output.packages?.find(p=>p.packageId===packageId);
  return {'Local Buy Price':buyDrafts.has(id)?Number(buyDrafts.get(id).price):p?p.output.buyFromTenThousandths/10000:null,
    'Pricing unit':p?.input.pricingUnit||'',Preset:p?.input.markupCategory||'Needs pricing inputs','Markup %':p?p.output.appliedMarkupBp/100:null,
    'Local FF package price':pkg?pkg.localLineSaleCents/100:null,'Local Square unit price':p?.output.squareUnitCents==null?null:p.output.squareUnitCents/100};
};
const report={appliedAt:plan.appliedAt,database:plan.database,protectedTables:protectedTables.length,existingProductsPreservedFarm:before.products.length,existingPackagesPreserved:before.packages.length,
  verifiedLocalLinePrices:plan.channelPrices.length,verifiedSquareVariations:variations,externalWrites:0,allPassed:true};
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2),{mode:0o600});
const workbook=XLSX.utils.book_new();
function sheet(name,rows){
  const safe=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v==null?'':typeof v==='object'?JSON.stringify(v):v])));
  const ws=XLSX.utils.json_to_sheet(safe.length?safe:[{Result:'None'}]);
  const keys=Object.keys(safe[0]||{Result:''});ws['!cols']=keys.map(k=>({wch:Math.min(65,Math.max(k.length+2,...safe.map(r=>String(r[k]??'').length)))}));
  ws['!autofilter']={ref:ws['!ref']};XLSX.utils.book_append_sheet(workbook,ws,name);
}
sheet('Summary',[
  {Item:'Applied locally',Value:plan.appliedAt},
  {Item:'Remote capture',Value:plan.capturedAt},
  {Item:'Original clone baseline',Value:plan.sourceSnapshotAt},
  {Item:'Pricing policy',Value:'New local Buy Prices, presets, overrides, histories and approvals preserved. Remote prices captured for comparison only.'},
  ...Object.entries(plan.summary).map(([Item,Value])=>({Item,Value})),
  {Item:'Local Line bundle holds',Value:plan.remoteErrors.length},
  {Item:'Local Line observed prices refreshed',Value:report.verifiedLocalLinePrices},
  {Item:'Square variations verified',Value:variations},
  {Item:'External writes',Value:0},
  {Item:'Before deployment',Value:'Resolve price/unit/mapping holds; set pricing on new products; take a fresh channel snapshot at cutover.'},
  {Item:'Production migration scope',Value:'Apply reviewed catalog/pricing changes into the current production database. Preserve production orders, payments, users and operational history; do not replace production with this old clone.'},
  {Item:'Bundle limitation',Value:'14 export products are boxes; product-detail reads are unavailable. Separate box snapshots retained, but IDs not safely mapped. Existing local bundles preserved.'},
]);
sheet('Recent LL prices',plan.priceChanges.map(row=>({'Product ID':row.id,Product:row.name,Vendor:vendors.get(products.get(row.id)?.vendor_id),Package:row.packageId,Change:row.kind,Basket:row.listName||'',
  'Previous remote price':row.before,'Current remote price':row.remote,...pricingColumns(row.id,row.packageId),Decision:row.decision})));
const locations=read('remote/square-locations.json');
const locationRows=Array.isArray(locations)?locations:locations.locations||[];
const locationName=id=>locationRows.find(l=>l.id===id)?.name||id;
const overrides=v=>(v?.location_overrides||[]).filter(o=>o.price_money).map(o=>`${locationName(o.location_id)}: $${(o.price_money.amount/100).toFixed(2)}`).join('; ');
const unit=id=>{if(!id)return 'each (no measurement unit)';const o=square.objects.find(o=>o.id===id);return o?.measurement_unit_data?.measurement_unit?.weight_unit||id;};
sheet('Square changes',plan.squareChanges.map(row=>({Product:row.name,Variation:row.current.name,'Variation ID':row.variationId,'Linked local products':row.localProductIds.join(', '),
  'Changed fields':row.fields.join(', '),'Previous remote price':row.old?.price_money?.amount/100,'Current remote price':row.current.price_money?.amount/100,
  'Previous Square unit':unit(row.old?.measurement_unit_id),'Current Square unit':unit(row.current.measurement_unit_id),
  'Previous location prices':overrides(row.old),'Current location prices':overrides(row.current),
  'Local Square unit price':row.localProductIds.map(id=>pricingColumns(id)['Local Square unit price']).join(', '),Decision:'Review price, unit and location differences; local pricing and approved links retained'})));
sheet('Catalog updates',plan.products.flatMap(row=>row.changes.map(c=>({'Product ID':row.id,Product:row.name,Field:c.field,Before:c.before,After:c.after}))));
sheet('New products',plan.newProducts.map(p=>({'Product ID':p.id,Product:p.values.name,Vendor:vendors.get(p.values.vendor_id),'Remote base price':p.packages[0]?.price,'Remote package':p.packages[0]?.name,Action:'Set reviewed Buy Price, pricing unit and markup preset before publication'})));
sheet('Review holds',[
  ...plan.conflicts.map(c=>({'Product ID':c.id,Product:c.name,Issue:c.reason,Details:c.categories||c.fields||c.field||'',Local:c.local,Remote:c.remote})),
  ...plan.missingFromExport.map(c=>({'Product ID':c.id,Product:c.name,Issue:c.reason})),
  ...plan.remoteErrors.map(c=>({'Product ID':c.productId,Product:products.get(c.productId)?.name,Issue:'Bundle detail/mapping unresolved; existing local record preserved'}))
]);
sheet('All LL comparisons',plan.channelPrices.map(row=>{
  const local=pricingColumns(row.productId,row.packageId),current=row.currentCents==null?null:row.currentCents/100,target=local['Local FF package price'];
  return {'Product ID':row.productId,Product:products.get(row.productId)?.name,Vendor:vendors.get(products.get(row.productId)?.vendor_id),Package:row.package.name,'Package ID':row.packageId,Basket:row.listName,
    'Current remote package price':current,...local,'Local minus remote':target==null||current==null?null:Math.round((target-current)*100)/100,
    Status:target==null?'Needs pricing inputs':current==null?'Remote price unresolved':Math.round(target*100)===row.currentCents?'Matches':'Review difference'};
}));
sheet('All Square prices',square.objects.filter(o=>o.type==='ITEM').flatMap(item=>(item.item_data.variations||[]).map(v=>{
  const links=after.square_variation_links.filter(l=>l.square_variation_id===v.id),current=v.item_variation_data;
  return {Product:item.item_data.name,Variation:current.name,'Variation ID':v.id,'Current remote price':current.price_money?.amount/100,
    'Square unit':unit(current.measurement_unit_id),'Location prices':overrides(current),'Linked local products':links.map(l=>l.product_id).join(', '),
    'Local Square unit prices':links.map(l=>pricingColumns(l.product_id)['Local Square unit price']).join(', ')};
})));
const boxes=read('remote/localline-boxes.json'),exported=read('remote/localline-export.json');
sheet('Bundles to match',boxes.flatMap(box=>(box.product_price_list_entries||[]).map(entry=>{
  const cents=remoteEntryCents({unit_price:box.price},entry.box_package_entry);
  return {'Box ID':box.id,Product:box.name,'Name-matched candidates only':exported.availability.filter(p=>p.Product===box.name).map(p=>p['Local Line Product ID']).join(', '),
    'Remote base price':box.price,Basket:entry.price_list_name,'Current remote package price':cents==null?'Unresolved':cents/100,
    'Remote updated at':box.updated_at,Action:'Review explicit box-to-product mapping; no local changes applied'};
})));
sheet('Images',plan.images.map(r=>({'Product ID':r.productId,Product:products.get(r.productId)?.name,'Current image URLs':r.images.map(i=>i.full||i.url).join('\n')})));
sheet('Verification',Object.entries(report).map(([Check,Result])=>({Check,Result})));
const out=path.join(root,'catalog-reconciliation.xlsx');
fs.writeFileSync(out,XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),{mode:0o600});
console.log(JSON.stringify({report:out,...report},null,2));
