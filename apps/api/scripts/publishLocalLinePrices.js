// Explicit, resumable operator batch. No web server and no scheduler are started.
// Usage: node --env-file=.env apps/api/scripts/publishLocalLinePrices.js --dir=... [--apply] [--limit=3]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { getPool } from '../db.js';
import { getLocalLineBaseUrl } from '../localLineAuth.js';
import { ensureEnterprisePricingSchema } from '../lib/enterprisePricingSchema.js';
import { ensureProductSyncSchema } from '../lib/productSyncSchema.js';
import { approveEnterprisePricingRevision } from '../lib/enterprisePricingService.js';
import { createProductSyncAudit, getProductSyncAudit, listProductSyncActions, createProductSyncRelease,
  productSyncActionRelease, runProductSyncRelease, getProductSyncRelease } from '../lib/productSync.js';
import { reviewBundlePublication, publishBundle, getBundlePublication } from '../lib/enterpriseBundlePublications.js';
import { LOCAL_LINE_PRICE_SCOPE } from '../lib/localLinePricePublication.js';
const option = name => process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const directory = path.resolve(option('dir') || '.local-pricing/ll-publication');
const apply = process.argv.includes('--apply');
const limit = Number(option('limit') || Infinity);
const only = option('only') ? new Set(option('only').split(',').map(Number)) : null;
const pool = getPool();
const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const clean = error => String(error?.message || error).replace(/(Bearer\s+)\S+/gi,'$1[redacted]')
  .replace(/(password|token|secret)\s*[=:]\s*[^\s,}]+/gi,'$1=[redacted]').slice(0,1500);
