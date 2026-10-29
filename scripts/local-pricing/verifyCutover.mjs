import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {installLocalEnvironment,assertLocalDatabase,installLoopbackNetworkGuard} from './env.mjs';
import {catalogFields,canonical,digest} from '../../apps/api/lib/pricingCutover.js';
const arg=n=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3);
const database=arg('database');if(!database)throw new Error('Explicit rehearsal --database is required.');
installLocalEnvironment({database});assertLocalDatabase();installLoopbackNetworkGuard();
const {default:mysql}=await import('../../apps/api/node_modules/mysql2/promise.js');
const db=await mysql.createConnection({host:process.env.STORE_DB_HOST,port:Number(process.env.STORE_DB_PORT),user:process.env.STORE_DB_USER,password:process.env.STORE_DB_PASSWORD,database,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
const dir=arg('snapshot'),manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8')),verified=[];
const rolledBack=process.argv.includes("--rolled-back");
const rowHash=rows=>digest(rows.map(r=>canonical(r)).sort());
try{
 for(const table of manifest.tables){
  if(!rolledBack && table.name in catalogFields)continue;
  const before=(await fs.readFile(path.join(dir,table.filename),'utf8')).trim().split('\n').filter(Boolean).map(line=>Object.fromEntries(JSON.parse(line).map((v,i)=>[table.columns[i],v])));
  const [after]=await db.query(`SELECT ${table.columns.map(c=>'`'+c+'`').join(',')} FROM \`${table.name}\``);
  if(rowHash(after)!==rowHash(before)){
   const key=table.columns[0];const old=new Map(before.map(r=>[String(r[key]),r]));
   console.log(JSON.stringify({table:table.name,differences:after.filter(r=>canonical(r)!==canonical(old.get(String(r[key])))).slice(0,3).map(r=>({id:r[key],fields:table.columns.filter(c=>canonical(r[c])!==canonical(old.get(String(r[key]))?.[c])).map(c=>({field:c,beforeType:typeof old.get(String(r[key]))?.[c],afterType:typeof r[c],beforeLength:String(old.get(String(r[key]))?.[c]).length,afterLength:String(r[c]).length}))}))}));
  }
  assert.equal(rowHash(after),rowHash(before),`${table.name} must be unchanged`);verified.push(table.name);
 }
 for(const [name,cols] of [['products',['id','inventory','track_inventory','stock_on_farm','stock_on_farm_lbs','farm_stock_revision']],['packages',['id','inventory','track_inventory']]]){
  const table=manifest.tables.find(t=>t.name===name);
  const before=(await fs.readFile(path.join(dir,table.filename),'utf8')).trim().split('\n').filter(Boolean).map(line=>Object.fromEntries(JSON.parse(line).map((v,i)=>[table.columns[i],v])));
  const fields=cols.filter(c=>table.columns.includes(c)),pick=r=>Object.fromEntries(fields.map(c=>[c,r[c]]));
  const [after]=await db.query(`SELECT ${fields.map(c=>'`'+c+'`').join(',')} FROM \`${name}\``);
  assert.equal(rowHash(after),rowHash(before.map(pick)),`${name} inventory must be unchanged`);
 }
 const [[account]]=await db.query("SELECT COUNT(*) AS n FROM users WHERE username='local.admin'");assert.equal(Number(account.n),0);
 const [[pub]]=await db.query('SELECT COUNT(*) AS n FROM enterprise_pricing_publications');assert.equal(Number(pub.n),0);
 const [[bundlePub]]=await db.query('SELECT COUNT(*) AS n FROM enterprise_bundle_publications');assert.equal(Number(bundlePub.n),0);
 const [[bundles]]=await db.query('SELECT COUNT(*) AS n FROM enterprise_bundles');assert.equal(Number(bundles.n),rolledBack?0:10);
 const [[pricing]]=await db.query('SELECT COUNT(*) AS total,SUM(active_revision_id IS NOT NULL) AS active FROM enterprise_pricing_product_state');
 const [[settings]]=await db.query("SELECT settings_json FROM enterprise_pricing_settings_versions WHERE status='active'");assert.equal(JSON.parse(settings.settings_json).requireDifferentApprover,rolledBack);
 const result={verifiedAt:new Date().toISOString(),database,unchangedTables:verified,inventoryUnchanged:true,developmentAccountAbsent:true,channelPublications:0,bundles:Number(bundles.n),rolledBack,pricing};
 await fs.writeFile(arg('out'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({unchangedTables:verified.length,inventoryUnchanged:true,channelPublications:0,bundles:Number(bundles.n),rolledBack,pricing}));
}finally{await db.end();}
