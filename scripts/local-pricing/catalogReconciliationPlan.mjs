import { fingerprint, same } from '../../apps/api/lib/productSyncCore.js';
const parse=x=>{try{return typeof x==='string'?JSON.parse(x):x;}catch{return null;}};
const map=(rows,key)=>new Map((rows||[]).map(row=>[Number(row[key]),row]));
const norm=x=>String(x??'').trim().replace(/\s+/g,' ').toLowerCase();
export const CATALOG_TABLES=['products','packages','vendors','categories','local_line_product_meta','local_line_package_meta','local_line_price_list_entries','square_catalog_items','square_catalog_variations','square_variation_links','product_images','product_media'];
export const catalogHash=t=>fingerprint(Object.fromEntries(CATALOG_TABLES.map(key=>[key,(t[key]||[]).map(row=>fingerprint(JSON.parse(JSON.stringify(row)))).sort()])));
export const textContent=x=>String(x??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();
const imageContents=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['fetched_at','created_at','updated_at','last_synced_at'].includes(key)))).map(fingerprint).sort();
export function mergeCatalogField(local, baseline, remote, field) {
  const equal=(a,b)=>field==='description'?textContent(a)===textContent(b):['visible','track_inventory','inventory','vendor_id','category_id'].includes(field)?(a==null?null:Number(a))===(b==null?null:Number(b)):same(a??null,b??null);
  if(equal(local,remote))return 'same';
  return equal(local,baseline)?'update':'conflict';
}
export function remoteEntryCents(pkg,entry){
  const scaled=value=>{const match=/^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(String(value??''));if(!match)return null;return (match[1]?-1n:1n)*(BigInt(match[2])*10000n+BigInt((match[3]||'').padEnd(4,'0')));};
  const base=scaled(pkg.package_price??pkg.unit_price);if(base==null)return null;
  let numerator=base,denominator=100n;
  if(entry.adjustment){const value=scaled(entry.adjustment_value);if(value==null)return null;
    if(Number(entry.adjustment_type)===1)numerator=base+value;
    else if(Number(entry.adjustment_type)===2){numerator=base*(1000000n+value);denominator=100000000n;}
    else if(Number(entry.adjustment_type)===3)numerator=value;
    else return null;
  }
  if(numerator<0n)return null;
  return Number((2n*numerator+denominator)/(2n*denominator));
}

