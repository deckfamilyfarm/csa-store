// Explicit local-only import of reviewed Square category assignments. No remote writes.
import fs from 'node:fs/promises';
import { getPool } from '../db.js';
import { fingerprint } from '../lib/productSyncCore.js';
import { buildSquareCategoryCrosswalk, readSquareCategorySource, squareCategoryTarget, importSquareCategoryCrosswalk } from '../lib/squareCategoryCrosswalk.js';
const directory=new URL('../../../.local-pricing/square-category-crosswalk/',import.meta.url), file=new URL('plan.json',directory);
const pool=getPool();
try {
  if (process.argv.includes('--apply')) {
    const plan=JSON.parse(await fs.readFile(file,'utf8'));
    if (plan.target!==squareCategoryTarget() || plan.sourceHash!==fingerprint(await readSquareCategorySource())) throw new Error('Source catalog or local links changed. Review a fresh preview.');
    const result=await importSquareCategoryCrosswalk(plan.crosswalk,plan.target);
    plan.appliedAt=new Date().toISOString(); await fs.writeFile(new URL('applied.json',directory),JSON.stringify(plan,null,2));
    console.log(JSON.stringify(result,null,2));
  } else {
    const source=await readSquareCategorySource();
    const plan={target:squareCategoryTarget(),createdAt:new Date().toISOString(),sourceHash:fingerprint(source),crosswalk:buildSquareCategoryCrosswalk(source)};
    await fs.mkdir(directory,{recursive:true}); await fs.writeFile(file,JSON.stringify(plan,null,2));
    console.log(JSON.stringify({categories:plan.crosswalk.registry.map(row=>row.category_data.name),counts:Object.fromEntries(['product','category','square-item'].map(scope=>[scope,plan.crosswalk.bindings.filter(row=>row.scope===scope).length])),defaults:plan.crosswalk.bindings.filter(row=>row.scope==='category'),issues:plan.crosswalk.issues},null,2));
  }
} finally { await pool.end(); }
