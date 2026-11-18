import fs from 'node:fs/promises';
import { getPool } from '../db.js';
import { createMerchandiseService } from '../lib/merchandiseService.js';
import { merchandiseConfig } from '../lib/merchandiseRuntime.js';
// Default is preview. Importing this supplier snapshot never connects to Printify.
const file=process.argv.find(value=>value.startsWith('--snapshot='))?.slice(11);
if (!file) throw new Error('Use --snapshot=/path/to/complete-catalog.json [--apply].');
const source=JSON.parse(await fs.readFile(file,'utf8'));
const vendorId=Number(process.argv.find(value=>value.startsWith('--vendor-id='))?.slice(12));
if(!Number.isInteger(vendorId)||vendorId<1)throw new Error('Choose an existing named local vendor with --vendor-id=ID. No vendor is created.');
const missing=new Set((source.artworks || []).filter(a=>!a.upload).map(a=>a.id));
const records=source.products.map(({shopId,product})=>({shopId,vendorId,product,catalog:{
  ...source.catalogPairs[`${product.blueprint_id}/${product.print_provider_id}`],
  unresolvedArtwork:[...new Set(product.print_areas.flatMap(a=>a.placeholders.flatMap(h=>h.images.map(i=>i.id).filter(id=>missing.has(id)))))]
}}));
const connected=process.argv.includes('--connected-drafts');
if (!connected && !process.argv.includes('--apply')) console.log(JSON.stringify({products:records.length,variants:records.reduce((n,r)=>n+r.product.variants.length,0),allNewProductsDisabled:true,retailApproved:false}));
else {
  // Connected setup is explicit and can only initialize disabled, unpriced drafts.
  // Environment loading remains the caller's responsibility (--env-file=.env).
  if (connected) {
    if (process.env.CSA_LOCAL_ONLY==='true') throw new Error('Connected import cannot run through the isolated wrapper.');
    const expected=process.argv.find(value=>value.startsWith('--expect-database='))?.slice(18);
    if (!expected || process.env.STORE_DB_DATABASE!==expected) throw new Error('Specify --expect-database=NAME matching the intended environment.');
    const config=merchandiseConfig();
    if (config.mode!=='test' || config.catalogEnabled || config.checkoutEnabled || config.liveEnabled || config.ordersEnabled || config.productionEnabled) throw new Error('Connected draft setup requires test mode with catalog, checkout, supplier-order and production switches disabled.');
  } else {
    if (process.env.CSA_LOCAL_ONLY!=='true') throw new Error('Use the isolated wrapper, or explicitly select --connected-drafts with --expect-database=NAME.');
    const {assertLocalDatabase}=await import('../../../scripts/local-pricing/env.mjs');assertLocalDatabase();
  }
  const pool=getPool();
  try {
    const [[target]]=await pool.query('SELECT DATABASE() databaseName');
    if (target.databaseName!==process.env.STORE_DB_DATABASE) throw new Error('Connected database did not match the requested target.');
    const [[vendor]]=await pool.query("SELECT id,name FROM vendors WHERE id=? AND NULLIF(TRIM(name),'') IS NOT NULL",[vendorId]);
    if(!vendor)throw new Error('Choose an existing named local vendor.');
    if(!process.argv.includes('--apply'))console.log(JSON.stringify({database:target.databaseName,vendor,products:records.length,variants:records.reduce((n,r)=>n+r.product.variants.length,0),allNewProductsDisabled:true,retailApproved:false,externalWrites:false}));
    else {
      const result=await createMerchandiseService({pool}).importRecords(records,null,undefined,{initialOnly:connected});
      console.log(JSON.stringify({database:target.databaseName,vendor,products:result.products.length,variants:result.products.reduce((n,p)=>n+p.variants.length,0),activeProducts:result.products.filter(p=>p.active).length,approvedRetailVariants:result.products.flatMap(p=>p.variants).filter(v=>v.retailCents!==null).length,externalWrites:false}));
    }
  } finally {await pool.end();}
}
