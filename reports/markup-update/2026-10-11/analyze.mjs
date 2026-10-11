import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {computeProductPricingSnapshot,computeCustomerPrice,getPriceListDefinitions} from '../../../apps/api/lib/productPricing.js';
const directory=new URL(process.argv.find(a=>a.startsWith('--directory='))?.slice(12)||'./',import.meta.url),read=async n=>JSON.parse(await readFile(new URL(n,directory),'utf8'));
const local=await read('local.json'),scope=await read('scope.json'),exported=await read('remote-export.json'),remoteVendors=await read('remote-vendors.json'),boxProducts=await read('box-products.json'),boxes=await read('remote-boxes.json'),capture=await read('capture-info.json'),info=await read('snapshot-info.json');
const norm=v=>String(v??'').trim().replace(/\s+/g,' ').toLowerCase();
const round=n=>Number(Number(n).toFixed(2)),money=v=>v==null?'Unknown':`$${Number(v).toFixed(2)}`;
const differs=(a,b)=>a==null||b==null?a!==b:Math.abs(Number(a)-Number(b))>0.0049;
const remoteProductIndex=new Map(exported.products.map(p=>[Number(p['Local Line Product ID']),p]));
const vendorIndex=new Map(local.vendors.map(v=>[v.id,v])),remoteVendorIndex=new Map(remoteVendors.map(v=>[Number(v.id),v]));
const groups=new Map(),details=[],unverified=[];
let comparedPrices=0,missingBothVendor=0,emptyBothPackages=0,missingListingCount=0;
function group(row){if(!groups.has(row.id))groups.set(row.id,{productId:row.id,product:row.name,vendor:row.vendor||'Unassigned',category:row.category,localVisible:row.visible,remoteVisible:row.remoteVisible==='Y',remoteId:row.remoteId,issues:[],details:[],fixes:[],decision:'',note:''});return groups.get(row.id);}
function issue(row,type,localValue,remoteValue,fix,extra={}){const g=group(row);if(!g.issues.includes(type))g.issues.push(type);if(!g.fixes.includes(fix))g.fixes.push(fix);const d={productId:row.id,product:row.name,vendor:row.vendor||'Unassigned',type,localValue,remoteValue,suggestedFix:fix,...extra};g.details.push(d);details.push(d);return g;}
function context(row){const p=local.products.find(p=>p.id===row.id);return {product:p,vendor:vendorIndex.get(p.vendorId),categoryName:row.category,profile:local.productPricingProfiles.find(x=>x.productId===p.id)||{},sale:local.productSales.find(x=>x.productId===p.id)||{},packages:local.packages.filter(x=>x.productId===p.id),packageMeta:local.localLinePackageMeta.filter(x=>x.productId===p.id)};}
function actual(base,e){if(!e.adjustment)return round(base);const n=Number(e.adjustment_value);return Number(e.adjustment_type)===1?round(base+n):Number(e.adjustment_type)===2?round(base*(1+n/100)):Number(e.adjustment_type)===3?round(n):null;}
function adjustment(e){return !e.adjustment?'No adjustment':Number(e.adjustment_type)===2?`${e.adjustment_value}% effective adjustment`:Number(e.adjustment_type)===1?`${money(e.adjustment_value)} added`:`Fixed ${money(e.adjustment_value)}`;}
for(const row of scope){
  const c=context(row),record=await read(`details/${row.id}.json`);let remote=record.data,checkedAt=record.checkedAt;
  if(record.error?.code==='product_is_box'){remote=boxProducts.products.find(p=>Number(p.id)===row.remoteId);checkedAt=boxProducts.checkedAt;}
  if(!remote){
    if(record.error?.status===404){
      const candidates=exported.products.filter(p=>norm(p.Product)===norm(row.name));
      const candidateText=candidates.map(p=>`${p.Product} #${p['Local Line Product ID']}${local.localLineProductMeta.some(m=>Number(m.localLineProductId)===Number(p['Local Line Product ID']))?' (already linked locally)':''}`).join('; ');
      issue(row,'Remote product unavailable',`Local product exists${row.hasLink?`; saved link #${row.remoteId}`:'; no saved Local Line link'}`,`Product #${row.remoteId} returned 404${remoteProductIndex.has(row.remoteId)?'; export still lists it':'; absent from live export'}`,
        candidateText?`Review ${candidateText}. Retire the stale local record if this is its replacement; do not create a duplicate or reuse another product’s link blindly.`:'Confirm whether this item is retired. Archive the local record if retired; otherwise locate or restore the intended Local Line product and save its verified link before pricing.',{checkedAt});
    }else unverified.push({productId:row.id,product:row.name,reason:record.error?.detail||'No live detail',checkedAt});
    continue;
  }
  assert.equal(Number(remote.id),row.remoteId);row.remoteVisible=remote.visible?'Y':'N';
  const remoteVendorId=Number(remote.vendor?.id??remote.vendor)||null,remoteVendor=remoteVendorIndex.get(remoteVendorId);
  const localVendorMatches=remoteVendors.filter(v=>norm(v.name)===norm(c.vendor?.name));
  const resolvedLocalVendor=localVendorMatches.find(v=>Number(v.id)===c.product.vendorId)||(localVendorMatches.length===1?localVendorMatches[0]:null);
  const validVendor=Boolean(c.vendor?.name&&resolvedLocalVendor);
  if(!row.hasLink)issue(row,'Missing product link','No saved Local Line product link',`Live product #${remote.id}: ${remote.name}`,'Review the matching product identity and save this Local Line link before publishing.',{checkedAt});
  if((remoteVendorId&&(!validVendor||Number(resolvedLocalVendor.id)!==remoteVendorId))||(!remoteVendorId&&c.vendor?.name)){
    issue(row,'Vendor mismatch',c.vendor?.name||'Unassigned',remoteVendor?.name||(remoteVendorId?`Vendor #${remoteVendorId}`:'Unassigned'),
      remoteVendorId?`Use Local Line’s vendor: ${remoteVendor?.name||remoteVendorId}. Update the local assignment first, then re-audit pricing.`:'Choose the correct vendor in Local Line, then reconcile the local assignment before publishing prices.',{checkedAt});
  }
  if(!validVendor&&!remoteVendorId)missingBothVendor++;
  const snap=computeProductPricingSnapshot({...c,profile:{...c.profile,...c.sale},packageMetaByPackageId:new Map(c.packageMeta.map(m=>[m.packageId,m]))});
  const lists=getPriceListDefinitions(snap.profile),isSale=Boolean(snap.profile.onSale)&&Number(snap.profile.saleDiscount)>0;
  const allRemotePackages=remote.packages||[],mapped=new Set();
  const entries=new Set((remote.product_price_list_entries||[]).map(e=>Number(e.id)));
  const boxMatches=remote.is_box?boxes.boxes.filter(b=>b.product_price_list_entries?.some(e=>entries.has(Number(e.id)))):[];
  const boxId=boxMatches.length===1?Number(boxMatches[0].id):null;
  if(!c.packages.length&&!allRemotePackages.length){emptyBothPackages++;continue;}
  for(const pkg of c.packages){
    const packageId=Number(c.packageMeta.find(m=>m.packageId===pkg.id)?.localLinePackageId)||pkg.id;
    const rp=allRemotePackages.find(p=>Number(p.id)===packageId);mapped.add(packageId);
    if(!rp){issue(row,'Package link mismatch',`Package #${pkg.id} ${pkg.name||''} points to #${packageId}`,'No matching package under the linked live product','Review the package mapping. Relink to the correct package, or retire the stale local package; do not create duplicates.',{packageId:pkg.id,checkedAt});continue;}
    if(differs(pkg.price,rp.unit_price))issue(row,'Base price mismatch',`${pkg.name||pkg.id}: ${money(pkg.price)}`,`${rp.name||rp.id}: ${money(rp.unit_price)}`,'Confirm the intended vendor/base price. Correct the local package price if Local Line is right; otherwise approve a price-only publication of the local base price and markup.',{packageId:pkg.id,remotePackageId:rp.id,checkedAt});
    // Show current fallback pricing too, but require vendor review before any publication.
    for(const list of lists){
      const e=rp.price_list_entries?.find(e=>Number(e.price_list_id??e.price_list)===list.id);
      if(!e){missingListingCount++;continue;}
      comparedPrices++;
      const expected=computeCustomerPrice(pkg.price,snap.profile,pkg.id,list),current=actual(Number(rp.unit_price),e);
      if(current===null){unverified.push({productId:row.id,product:row.name,reason:`Unknown adjustment type ${e.adjustment_type}`,checkedAt});continue;}
      const saleMismatch=Boolean(e.on_sale_toggle)!==expected.onSale;
      const markupMismatch=!expected.overridden&&!expected.onSale&&!e.on_sale_toggle&&Number(e.adjustment_type)===2&&(!e.adjustment||differs(Number(e.adjustment_value),list.markup*100));
      const priceMismatch=differs(current,expected.final);
      const strikeMismatch=(expected.onSale||expected.overridden)&&differs(e.strikethrough_display_value,expected.strikethrough);
      if(!saleMismatch&&!markupMismatch&&!priceMismatch&&!strikeMismatch)continue;
      const type=!validVendor?'Unassigned vendor / price mismatch':saleMismatch||strikeMismatch?'Sale / price mismatch':remote.is_box?'Bundle price mismatch':'Price / markup mismatch';
      const fix=!validVendor?(remoteVendorId?`Assign ${remoteVendor?.name||remoteVendorId} locally first. ${e.adjustment&&Number(e.adjustment_type)===2&&Number(e.adjustment_value)===45&&!e.on_sale_toggle?'The listed remote prices already use 45%; review a local product markup override of 45% to match them.':'Then review the intended product markup and existing remote pricing.'} Do not publish the current unassigned-vendor fallback rates.`:'Choose the correct vendor in Local Line and assign it locally before reviewing pricing. These local values are fallback calculations, not approved rates to publish. If this hidden item is retired, archive it locally instead.'):
        saleMismatch||strikeMismatch?'Decide whether to keep or end the Local Line sale before publishing. If keeping it, review each customer list and make the intended sale settings consistent locally; the local sale model is product-wide. If ending it, approve the local regular price.':remote.is_box?
        `Use Local Line’s box editor${boxId?` (box #${boxId})`:''} to set the listed adjustments to ${list.markup*100}%, or add reviewed box support to the sync integration. Preserve box contents, inventory and existing customer-list membership.`:
        'Review the local base price and markup, then publish only the approved pricing to Local Line and confirm the readback.';
      const g=issue(row,type,`${pkg.name||pkg.id} / ${list.name}: ${money(expected.final)}; markup ${list.markup*100}%; sale ${isSale?'on':'off'}${validVendor?'':' (unassigned-vendor fallback)'}`,`${money(current)}; ${adjustment(e)}; sale ${e.on_sale_toggle?'on':'off'}`,fix,
        {packageId:pkg.id,package:pkg.name||'',remotePackageId:rp.id,priceList:list.name,localBase:Number(pkg.price),remoteBase:Number(rp.unit_price),localMarkupPct:list.markup*100,
          localPrice:expected.final,remotePrice:current,difference:round(expected.final-current),remoteAdjustment:adjustment(e),localSale:expected.onSale,remoteSale:Boolean(e.on_sale_toggle),
          localStrikethrough:expected.strikethrough,remoteStrikethrough:e.strikethrough_display_value??null,localFallback:!validVendor,boxId,checkedAt});
      if(boxId)g.boxId=boxId;
    }
  }
  for(const rp of allRemotePackages)if(!mapped.has(Number(rp.id)))issue(row,'Package missing locally','No linked local package',`Local Line package #${rp.id}: ${rp.name||''}, ${money(rp.unit_price)}`,'Review and import/link this package locally, then apply the product’s intended pricing. Preserve its existing stock and listing settings.',{remotePackageId:rp.id,checkedAt});
}
const represented=new Set(local.localLineProductMeta.filter(m=>m.localLineProductId).map(m=>Number(m.localLineProductId)));
for(const p of local.products)if(!local.localLineProductMeta.some(m=>m.productId===p.id&&m.localLineProductId))represented.add(p.id);
for(const rp of exported.products){
  const id=Number(rp['Local Line Product ID']);if(represented.has(id)||/deck|hyland|creamy cow|deposit|membership/i.test(`${rp.Product} ${rp.Vendor}`))continue;
  const row={id:`remote-${id}`,name:rp.Product,vendor:rp.Vendor,remoteId:id,category:'',visible:false,remoteVisible:rp.Visible};
  const matching=local.products.filter(p=>norm(p.name)===norm(rp.Product));
  issue(row,'Product missing locally',matching.length?`No link; possible local matches: ${matching.map(p=>p.id).join(', ')}`:'No local product or link',`Local Line product #${id}: ${rp.Product}`,
    matching.length?'Review the existing local candidates and link the correct record. Avoid creating a duplicate.':'Review an incoming Product Sync repair to create the missing local product/packages and assign its Local Line vendor, then review pricing.',{checkedAt:info.snapshotAt});
}
const rows=[...groups.values()].map(g=>({...g,priority:g.remoteVisible?'1 — Visible in Local Line':g.localVisible?'2 — Visible locally':'3 — Hidden / cleanup',issueSummary:g.issues.join('; '),currentLocal:[...new Set(g.details.map(d=>d.localValue))].join('\n'),currentLocalLine:[...new Set(g.details.map(d=>d.remoteValue))].join('\n'),suggestedFix:g.fixes.join('\n'),detailCount:g.details.length})).sort((a,b)=>a.priority.localeCompare(b.priority)||a.vendor.localeCompare(b.vendor)||a.product.localeCompare(b.product));
const counts={};for(const row of rows)for(const category of row.issues)counts[category]=(counts[category]||0)+1;
const result={generatedAt:new Date().toISOString(),startedAt:info.startedAt,checkedThrough:[capture.finishedAt,boxProducts.checkedAt,boxes.checkedAt].sort().at(-1),scopeProducts:scope.length,comparedPrices,
  confirmedDiscrepancyProducts:rows.length,visibleInLocalLine:rows.filter(r=>r.remoteVisible).length,counts,rows,details,unverified,
  omissions:{vendorUnassignedInBoth:missingBothVendor,noPackagesInBoth:emptyBothPackages,notListedCustomerListRows:missingListingCount},
  scope:'Current non-Deck vendor/product/package links, base and customer prices, and sale settings; prior pricing exclusions retained. Only existing Local Line customer-list entries compared. Inventory, descriptions, visibility differences, Square and turkey preorders excluded.'};
assert.ok(rows.every(r=>r.issues.length&&r.details.length));assert.ok(!rows.some(r=>Number(r.productId)===1011876));
await writeFile(new URL('discrepancies.json',directory),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({products:rows.length,visible:result.visibleInLocalLine,counts,omissions:result.omissions,unverified:unverified.length,rows:rows.map(r=>({id:r.productId,name:r.product,vendor:r.vendor,issues:r.issueSummary,visible:r.remoteVisible}))},null,2));
