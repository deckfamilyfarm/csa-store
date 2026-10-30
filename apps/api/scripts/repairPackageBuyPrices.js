// Controlled repair of the seven audited variant-cost migrations. Preview first;
// apply checks frozen baselines and creates normal local pricing revisions only.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {getPool} from '../db.js';
import {normalizeInput,persistEnterprisePricingRevision} from '../lib/enterprisePricingService.js';
const ids=[928741,928742,983715,1012965,1012966,1163510,1163511];
const expectedCosts=new Map([[928741,[2.5,5]],[928742,[2.5,5]],[983715,[7.25,3.63]],[1012965,[3,5]],[1012966,[3,5]],[1163510,[9,17]],[1163511,[9,17]]]);
const apply=process.argv.includes('--apply');
const file=process.argv.find(a=>a.startsWith('--plan='))?.slice(7)||'.local-pricing/package-audit/repair-plan.json';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pool=getPool(),db=await pool.getConnection();
globalThis.fetch=async()=>{throw new Error('Channel calls are prohibited in this repair.');};
try {
 const plan=apply?JSON.parse(await fs.readFile(`${file}.applied.json`,'utf8').catch(e=>e.code==='ENOENT'?fs.readFile(file,'utf8'):Promise.reject(e))):null;
 if(plan)assert.equal(plan.database,process.env.STORE_DB_DATABASE,'Repair plan belongs to another database');
 if(plan?.applied){console.log('Already applied; no additional revisions created.');process.exitCode=0;}
 else {
 await db.query(apply?'START TRANSACTION':'START TRANSACTION READ ONLY');
 const lock=apply?' FOR UPDATE':'';
 const [[settings]]=await db.query(`SELECT id,settings_json FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1${lock}`);
 const [enterprises]=await db.query('SELECT id,name FROM enterprise_pricing_enterprises');
 const [[actor]]=await db.query("SELECT id FROM users WHERE username='jdeck' AND active=1");assert.ok(actor,'Requesting editor must exist');
 const [roles]=await db.query('SELECT r.role_key FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.user_id=?',[actor.id]);
 assert.ok(roles.some(r=>['admin','pricing_admin','pricing_editor','local_pricelist_admin'].includes(r.role_key)),'Editor permission required');
 const items=[],receipts=[];
 for(const id of ids){
  const [[product]]=await db.query(`SELECT p.id,p.name,p.vendor_id AS vendorId,v.name AS vendorName,p.is_deleted AS isDeleted,c.name AS categoryName FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?${lock}`,[id]);assert.ok(product&&!product.isDeleted&&product.vendorName?.trim());
  const [[state]]=await db.query(`SELECT * FROM enterprise_pricing_product_state WHERE product_id=?${lock}`,[id]);
  const [[revision]]=await db.query(`SELECT * FROM enterprise_pricing_revisions WHERE id=?${lock}`,[state.latest_revision_id]);
  const [[buy]]=await db.query(`SELECT * FROM enterprise_pricing_buy_price_drafts WHERE product_id=?${lock}`,[id]);
  const [packages]=await db.query(`SELECT id AS packageId,name,price,num_of_items AS quantity FROM packages WHERE product_id=? ORDER BY id${lock}`,[id]);
  assert.deepEqual(packages.map(p=>Number(p.price)),expectedCosts.get(id),'Stored package costs changed; review before repair');
  const baseline={product,state,revision,buy,packages,settings};
  const old=parse(revision.input_json);assert.equal(old.pricingUnit,'each');assert.equal(old.squareEnabled,false);assert.equal(old.csaOverride,null);
  const [inFlight]=await db.query(`SELECT ra.id FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id JOIN product_sync_releases r ON r.id=ra.release_id WHERE a.product_id=? AND r.status<>'cancelled' AND ra.status IN ('pending','working','failed','held') LIMIT 1`,[id]);
  assert.equal(inFlight.length,0,`${product.name}: resolve the existing publication first`);
  const [promotions]=await db.query("SELECT input_json FROM enterprise_promotions WHERE status IN ('approved','scheduled','active','partial','cancelling')");
  assert.ok(!promotions.some(s=>parse(s.input_json).packageIds.some(pid=>packages.some(p=>Number(p.packageId)===Number(pid)))),`${product.name}: resolve its promotion first`);
  const previous=plan?.items.find(i=>i.productId===id);
  if(apply)assert.equal(hash(baseline),previous?.baselineHash,`${product.name}: changed after preview`);
  const input=apply?previous.input:{...old,priceEffectiveAt:new Date().toISOString(),
    overrideNote:[old.overrideNote,'Package-cost repair: preserve the stored Buy Price of each package.'].filter(Boolean).join(' '),
    packages:old.packages.map(p=>({...p,packageBuyPrice:Number(packages.find(k=>Number(k.packageId)===Number(p.packageId)).price).toFixed(2),packageBuyPriceEnterpriseId:old.retailEnterpriseId}))};
  const {clean,output}=normalizeInput(input,product,packages,enterprises,parse(settings.settings_json));
  const item={productId:id,name:product.name,baselineHash:hash(baseline),before:baseline,input:clean,output,settingsVersionId:Number(settings.id)};
  items.push(item);
  if(apply){
    assert.deepEqual(output,previous.output,'Calculated prices changed after preview');
    const receipt=await persistEnterprisePricingRevision(db,id,{input:clean,output,settingsVersionId:Number(settings.id)},{userId:actor.id},Number(buy?.revision||0));
    const [[saved]]=await db.query('SELECT r.input_json,r.output_json FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id WHERE s.product_id=?',[id]);
    assert.deepEqual(parse(saved.input_json).packages,clean.packages);assert.deepEqual(parse(saved.output_json),output);
    receipts.push({productId:id,...receipt});
  }
 }
 if(apply){await db.commit();await fs.writeFile(`${file}.applied.json`,JSON.stringify({...plan,applied:true,appliedAt:new Date().toISOString(),receipts},null,2),{mode:0o600});}
 else {await db.rollback();await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({database:process.env.STORE_DB_DATABASE,capturedAt:new Date().toISOString(),applied:false,items},null,2),{mode:0o600,flag:'wx'});}
 console.log(JSON.stringify({applied:apply,channelWrites:0,products:items.map(i=>({id:i.productId,name:i.name,prices:i.output.packages.map(p=>({package:i.before.packages.find(k=>k.packageId===p.packageId).name,buyPrice:p.packageBuyPriceCents/100,price:p.localLineRegularCents/100}))})),receipts},null,2));
 }
}catch(e){await db.rollback();throw e;}finally{db.release();await pool.end();}