let stop = false, plan, lock, activeRemoteId = null, activeBoxId = null;
process.on('SIGTERM',()=>{stop=true;}); process.on('SIGINT',()=>{stop=true;});
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const filename = path.join(directory,'run.json');
async function writeJson(file,value) {await fs.writeFile(`${file}.tmp`,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(`${file}.tmp`,file);}
async function report() {
  plan.updatedAt = new Date().toISOString();
  const counts={};for(const row of plan.products)counts[row.status]=(counts[row.status]||0)+1;
  plan.counts=counts;
  await writeJson(filename,plan);
  const csv = value => `"${String(value??'').replaceAll('"','""')}"`;
  await fs.writeFile(path.join(directory,'results.csv'),[['Product ID','Product','Status','Details','Audit','Release'],
    ...plan.products.map(r=>[r.productId,r.name,r.status,r.message||'',r.auditId||'',r.releaseId||'']),
    ...(plan.bundleReview||[]).map(r=>[`Bundle ${r.id}`,r.name,r.status||'waiting',r.message||'',r.publicationId||'',''])].map(r=>r.map(csv).join(',')).join('\n')+'\n',{mode:0o600});
  await fs.writeFile(path.join(directory,'summary.txt'),`Local Line prices and sales — ${plan.status}\nUpdated: ${plan.updatedAt}\nSquare: excluded (all requests blocked)\n${Object.entries(counts).map(([k,n])=>`${k}: ${n}`).join('\n')}\n\nIssues:\n${plan.products.filter(r=>r.status==='attention').map(r=>`${r.name} (${r.productId}): ${r.message}`).join('\n')}\n\nBundles:\n${(plan.bundleReview||[]).map(r=>`${r.name}: ${r.status||'waiting'}${r.message?` — ${r.message}`:''}`).join('\n')}\n`,{mode:0o600});
}
async function actor() {
  const [[u]]=await pool.query("SELECT id,username FROM users WHERE username='jdeck' AND active=1");
  assert.ok(u,'The requesting administrator is not active.');
  const [roles]=await pool.query('SELECT r.role_key FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.user_id=?',[u.id]);
  const adminRoles=roles.map(r=>r.role_key);
  assert.ok(adminRoles.includes('admin') || (adminRoles.some(r=>['pricing_admin','pricing_publisher'].includes(r)) && adminRoles.includes('localline_push')),'Pricing publication and Local Line Push permissions required.');
  return {userId:Number(u.id),adminRoles};
}
const catalogSql=`SELECT p.id AS productId,p.name,p.exclude_from_snap AS excludeFromSnap,p.exclude_from_guest AS excludeFromGuest,v.name AS vendorName,m.local_line_product_id AS remoteId,
  s.latest_revision_id AS revisionId,r.status AS revisionStatus,r.input_json AS inputJson,r.output_json AS outputJson,
  r.settings_version_id AS settingsVersionId,es.revision AS saleRevision,es.discount_bp AS saleBp,es.promotion_id AS promotionId,
  COALESCE(ps.on_sale,pp.on_sale,0) AS legacyOn,
  CASE WHEN ps.product_id IS NOT NULL THEN ps.sale_discount ELSE pp.sale_discount END AS legacyDiscount
  FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN local_line_product_meta m ON m.product_id=p.id
  LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
  LEFT JOIN enterprise_product_sales es ON es.product_id=p.id LEFT JOIN product_sales ps ON ps.product_id=p.id
  LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id
  WHERE COALESCE(p.is_deleted,0)=0 AND LOWER(TRIM(COALESCE(c.name,'')))<>'membership'
  AND NOT EXISTS(SELECT 1 FROM enterprise_bundle_legacy_products b WHERE b.product_id=p.id)`;
const fingerprint = row => hash({revisionId:row.revisionId,input:parse(row.inputJson),output:parse(row.outputJson),
  excludeFromSnap:row.excludeFromSnap,excludeFromGuest:row.excludeFromGuest,saleRevision:row.saleRevision,saleBp:row.saleBp,promotionId:row.promotionId,legacyOn:row.legacyOn,legacyDiscount:row.legacyDiscount});
// Enforce the destination and payload boundary even if a called helper regresses.
const realFetch=globalThis.fetch, base=new URL(getLocalLineBaseUrl());
globalThis.fetch=async(url,options={})=>{
  const target=new URL(url),method=String(options.method||'GET').toUpperCase();
  assert.equal(target.origin,base.origin,'This batch forbids every non-Local Line network request, including Square');
  assert.ok(target.pathname.startsWith(base.pathname),'Unexpected Local Line API path');
  if(method==='PATCH') {
    assert.ok(apply,'Publication must be explicitly enabled');
    const body=JSON.parse(options.body);
    if(activeBoxId && target.pathname===`${base.pathname}boxes/${activeBoxId}/`){
      assert.ok(Array.isArray(body) && body.every(op=>op.op==='replace' && (op.path==='/price' || /^\/product_price_list_entries\/\d+\/box_package_entry\/(adjustment|adjustment_type|adjustment_value)$/.test(op.path))), 'Bundle catalog, inventory and component edits require separate review');
      return realFetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(45000)});
    }
    assert.ok(activeRemoteId && target.pathname===`${base.pathname}products/${activeRemoteId}/`,'Only the current reviewed Local Line product may be patched');
    assert.deepEqual(Object.keys(body).sort(),['packages','vendor'],'Price-only payload required');
    for(const p of body.packages)assert.ok(Object.keys(p).every(k=>['id','name','unit_price','price_list_entries'].includes(k)),'Inventory or catalog edits are prohibited');
  } else assert.ok(method==='GET'||(method==='POST'&&target.pathname===`${base.pathname}token/`),'Only catalog reads and authentication are allowed');
  return realFetch(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
};
try {
  assert.notEqual(process.env.CSA_LOCAL_ONLY,'true','Use the connected production configuration, not isolated test mode');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  lock=await pool.getConnection();
  const [[held]]=await lock.query("SELECT GET_LOCK('csa-local-line-price-batch',0) AS acquired");
  assert.equal(Number(held.acquired),1,'Another Local Line price batch is running');
  await ensureProductSyncSchema();await ensureEnterprisePricingSchema();
  const user=await actor();
  plan=await fs.readFile(filename,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!plan){
    const [rows]=await pool.query(`${catalogSql} ORDER BY p.name,p.id`);
    const [bundles]=await pool.query('SELECT id,name FROM enterprise_bundles ORDER BY name');
    plan={version:1,databaseFingerprint:hash([process.env.STORE_DB_HOST,process.env.STORE_DB_PORT,process.env.STORE_DB_DATABASE]),
      createdAt:new Date().toISOString(),actorId:user.userId,platforms:['localline'],status:'prepared',
      products:rows.filter(r=>!only||only.has(Number(r.productId))).map(r=>({...r,baselineHash:fingerprint(r),status:'waiting'})),
      skipBundles:process.argv.includes('--skip-bundles'),
      bundleReview:bundles.map(r=>({...r,message:'Native bundles require their separate component-price review after product publication.'}))};
    await report();
  }
  assert.equal(plan.version,1);assert.deepEqual(plan.platforms,['localline']);
  assert.equal(plan.databaseFingerprint,hash([process.env.STORE_DB_HOST,process.env.STORE_DB_PORT,process.env.STORE_DB_DATABASE]),'Resume database differs');
  assert.equal(plan.actorId,user.userId);
  if(!plan.bundleBaselinesFrozen){
    const [bundles]=await pool.query('SELECT id,name,revision,remote_box_id AS remoteBoxId,input_json AS inputJson FROM enterprise_bundles ORDER BY name');
    plan.bundleReview=(plan.skipBundles?[]:bundles).map(b=>({...b,status:'waiting',baselineHash:hash([b.revision,parse(b.inputJson)])}));
    plan.bundleBaselinesFrozen=true;await report();
  }
  if(!apply)log(`Prepared ${plan.products.length} products. No channel changes. ${filename}`);
  else {
    plan.status='running';plan.pid=process.pid;await report();let processed=0;
    for(const row of plan.products){
      if(stop||processed>=limit)break;
      if(only&&!only.has(Number(row.productId)))continue;
      if(['published','matched','attention'].includes(row.status))continue;
      processed++;row.status='checking';await report();
      log(`Checking ${row.productId} ${row.name}`);
      try {
        const user=await actor();
        activeRemoteId=Number(row.remoteId);
        if(!row.revisionId)throw new Error('No saved enterprise pricing; buy price or pricing inputs need review.');
        if(!row.vendorName?.trim())throw new Error('Assign a named vendor before publication.');
        if(!activeRemoteId)throw new Error('An approved Local Line product mapping is missing.');
        // Recover a durable receipt before considering any replacement release.
        if(!row.releaseId && row.auditId && row.actionId){const receipt=await productSyncActionRelease(row.auditId,row.actionId);if(receipt)row.releaseId=receipt.id;}
        if(!row.releaseId){
          const [[fresh]]=await pool.query(`${catalogSql} AND p.id=?`,[row.productId]);
          if(!fresh||fingerprint(fresh)!==row.baselineHash)throw new Error('Local pricing or sale changed after the batch started; review in the next run.');
          if(['pending','local-preview'].includes(fresh.revisionStatus))await approveEnterprisePricingRevision(row.revisionId,user,{localLinePricesOnly:true});
          if(!row.auditId){
            const audit=await createProductSyncAudit({platforms:['localline'],productIds:[row.productId],enterpriseRevisionId:row.revisionId,
              publicationScope:LOCAL_LINE_PRICE_SCOPE,productScope:'selected',vendorGroup:'all',incoming:false},user);
            row.auditId=audit.id;await report();
          }
          let audit;
          for(let poll=0;poll<600;poll++){audit=await getProductSyncAudit(row.auditId);if(audit.status!=='running')break;await sleep(1000);}
          if(audit.status!=='completed')throw new Error(audit.error||`Audit ${audit.id} is ${audit.status}; resume its receipt after review.`);
          const actions=(await listProductSyncActions(row.auditId,{direction:'outgoing',pageSize:100})).rows;
          if(actions.length!==1||actions[0].platform!=='localline')throw new Error('The audit did not return exactly one Local Line product action.');
          const action=actions[0];row.actionId=action.id;row.comparison=action.display?.pricingComparison;await report();
          if(!['changed','synced'].includes(action.status))throw new Error(action.message||`Publication ${action.status}`);
          if(!action.localLinePricesOnly||action.enterpriseRevisionId!==Number(row.revisionId))throw new Error('The audit scope differs from this batch.');
          row.wasMatched=action.status==='synced';
          // Even matching prices receive a durable receipt confirming sale flags.
          const existing=await productSyncActionRelease(row.auditId,row.actionId);
          const receipt=existing||await createProductSyncRelease({auditId:row.auditId,actionIds:[row.actionId],localWorkerOnly:true,
            name:`Local Line price batch · ${row.name} · revision ${row.revisionId}`},user);
          row.releaseId=receipt.id;await report();
        }
        let result;
        for(let attempt=0;attempt<3;attempt++){
          try {result=await runProductSyncRelease(row.releaseId,{user,allowFuture:true});}
          catch(e){if(attempt===2)throw e;await sleep(5000*(attempt+1));continue;}
          if(['completed','held','cancelled'].includes(result.status))break;
          await sleep(5000*(attempt+1));
        }
        result ||= await getProductSyncRelease(row.releaseId);
        if(result.status!=='completed')throw new Error(result.actions.map(a=>a.message).filter(Boolean).join(' · ')||`Release ${result.status}`);
        row.status=row.wasMatched?'matched':'published';row.message='Verified prices in all eligible Local Line baskets.';
        row.finishedAt=new Date().toISOString();
      }catch(e){row.status='attention';row.message=clean(e);}
      await report();log(`${row.status}: ${row.name}${row.status==='attention'?` — ${row.message}`:''}`);
      activeRemoteId=null;await sleep(500);
    }
    if(!stop&&!plan.products.some(r=>['waiting','checking'].includes(r.status)))for(const bundle of plan.bundleReview){
      if(stop)break;
      if(['published','matched','attention'].includes(bundle.status))continue;
      log(`Checking bundle ${bundle.name}`);
      try{
        const user=await actor();
        const [[fresh]]=await pool.query('SELECT revision,input_json FROM enterprise_bundles WHERE id=?',[bundle.id]);
        if(!fresh||hash([fresh.revision,parse(fresh.input_json)])!==bundle.baselineHash)throw new Error('Bundle changed after this batch started.');
        activeBoxId=Number(bundle.remoteBoxId);
        const review=bundle.publicationId?await getBundlePublication(bundle.publicationId):await reviewBundlePublication(bundle.id,user);
        bundle.publicationId=review.id;await report();
        if(review.snapshot.patch.some(op=>op.path!=='/price'&&!/^\/product_price_list_entries\/\d+\/box_package_entry\/(adjustment|adjustment_type|adjustment_value)$/.test(op.path)))throw new Error('This bundle also needs catalog or component changes. Review them separately before publication.');
        const result=await publishBundle(review.id,user);
        if(result.status!=='verified')throw new Error(`Bundle publication ${result.status}`);
        bundle.status='published';bundle.message='Verified Local Line bundle prices.';
      }catch(e){bundle.status='attention';bundle.message=clean(e);}
      activeBoxId=null;await report();log(`${bundle.status}: ${bundle.name} — ${bundle.message}`);
    }
    plan.status=plan.products.some(r=>['waiting','checking'].includes(r.status))||plan.bundleReview.some(r=>r.status==='waiting')?'paused':'finished';await report();
    log(`${plan.status}: ${JSON.stringify(plan.counts)}. Report: ${path.join(directory,'summary.txt')}`);
  }
}catch(e){log(`Stopped: ${clean(e)}`);if(plan){plan.status='interrupted';plan.error=clean(e);await report().catch(()=>{});}process.exitCode=1;}
finally{if(lock){await lock.query("SELECT RELEASE_LOCK('csa-local-line-price-batch')").catch(()=>{});lock.release();}await pool.end();}
