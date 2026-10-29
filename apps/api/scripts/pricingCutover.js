// Connected invocation requires explicit environment; local rehearsal never loads .env.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import {buildCutoverPlan,applyCutover,rollbackCutover,catalogFields,enterpriseTables} from '../lib/pricingCutover.js';
const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const localDatabase=arg('local-database');
if(localDatabase){const guard=await import('../../../scripts/local-pricing/env.mjs');guard.installLocalEnvironment({database:localDatabase});guard.assertLocalDatabase();guard.installLoopbackNetworkGuard();}
const config={host:process.env.STORE_DB_HOST,port:Number(process.env.STORE_DB_PORT||3306),user:process.env.STORE_DB_USER,password:process.env.STORE_DB_PASSWORD,database:process.env.STORE_DB_DATABASE,dateStrings:true,jsonStrings:true,multipleStatements:false};
if(!config.host||!config.user||!config.database)throw new Error('Explicit database environment is required.');
const mutating=process.argv.includes('--apply')||arg('rollback')||process.argv.includes('--prepare-schema');
if(mutating&&arg('confirm-database')!==config.database)throw new Error('Supply --confirm-database=<exact database>.');
const editorId=Number(arg('editor-id'));
const db=await mysql.createConnection(config);let pool;
try{
 const [[editor]]=await db.query(`SELECT u.id,u.username FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id
   WHERE u.id=? AND COALESCE(u.active,1)=1 AND r.role_key IN ('admin','pricing_admin','pricing_editor','local_pricelist_admin') LIMIT 1`,[editorId]);
 if(!editor||editor.username==='local.admin')throw new Error('Choose a real production pricing editor, not local.admin.');
 if(mutating){const {getPool}=await import('../db.js');pool=getPool();const {ensureEnterprisePricingSchema}=await import('../lib/enterprisePricingSchema.js');await ensureEnterprisePricingSchema();}
 if(process.argv.includes('--prepare-schema')){console.log('Additive pricing schema prepared; no catalog changes or channel requests.');}
 else if(arg('rollback')) console.log(JSON.stringify(await rollbackCutover(db,arg('rollback'))));
 else if(process.argv.includes('--apply')){
   if(!arg('plan')||!arg('approved-hash')||!arg('backup-manifest'))throw new Error('Apply requires --plan, --approved-hash and --backup-manifest.');
   const plan=JSON.parse(await fs.readFile(arg('plan'),'utf8'));
   const backup=JSON.parse(await fs.readFile(arg('backup-manifest'),'utf8'));
   if(!backup.complete||backup.sourceDatabase!==config.database&&!localDatabase)throw new Error('A complete backup of this production database is required.');
   if(plan.hash!==arg('approved-hash')||plan.editorId!==editorId)throw new Error('The approved plan/editor differs.');
   console.log(JSON.stringify(await applyCutover(db,plan)));
 } else {
   if(!arg('baseline')||!arg('source')||!arg('out'))throw new Error('Preview requires --baseline=<original snapshot>, --source=<reviewed local catalog> and --out=<plan.json>.');
   const baseline={};const directory=arg('baseline'),manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
   if(!manifest.complete)throw new Error('Baseline snapshot is incomplete.');
   for(const table of manifest.tables.filter(t=>t.name in catalogFields)){
     if(path.basename(table.filename)!==table.filename)throw new Error('Invalid snapshot path.');
     const bytes=await fs.readFile(path.join(directory,table.filename));
     if(crypto.createHash('sha256').update(bytes).digest('hex')!==table.sha256)throw new Error(`Baseline checksum failed: ${table.name}`);
     baseline[table.name]=bytes.toString().trim().split('\n').filter(Boolean).map(line=>Object.fromEntries(JSON.parse(line).map((v,i)=>[table.columns[i],v])));
   }
   const source=JSON.parse(await fs.readFile(arg('source'),'utf8')).tables,target={};
   await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
   const [tables]=await db.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
   for(const table of [...Object.keys(catalogFields),...enterpriseTables])if(tables.some(t=>t.name===table))target[table]=(await db.query(`SELECT * FROM \`${table}\``))[0];
   await db.rollback();
   // Plans should be generated after additive schema preparation, so expected
   // default settings/enterprise rows are checked exactly during apply.
   const plan=buildCutoverPlan({baseline,source,target,editorId,allowSameApprover:process.argv.includes("--allow-same-approver")});
   if(!tables.some(t=>t.name==='enterprise_pricing_cutovers'))throw new Error('Prepare the additive schema first, then generate a reviewed plan.');
   await fs.mkdir(path.dirname(arg('out')),{recursive:true,mode:0o700});
   await fs.writeFile(arg('out'),JSON.stringify(plan,null,2),{mode:0o600});
   console.log(JSON.stringify({hash:plan.hash,...plan.summary,conflicts:plan.conflicts,held:plan.held}));
 }
}finally{await db.end();if(pool)await pool.end();}
