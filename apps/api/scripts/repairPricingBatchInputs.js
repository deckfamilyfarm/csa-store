import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {getPool} from '../db.js';
import {ensureEnterprisePricingSchema} from '../lib/enterprisePricingSchema.js';
import {readMigrationCatalog,planProductMigration} from '../lib/enterprisePricingMigration.js';
import {normalizeInput,persistEnterprisePricingRevision} from '../lib/enterprisePricingService.js';
const apply=process.argv.includes('--apply'), key='batch-input-repairs-20261030';
const file='.local-pricing/ll-bulk/pricing-input-repair.json';
const eight=[1168783,1168792,1168793,1168795,1168796,1169850,1169854,1170699], grazier=[978368,1000029,805855,805986], ids=[...eight,995638,...grazier];
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
globalThis.fetch=async()=>{throw new Error('This repair cannot call channels');};
await ensureEnterprisePricingSchema();const db=await getPool().getConnection();
try {
 await db.beginTransaction();
 const [[done]]=await db.query('SELECT * FROM enterprise_pricing_repair_receipts WHERE repair_key=?',[key]);
 if(done){console.log('Already repaired; preserving later edits.');await db.rollback();}
 else {
 const saved=apply?JSON.parse(await fs.readFile(file,'utf8')):null;
 const [[actor]]=await db.query("SELECT u.id FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id WHERE u.username='jdeck' AND u.active=1 AND r.role_key='admin'");assert.ok(actor);
 const [[settings]]=await db.query("SELECT * FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE");
 const [enterprises]=await db.query('SELECT id,code,name FROM enterprise_pricing_enterprises');const ffcsa=enterprises.find(e=>e.code==='ffcsa').id;
 const records=await readMigrationCatalog(db),items=[];
 for(const id of ids){
  const record=records.find(r=>r.product.id===id);assert.ok(record?.vendor?.name);
  await db.query('SELECT id FROM products WHERE id=? FOR UPDATE',[id]);
  const [[state]]=await db.query('SELECT * FROM enterprise_pricing_product_state WHERE product_id=? FOR UPDATE',[id]);
  const [[revision]]=await db.query('SELECT * FROM enterprise_pricing_revisions WHERE id=? FOR UPDATE',[state?.latest_revision_id||0]);
  const [[assignment]]=await db.query('SELECT markup_category FROM enterprise_pricing_markup_assignments WHERE product_id=?',[id]);
  const [[buy]]=await db.query('SELECT * FROM enterprise_pricing_buy_price_drafts WHERE product_id=? FOR UPDATE',[id]);
  const [inflight]=await db.query(`SELECT ra.id FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id
    JOIN product_sync_releases r ON r.id=ra.release_id WHERE a.product_id=? AND r.status<>'cancelled' AND ra.status IN ('pending','working','failed','held')`,[id]);assert.equal(inflight.length,0,'Resolve previous publication first');
  const baseline={vendor:record.vendor,packages:record.packages.map(p=>({id:p.id,name:p.name,price:p.price,quantity:p.numOfItems,unit:p.unit})),profile:record.profile,
    revisionId:revision?.id||null,input:parse(revision?.input_json||null),assignment,buy,settingsVersionId:settings.id};
  const previous=saved?.items.find(i=>i.productId===id);
  if(apply)assert.equal(hash(baseline),previous?.baselineHash,`${record.product.name}: inputs changed after preview`);
  let input,inference;
  if(apply)input=previous.input;
  else if(eight.includes(id)){
    const migration=planProductMigration(record,{settings:parse(settings.settings_json),effectiveAt:new Date().toISOString().slice(0,19).replace('T',' ')});
    assert.ok(migration.input,`${record.product.name}: ${migration.blockers.join('; ')}`);
    inference=migration.input.customMarkupBp;
    let category=assignment?.markup_category;
    if(!category){
      if(inference>=4300&&inference<=4800)category='shelfStable';
      else category=Object.entries(parse(settings.settings_json).markupBp).find(([k,bp])=>['shelfStable','perishable','highlyPerishable'].includes(k)&&Math.abs(bp-inference)<=2)?.[0];
    }
    assert.ok(category,`${record.product.name}: review inferred markup ${inference/100}% before assigning a category`);
    input={...migration.input,retailEnterpriseId:ffcsa,markupCategory:category,customMarkupBp:null,csaOverride:null,squareOverride:null,
      purchaseCosts:migration.input.purchaseCosts.map(c=>({...c,enterpriseId:ffcsa})),overrideNote:'Repair reviewed vendor assignment; retain stored package Buy Price and use preset markup.'};
  }else if(id===995638){
    assert.equal(assignment?.markup_category,'shelfStable');assert.equal(record.packages.length,1);
    const at=new Date().toISOString();
    input={retailEnterpriseId:ffcsa,priceEffectiveAt:at,pricingUnit:'lb',markupCategory:'shelfStable',customMarkupBp:null,squareEnabled:false,saleBp:0,
      squareOverride:null,csaOverride:null,purchaseCosts:[{enterpriseId:ffcsa,cost:'2.00',effectiveAt:at,documentationRef:'User approved $2.00/lb Buy Price on 2026-10-30'}],
      packages:[{packageId:record.packages[0].id,avgWeightOverride:1,quantity:1}],wholesale:[]};
  }else{
    assert.ok(revision);input={...parse(revision.input_json),priceEffectiveAt:new Date().toISOString(),overrideNote:'Retain current enterprise markup and sale settings; remove superseded customer-list overrides per user approval.'};
  }
  const pkgRows=record.packages.map(p=>({...p,packageId:p.id}));
  const {clean,output}=normalizeInput(input,record.product,pkgRows,enterprises,parse(settings.settings_json));
  const item={productId:id,name:record.product.name,before:baseline,baselineHash:hash(baseline),input:clean,output,settingsVersionId:settings.id,inferredMarkupBp:inference};items.push(item);
  if(apply){
    assert.deepEqual(output,previous.output);
    if(grazier.includes(id))await db.query('UPDATE product_pricing_profiles SET customer_price_overrides_json=NULL WHERE product_id=?',[id]);
    if(id===995638){await db.query("UPDATE product_pricing_profiles SET unit_of_measure='lbs' WHERE product_id=?",[id]);await db.query("UPDATE packages SET price=2,unit='lb',num_of_items=1 WHERE product_id=?",[id]);}
    item.receipt=await persistEnterprisePricingRevision(db,id,{input:clean,output,settingsVersionId:settings.id},{userId:actor.id},Number(buy?.revision||0));
  }
 }
 if(apply){await db.query('INSERT INTO enterprise_pricing_repair_receipts(repair_key,actor_id,details_json,applied_at) VALUES(?,?,?,UTC_TIMESTAMP())',[key,actor.id,JSON.stringify(items)]);await db.commit();await fs.writeFile(file+'.applied.json',JSON.stringify({key,items},null,2),{mode:0o600});}
 else{await db.rollback();await fs.writeFile(file,JSON.stringify({key,items},null,2),{mode:0o600});}
 console.log(JSON.stringify({applied:apply,products:items.map(i=>({id:i.productId,name:i.name,buyPrice:i.output.buyFromTenThousandths/10000,unit:i.input.pricingUnit,markup:i.input.markupCategory,prices:i.output.packages.map(p=>p.localLineRegularCents/100),inferred:i.inferredMarkupBp,revision:i.receipt?.revisionId})),channelWrites:0},null,2));
 }
}catch(error){await db.rollback();throw error;}finally{db.release();await getPool().end();}
