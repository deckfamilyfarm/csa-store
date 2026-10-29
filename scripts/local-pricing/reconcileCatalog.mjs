import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {catalogReconciliationPlan,catalogHash,CATALOG_TABLES} from './catalogReconciliationPlan.mjs';
const root=process.argv.find(arg=>arg.startsWith('--snapshot='))?.slice(11);
const baselineDir=process.argv.find(arg=>arg.startsWith('--baseline='))?.slice(11);
if(!root||!baselineDir)throw new Error('Provide --snapshot=<reconciliation folder> and --baseline=<original production snapshot>.');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const local=read('local-before.json'),remote=read('remote/localline-products.json'),square=read('remote/square-catalog.json'),manifest=read('remote/manifest.json');
const reportPath=path.join(root,'plan.json');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sourceHash=digest({remote,square,vendors:read('remote/localline-vendors.json'),categories:read('remote/localline-categories.json')});
if(!process.argv.includes('--apply')){
  if(fs.existsSync(reportPath)&&read('plan.json').applied)throw new Error('This reconciliation was already applied. Preserve its receipt and use a new snapshot folder.');
  const original=JSON.parse(fs.readFileSync(path.join(baselineDir,'manifest.json')));
  const baseline={capturedAt:original.capturedAt,tables:{}};
  for(const table of original.tables.filter(t=>CATALOG_TABLES.includes(t.name))){
    baseline.tables[table.name]=fs.readFileSync(path.join(baselineDir,table.filename),'utf8').trim().split('\n').filter(Boolean).map(line=>Object.fromEntries(JSON.parse(line).map((value,i)=>[table.columns[i],value])));
  }
  const plan=catalogReconciliationPlan({local,baseline,remote,remoteVendors:read('remote/localline-vendors.json'),categoryData:read('remote/localline-categories.json'),exportData:read('remote/localline-export.json'),square,capturedAt:manifest.finishedAt});
  plan.sourceHash=sourceHash;plan.remoteErrors=manifest.errors;plan.snapshotRoot=root;plan.applied=false;
  fs.writeFileSync(reportPath,JSON.stringify(plan,null,2),{mode:0o600});console.log(JSON.stringify({report:reportPath,...plan.summary,remoteDetailHolds:manifest.errors.length},null,2));
}else{
  const plan=read('plan.json');if(plan.applied||plan.sourceHash!==sourceHash)throw new Error('Plan already applied or remote snapshot changed.');
  const {installLocalEnvironment,assertLocalDatabase,installLoopbackNetworkGuard}=await import('./env.mjs');
  installLocalEnvironment();assertLocalDatabase();installLoopbackNetworkGuard();
  if(process.env.STORE_DB_DATABASE!==plan.database)throw new Error('Selected database differs from reviewed snapshot.');
  const {getPool}=await import('../../apps/api/db.js');
  const {upsertReturnedSquareObjects}=await import('../../apps/api/lib/squareStoreSync.js');
  const pool=getPool(),connection=await pool.getConnection();
  const protectedTables=Object.keys(local.tables).filter(name=>name.startsWith('enterprise_')||['product_pricing_profiles','product_sales','square_variation_links'].includes(name));
  const normalize=rows=>JSON.parse(JSON.stringify(rows));
  const insert=async(table,values)=>{const keys=Object.keys(values);await connection.query(`INSERT INTO \`${table}\` (${keys.map(k=>'`'+k+'`').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(values));};
  const upsert=async(table,values,primary)=>{const keys=Object.keys(values),updates=keys.filter(k=>!primary.includes(k)&&k!=='created_at');await connection.query(`INSERT INTO \`${table}\` (${keys.map(k=>'`'+k+'`').join(',')}) VALUES (${keys.map(()=>'?').join(',')}) ON DUPLICATE KEY UPDATE ${updates.map(k=>'`'+k+'`=VALUES(`'+k+'`)').join(',')}`,Object.values(values));};
  const now=new Date();
  try{
    await connection.beginTransaction();
    const current={};for(const table of CATALOG_TABLES){const[rows]=await connection.query('SELECT * FROM `'+table+'` FOR UPDATE');current[table]=normalize(rows);}
    if(catalogHash(current)!==plan.localCatalogHash)throw new Error('Local catalog changed since snapshot. Reconcile against a fresh local backup.');
    const protectedBefore={};for(const table of protectedTables){const[rows]=await connection.query('SELECT * FROM `'+table+'` FOR UPDATE');protectedBefore[table]=digest(normalize(rows));}
    const [activeReleases]=await connection.query("SELECT id FROM product_sync_releases WHERE status IN ('queued','running','scheduled') LIMIT 1");
    if(activeReleases.length)throw new Error('An active product release must be resolved before reconciliation.');
    for(const vendor of plan.newVendors)await insert('vendors',{id:vendor.id,name:vendor.name,guest_markup:null,member_markup:null,price_list_markup:null,source_multiplier:null});
    for(const category of plan.newCategories)await insert('categories',category);
    for(const product of plan.newProducts){
      await insert('products',{id:product.id,...product.values,is_deleted:0,stock_on_farm:null,stock_on_farm_lbs:null,farm_stock_revision:0,created_at:now,updated_at:now});
      for(const pkg of product.packages)await insert('packages',pkg);
    }
    const allowedProduct=new Set(['name','description','visible','track_inventory','inventory','vendor_id','category_id','thumbnail_url']);
    for(const row of plan.products){const entries=Object.entries(row.updates);if(entries.some(([key])=>!allowedProduct.has(key)))throw new Error('Unexpected product field in plan.');await connection.query(`UPDATE products SET ${entries.map(([key])=>'`'+key+'`=?').join(',')},updated_at=? WHERE id=?`,[...entries.map(([,v])=>v),now,row.id]);}
    for(const row of plan.packages){const entries=Object.entries(row.updates);if(entries.some(([key])=>!['name','package_code'].includes(key)))throw new Error('Unexpected package field in plan.');await connection.query(`UPDATE packages SET ${entries.map(([key])=>'`'+key+'`=?').join(',')} WHERE id=?`,[...entries.map(([,v])=>v),row.id]);}
    const packageByRemoteId=new Map(current.local_line_package_meta.map(m=>[Number(m.local_line_package_id),Number(m.package_id)]));
    for(const p of plan.newProducts)for(const pkg of p.packages)packageByRemoteId.set(pkg.id,pkg.id);
    for(const item of plan.metadata){const p=item.source;
      await upsert('local_line_product_meta',{product_id:item.id,local_line_product_id:item.remoteId,internal_id:p.internal_id||null,visible:Number(Boolean(p.visible)),track_inventory:Number(Boolean(p.track_inventory)),track_inventory_by:p.track_type||null,inventory_type:p.inventory_type||null,
        product_inventory:p.inventory??null,package_codes_enabled:Number(Boolean(p.package_codes_enabled)),raw_json:JSON.stringify({export:item.export,live:p}),vendor_name:read('remote/localline-vendors.json').find(v=>Number(v.id)===Number(p.vendor))?.name||null,status:p.status||null,
        last_live_fetch_status:200,last_live_fetch_error:null,created_at:now,updated_at:now,last_synced_at:now},['product_id']);
      for(const pkg of p.packages||[]){const packageId=packageByRemoteId.get(Number(pkg.id));if(!packageId)continue;
        const existing=current.packages.find(row=>Number(row.id)===packageId);
        if(existing&&Number(existing.product_id)!==item.id)continue;
        await upsert('local_line_package_meta',{package_id:packageId,product_id:item.id,local_line_package_id:Number(pkg.id),inventory_type:pkg.track_type||null,package_inventory:pkg.current_inventory??null,package_reserved_inventory:pkg.current_reserved_inventory??null,package_available_inventory:pkg.current_unreserved_inventory??null,
          ...(!existing?{avg_package_weight:pkg.average_pack_weight??null,num_of_items:pkg.inventory_per_unit??null}:{}),package_code:pkg.package_code??null,raw_json:JSON.stringify({live:pkg}),live_name:pkg.name||null,live_price:pkg.package_price??pkg.unit_price??null,created_at:now,updated_at:now,last_synced_at:now},['package_id']);
      }
    }
    for(const change of plan.images){
      const media=current.product_media.filter(row=>Number(row.product_id)===change.productId&&row.source==='localline');
      const previousUrls=new Set([...change.previousUrls,...media.flatMap(row=>[row.source_url,row.remote_url,row.public_url,row.thumbnail_url])].filter(Boolean));
      const removeIds=current.product_images.filter(row=>Number(row.product_id)===change.productId&&previousUrls.has(row.url)).map(row=>row.id);
      if(removeIds.length)await connection.query('DELETE FROM product_images WHERE product_id=? AND id IN (?)',[change.productId,removeIds]);
      await connection.query("DELETE FROM product_media WHERE product_id=? AND source='localline'",[change.productId]);
      for(const [index,image]of change.images.entries()){
        const url=image.full||image.url;if(!url||!String(url).startsWith('https://'))continue;
        const hash=crypto.createHash('sha256').update(url).digest('hex');
        const [already]=await connection.query('SELECT id FROM product_images WHERE product_id=? AND url_hash=?',[change.productId,hash]);
        if(!already.length)await insert('product_images',{product_id:change.productId,url,url_hash:hash});
        await insert('product_media',{product_id:change.productId,source:'localline',source_media_id:String(image.id),source_url:url,remote_url:url,public_url:url,thumbnail_url:image.thumbnail||null,sort_order:image.priority_order??index,is_primary:Number(index===0),fetched_at:now,created_at:now,updated_at:now,last_synced_at:now});
      }
    }
    const lists=new Map((local.tables.price_lists||[]).map(l=>[Number(l.local_line_price_list_id),l]));
    const pricesByProduct=Map.groupBy(plan.channelPrices,row=>row.productId);
    let priceRows=0;
    for(const [productId,prices]of pricesByProduct){
      const known=prices.filter(price=>lists.has(price.listId));
      if(known.length!==prices.length)throw new Error(`Unknown price-list mapping on product ${productId}; preserve cache until mapped.`);
      // Replace only channel observations for packages fully fetched in this snapshot.
      const packageIds=[...new Set(known.map(row=>row.packageId))];
      await connection.query('DELETE FROM local_line_price_list_entries WHERE product_id=? AND package_id IN (?)',[productId,packageIds]);
      for(const row of known){const e=row.entry;await insert('local_line_price_list_entries',{product_id:productId,local_line_product_id:row.remoteProductId,package_id:row.packageId,local_line_package_id:row.remotePackageId,
        price_list_id:lists.get(row.listId).id,local_line_price_list_id:row.listId,entry_scope:'package',source_entry_id:e.id==null?null:String(e.id),price_list_name:row.listName||lists.get(row.listId).name,
        product_name:plan.metadata.find(m=>m.id===productId)?.source.name||null,package_name:row.package.name||null,
        adjustment_type:e.adjustment_type??null,adjustment_value:e.adjustment_value??null,calculated_value:e.calculated_value??null,base_price_used:e.base_price_used??null,final_price_cache:row.currentCents==null?null:row.currentCents/100,
        on_sale:Number(Boolean(e.on_sale)),on_sale_toggle:Number(Boolean(e.on_sale_toggle)),strikethrough_display_value:e.strikethrough_display_value??null,max_units_per_order:e.max_units_per_order??null,raw_json:JSON.stringify(e),created_at:now,updated_at:now,last_synced_at:now});priceRows++;}
    }
    await upsertReturnedSquareObjects(connection,square.objects,now);
    for(const table of protectedTables){const[rows]=await connection.query('SELECT * FROM `'+table+'`');if(digest(normalize(rows))!==protectedBefore[table])throw new Error(`Protected pricing data changed: ${table}`);}
    const [farm]=await connection.query('SELECT id,stock_on_farm,stock_on_farm_lbs,farm_stock_revision FROM products');
    for(const row of farm){const original=current.products.find(p=>p.id===row.id);if(original&&['stock_on_farm','stock_on_farm_lbs','farm_stock_revision'].some(k=>JSON.stringify(original[k])!==JSON.stringify(row[k])))throw new Error('Farm inventory changed unexpectedly.');}
    await connection.commit();plan.applied=true;plan.appliedAt=new Date().toISOString();plan.cachePriceRows=priceRows;plan.protectedPricingVerified=true;fs.writeFileSync(reportPath,JSON.stringify(plan,null,2),{mode:0o600});
    console.log(JSON.stringify({...plan.summary,cachePriceRows:priceRows,protectedPricingVerified:true,externalWrites:0},null,2));
  }catch(error){await connection.rollback();throw error;}finally{connection.release();await pool.end();}
}