export function catalogReconciliationPlan({local,baseline,remote,remoteVendors,categoryData,exportData,square,capturedAt}) {
  const t=local.tables,b=baseline.tables;
  const products=map(t.products,'id'),oldProducts=map(b.products,'id'),vendors=map(t.vendors,'id'),categories=map(t.categories,'id');
  const packages=map(t.packages,'id'),oldPackages=map(b.packages,'id'),rv=map(remoteVendors,'id');
  const productLinks=new Map(),packageLinks=new Map();
  for(const link of t.local_line_product_meta||[]){const key=Number(link.local_line_product_id);if(!productLinks.has(key))productLinks.set(key,[]);productLinks.get(key).push(Number(link.product_id));}
  for(const link of t.local_line_package_meta||[]){const key=Number(link.local_line_package_id);if(!packageLinks.has(key))packageLinks.set(key,[]);packageLinks.get(key).push(Number(link.package_id));}
  const priorMeta=map(b.local_line_product_meta,'product_id');
  const associations=new Map();
  for(const category of categoryData.categories||[])for(const assoc of category.products||[]){const key=Number(assoc.product_price_list_entry);if(!associations.has(key))associations.set(key,[]);associations.get(key).push(category.name);}
  const plan={database:local.database,capturedAt,sourceSnapshotAt:baseline.capturedAt,localSnapshotAt:local.capturedAt,
    products:[],packages:[],images:[],newProducts:[],newVendors:[],newCategories:[],conflicts:[],priceChanges:[],squareChanges:[],channelPrices:[],metadata:[],missingFromExport:[],externalWrites:0};
  const vendorFor=remoteId=>{
    const vendor=rv.get(Number(remoteId));if(!vendor?.name?.trim())return null;
    const matches=[...vendors.values(),...plan.newVendors].filter(v=>norm(v.name)===norm(vendor.name));
    if(matches.length===1)return matches[0].id;
    if(matches.length>1)return null;
    let id=Number(vendor.id);if(vendors.has(id)||plan.newVendors.some(v=>v.id===id))id=Math.max(...vendors.keys(),...plan.newVendors.map(v=>v.id))+1;
    plan.newVendors.push({id,name:vendor.name,remoteId:Number(vendor.id)});return id;
  };
  const categoryFor=name=>{
    const exact=[...categories.values(),...plan.newCategories].filter(c=>c.name===name);
    if(exact.length===1)return exact[0].id;
    const matches=[...categories.values(),...plan.newCategories].filter(c=>norm(c.name)===norm(name));
    if(matches.length===1)return matches[0].id;if(matches.length>1)return null;
    const id=Math.max(0,...categories.keys(),...plan.newCategories.map(c=>c.id))+1;plan.newCategories.push({id,name});return id;
  };
  for(const source of remote){
    const remoteId=Number(source.id),links=productLinks.get(remoteId)||[],id=links.length===1?links[0]:remoteId;
    const product=products.get(id),before=oldProducts.get(id);
    if(links.length>1||(!links.length&&product)){plan.conflicts.push({id,name:source.name,reason:'Product ID or remote link is ambiguous'});continue;}
    if(product&&(product.is_deleted||/^membership$/i.test(categories.get(Number(product.category_id))?.name||'')||/membership/i.test(product.name))){plan.conflicts.push({id,name:product.name,reason:'Preserved deleted or Membership product'});continue;}
    const vendorId=vendorFor(source.vendor);
    if(!vendorId){plan.conflicts.push({id,name:source.name,reason:'Missing or ambiguous remote vendor'});}
    const catNames=[...new Set((source.product_price_list_entries||[]).flatMap(e=>associations.get(Number(e.id))||[]))];
    const categoryId=catNames.length===1?categoryFor(catNames[0]):null;
    if(catNames.length>1)plan.conflicts.push({id,name:source.name,reason:'Multiple remote categories; retained local category',categories:catNames});
    const oldRaw=parse(priorMeta.get(id)?.raw_json)||{},oldLive=oldRaw.live||oldRaw;
    const fresh={name:source.name,description:source.description||'',visible:Number(Boolean(source.visible)),track_inventory:Number(Boolean(source.track_inventory))};
    if(Number.isInteger(source.inventory)&&source.inventory>=0)fresh.inventory=source.inventory;
    else if(source.inventory!=null)plan.conflicts.push({id,name:source.name,reason:'Remote inventory is not a nonnegative integer',value:source.inventory});
    if(vendorId)fresh.vendor_id=vendorId;if(categoryId)fresh.category_id=categoryId;
    if(source.is_deleted){plan.conflicts.push({id,name:source.name,reason:'Remote deletion needs review'});continue;}
    if(!product){
      if(!vendorId)continue;
      const collisions=(source.packages||[]).some(pkg=>packages.has(Number(pkg.id))||packageLinks.has(Number(pkg.id)));
      if(collisions){plan.conflicts.push({id,name:source.name,reason:'New product package ID collision'});continue;}
      plan.newProducts.push({id,remoteId,values:{...fresh,thumbnail_url:source.thumbnail||null},packages:(source.packages||[]).map(pkg=>({id:Number(pkg.id),product_id:id,name:pkg.name||'Package',price:pkg.package_price??pkg.unit_price??null,package_code:pkg.package_code??null,
        unit:source.charge_unit?.name||null,num_of_items:Number.isInteger(pkg.inventory_per_unit)&&pkg.inventory_per_unit>0?pkg.inventory_per_unit:null,track_type:pkg.track_type||null,charge_type:source.charge_type||null,visible:fresh.visible,track_inventory:0,inventory:null}))});
      plan.conflicts.push({id,name:source.name,reason:'New product needs reviewed Buy Price, pricing unit and preset before publication'});
    }else if(vendorId){
      const updates={},changes=[];
      for(const [field,value]of Object.entries(fresh)){
        const decision=mergeCatalogField(product[field],before?.[field],value,field);
        if(decision==='update'){updates[field]=value;changes.push({field,before:product[field],after:value,remoteChangedSinceSnapshot:!same(oldLive[field],source[field])});}
        else if(decision==='conflict')plan.conflicts.push({id,name:source.name,field,local:product[field],remote:value,reason:'Local field edited since original clone; preserved local edit'});
      }
      if(Object.keys(updates).length)plan.products.push({id,name:source.name,updates,changes});
    }
    plan.metadata.push({id,remoteId,source,export:exportData.availability.find(row=>Number(row['Local Line Product ID'])===remoteId)||null});
    if(!same((oldLive.images||[]).map(x=>x.full||x.url),(source.images||[]).map(x=>x.full||x.url))&&vendorId){
      const imageRows=table=>(t[table]||[]).filter(row=>Number(row.product_id)===id),beforeImages=table=>(b[table]||[]).filter(row=>Number(row.product_id)===id);
      const hasLocalUploads=imageRows('product_media').some(row=>row.source!=='localline');
      if(!hasLocalUploads&&same(imageContents(imageRows('product_images')),imageContents(beforeImages('product_images')))&&same(imageContents(imageRows('product_media')),imageContents(beforeImages('product_media')))){
        plan.images.push({productId:id,images:source.images||[],previousUrls:(oldLive.images||[]).flatMap(x=>[x.full,x.thumbnail]).filter(Boolean)});
        if(product&&mergeCatalogField(product.thumbnail_url,before?.thumbnail_url,source.thumbnail||null,'thumbnail_url')==='update'){
          let change=plan.products.find(row=>row.id===id);
          if(!change){change={id,name:source.name,updates:{},changes:[]};plan.products.push(change);}
          change.updates.thumbnail_url=source.thumbnail||null;
          change.changes.push({field:'thumbnail_url',before:product.thumbnail_url,after:change.updates.thumbnail_url});
        }
      }else plan.conflicts.push({id,name:source.name,reason:'Local uploaded or edited images retained; remote images captured for review'});
    }
    for(const pkg of source.packages||[]){
      const matches=packageLinks.get(Number(pkg.id))||[],packageId=matches.length===1?matches[0]:Number(pkg.id);
      const localPkg=packages.get(packageId),oldPkg=oldPackages.get(packageId);
      if(matches.length>1||(localPkg&&Number(localPkg.product_id)!==id)){plan.conflicts.push({id,name:source.name,packageId,reason:'Package link conflict'});continue;}
      if(product&&!localPkg){plan.conflicts.push({id,name:source.name,packageId,reason:'New package needs pricing definition and link review'});continue;}
      const oldRemote=(oldLive.packages||[]).find(row=>Number(row.id)===Number(pkg.id));
      if(oldRemote){
        const definition=['average_pack_weight','inventory_per_unit','product_package_size','is_by_weight','is_charge_by_weight'].filter(k=>!same(oldRemote[k],pkg[k]));
        if(definition.length)plan.conflicts.push({id,name:source.name,packageId,reason:'Package definition changed; pricing inputs preserved',fields:definition});
        const priceFields=['unit_price','package_price'].filter(k=>!same(oldRemote[k],pkg[k]));
        if(priceFields.length)plan.priceChanges.push({id,name:source.name,packageId,kind:'Local Line base price',before:oldRemote.package_price??oldRemote.unit_price,remote:pkg.package_price??pkg.unit_price,decision:'Preserve local Buy Price and markup; review vendor cost'});
        if(localPkg&&vendorId&&!definition.length){
          const updates={};for(const[field,value]of Object.entries({name:pkg.name,package_code:pkg.package_code??null})){
            const decision=mergeCatalogField(localPkg[field],oldPkg?.[field],value,field);
            if(decision==='update')updates[field]=value;
            else if(decision==='conflict')plan.conflicts.push({id,name:source.name,packageId,field,reason:'Locally edited package field retained'});
          }
          if(Object.keys(updates).length)plan.packages.push({id:packageId,productId:id,updates});
        }
      }
      const entries=pkg.price_list_entries?.length?pkg.price_list_entries:source.product_price_list_entries||[];
      const oldEntries=oldRemote?.price_list_entries||[];
      for(const entry of entries){
        const listId=Number(entry.price_list_id??entry.price_list);
        const previous=oldEntries.find(e=>Number(e.price_list_id??e.price_list)===listId);
        const currentCents=remoteEntryCents(pkg,entry),oldCents=previous?remoteEntryCents(oldRemote,previous):null;
        plan.channelPrices.push({productId:id,remoteProductId:remoteId,packageId,remotePackageId:Number(pkg.id),listId,listName:entry.price_list_name||null,entry,currentCents,package:pkg});
        if(previous&&currentCents!==oldCents)plan.priceChanges.push({id,name:source.name,packageId,listName:entry.price_list_name,kind:'Local Line selling price',before:oldCents==null?null:oldCents/100,remote:currentCents==null?null:currentCents/100,decision:'Captured for review; new local pricing retained'});
      }
    }
  }
  const exportIds=new Set(exportData.availability.map(p=>Number(p['Local Line Product ID'])));
  for(const [remoteId,ids]of productLinks)for(const id of ids){const p=products.get(id);if(p&&!p.is_deleted&&!exportIds.has(remoteId))plan.missingFromExport.push({id,remoteId,name:p.name,reason:'Absent from export; do not infer deletion'});}
  const oldSquare=new Map((t.square_catalog_variations||[]).map(v=>[v.square_variation_id,v]));
  for(const item of square.objects.filter(o=>o.type==='ITEM'))for(const variation of item.item_data?.variations||[]){
    const old=parse(oldSquare.get(variation.id)?.raw_json)?.item_variation_data,current=variation.item_variation_data;
    const keys=['price_money','measurement_unit_id','location_overrides','name','sku'].filter(k=>!same(old?.[k],current?.[k]));
    if(keys.length)plan.squareChanges.push({variationId:variation.id,name:item.item_data.name,fields:keys,old:old||null,current,localProductIds:(t.square_variation_links||[]).filter(l=>l.square_variation_id===variation.id).map(l=>l.product_id)});
  }
  plan.localCatalogHash=catalogHash(t);
  plan.summary={productUpdates:plan.products.length,fieldUpdates:plan.products.reduce((sum,p)=>sum+p.changes.length,0),newProducts:plan.newProducts.length,newVendors:plan.newVendors.length,newCategories:plan.newCategories.length,packageUpdates:plan.packages.length,imageUpdates:plan.images.length,priceChanges:plan.priceChanges.length,squareChanges:plan.squareChanges.length,conflicts:plan.conflicts.length,missingFromExport:plan.missingFromExport.length};
  return plan;
}
