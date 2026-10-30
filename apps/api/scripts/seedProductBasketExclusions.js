// One-time, reviewed seed from the failed-batch analysis. Does not change channels.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {getPool} from '../db.js';
import {ensureEnterprisePricingSchema} from '../lib/enterprisePricingSchema.js';
const apply=process.argv.includes('--apply');
const key='reviewed-basket-exclusions-20261030';
const analysis=JSON.parse(await fs.readFile('.local-pricing/ll-bulk/failure-analysis.json','utf8'));
const ids=analysis.mappings.filter(p=>p.packages.every(k=>k.missing.includes('Guest Basket'))||p.packages.every(k=>k.missing.includes('SNAP'))).map(p=>p.id);
await ensureEnterprisePricingSchema();
const db=await getPool().getConnection();
try {
 await db.beginTransaction();
 const [[done]]=await db.query('SELECT * FROM product_basket_eligibility_migrations WHERE migration_key=?',[key]);
 if(done){console.log('Already seeded. Later checkbox edits are preserved.');await db.rollback();}
 else {
 const [[actor]]=await db.query("SELECT u.id FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id WHERE u.username='jdeck' AND u.active=1 AND r.role_key='admin'");assert.ok(actor);
 const [rows]=await db.query(`SELECT p.id,p.name,p.exclude_from_snap AS excludeFromSnap,p.exclude_from_guest AS excludeFromGuest,l.raw_json AS rawJson FROM products p JOIN local_line_product_meta l ON l.product_id=p.id WHERE p.id IN (?) FOR UPDATE`,[ids]);
 const changes=[];
 for(const row of rows){
  const evidence=analysis.mappings.find(p=>p.id===row.id),remote=JSON.parse(row.rawJson),packages=remote.packages;
  assert.ok(packages?.length);
  const missing=list=>packages.every(p=>!(p.price_list_entries||[]).some(e=>Number(e.price_list_id??e.price_list)===Number(process.env[list])));
  const expected={excludeFromGuest:evidence.packages.every(p=>p.missing.includes('Guest Basket')),excludeFromSnap:evidence.packages.every(p=>p.missing.includes('SNAP'))};
  assert.equal(missing('LL_PRICE_LIST_GUEST_ID'),expected.excludeFromGuest,`${row.name}: Guest enrollment changed since review`);
  assert.equal(missing('LL_PRICE_LIST_SNAP_ID'),expected.excludeFromSnap,`${row.name}: SNAP enrollment changed since review`);
  assert.ok(!row.excludeFromSnap&&!row.excludeFromGuest,`${row.name}: exclusions already edited; review before seeding`);
  changes.push({id:row.id,name:row.name,before:{excludeFromSnap:false,excludeFromGuest:false},after:expected});
 }
 await fs.writeFile('.local-pricing/ll-bulk/basket-exclusion-seed.json',JSON.stringify({key,changes},null,2),{mode:0o600});
 if(apply){for(const row of changes)await db.query('UPDATE products SET exclude_from_snap=?,exclude_from_guest=? WHERE id=?',[Number(row.after.excludeFromSnap),Number(row.after.excludeFromGuest),row.id]);
  await db.query('INSERT INTO product_basket_eligibility_migrations(migration_key,actor_id,details_json,applied_at) VALUES(?,?,?,UTC_TIMESTAMP())',[key,actor.id,JSON.stringify(changes)]);await db.commit();
 }else await db.rollback();
 console.log(JSON.stringify({applied:apply,products:changes.length,excludeFromGuest:changes.filter(p=>p.after.excludeFromGuest).length,excludeFromSnap:changes.filter(p=>p.after.excludeFromSnap).length,channelWrites:0}));
 }
}finally{db.release();await getPool().end();}
