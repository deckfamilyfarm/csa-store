// Preview/apply an explicit workbook campaign to the isolated local clone only.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from './env.mjs';
import { workbookMarkupPlan, matchingProducePresets } from './workbookMarkupPlan.mjs';
installLocalEnvironment(); assertLocalDatabase(); installLoopbackNetworkGuard();
const { getPool } = await import('../../apps/api/db.js');
const { getPricingSettings, getEnterprisePricingProduct, previewEnterprisePricing, saveEnterprisePricingDraft } = await import('../../apps/api/lib/enterprisePricingService.js');
const pool = getPool(), parse = x => typeof x === 'string' ? JSON.parse(x) : x;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const applyPath = process.argv.includes('--apply') ? process.argv[process.argv.indexOf('--apply') + 1] : null;
const workbookPath = process.argv[process.argv.indexOf('--workbook') + 1];
const reportPath = applyPath || new URL(`../../.local-pricing/workbook-markups-${Date.now()}.json`, import.meta.url).pathname;
let report;
const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
try {
  const settings = await getPricingSettings();
  const [[actor]] = await pool.query("SELECT id FROM users WHERE username='local.admin'");
  if (!actor) throw new Error('Local administrator is missing.');
  if (applyPath) {
    report = JSON.parse(fs.readFileSync(applyPath));
    if (report.database !== process.env.STORE_DB_DATABASE || report.applied) throw new Error('This plan belongs to another database or is already applied.');
    if (hash(settings) !== report.settingsHash) throw new Error('Settings changed; generate a fresh preview.');
    if (crypto.createHash('sha256').update(fs.readFileSync(report.source)).digest('hex') !== report.sourceHash) throw new Error('Workbook changed; generate a fresh preview.');
    // Validate the entire plan before making any local changes.
    for (const entry of report.products.filter(row => row.status === 'planned')) {
      const detail = await getEnterprisePricingProduct(entry.id);
      if (hash({product:detail.product,packages:detail.packages,latest:detail.latest,buyPrice:detail.buyPrice}) !== entry.baselineHash) throw new Error(`${entry.name}: data changed since preview.`);
      const preview = await previewEnterprisePricing(entry.id, entry.input);
      if (hash(preview.output) !== hash(entry.after)) throw new Error(`${entry.name}: calculation changed since preview.`);
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [active] = await connection.query("SELECT id,settings_json AS settingsJson FROM enterprise_pricing_settings_versions WHERE status='active' FOR UPDATE");
      if (active.length !== 1 || Number(active[0].id) !== settings.id) throw new Error('Settings changed since preview.');
      // Persist the new preset in a versioned local settings record, without inventing publication approval.
      const stored = parse(active[0].settingsJson);
      if (stored.markupBp?.creamyCow !== 4000) {
        const {id,...next}=settings;
        await connection.query("UPDATE enterprise_pricing_settings_versions SET status='superseded' WHERE id=?",[id]);
        const [result]=await connection.query("INSERT INTO enterprise_pricing_settings_versions (status,settings_json,created_by,created_at) VALUES ('active',?,?,UTC_TIMESTAMP())",[JSON.stringify(next),actor.id]);
        report.settingsVersionId=Number(result.insertId);
      } else report.settingsVersionId=settings.id;
      await connection.commit();
    } catch(error) { await connection.rollback(); throw error; } finally { connection.release(); }
    persist();
    for (const entry of report.products.filter(row => row.status === 'planned')) {
      const saved=await saveEnterprisePricingDraft(entry.id,entry.input,entry.before?.id||null,{userId:actor.id},entry.buyPriceRevision);
      entry.savedRevisionId=saved.revisionId; entry.status='saved'; persist();
      const verified=await getEnterprisePricingProduct(entry.id);
      if(verified.active?.id!==saved.revisionId || verified.latest.input.markupCategory!==entry.target || verified.latest.input.customMarkupBp!==null || hash(verified.latest.output)!==hash(entry.after)) throw new Error(`${entry.name}: verification failed.`);
      entry.verified=true; persist();
    }
    report.applied=true; report.appliedAt=new Date().toISOString();
  } else {
    if (!process.argv.includes('--workbook')) throw new Error('Use --workbook /path/to/file.xlsx to preview, then --apply /path/to/report.json.');
    const workbook=JSON.parse(execFileSync('python3',[new URL('./readMarkupWorkbook.py',import.meta.url).pathname,workbookPath],{encoding:'utf8'}));
    const [catalog]=await pool.query(`SELECT p.id,p.name,p.is_deleted AS deleted,v.name AS vendor,c.name AS category,r.input_json AS inputJson,r.output_json AS outputJson
      FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id`);
    const [packages]=await pool.query('SELECT id,product_id AS productId,name FROM packages');
    for(const row of catalog){row.packages=packages.filter(pkg=>Number(pkg.productId)===Number(row.id));row.input=parse(row.inputJson);row.output=parse(row.outputJson);}
    const products=workbookMarkupPlan(workbook,catalog);
    if(process.argv.includes('--include-name-matches')) products.push(...matchingProducePresets(workbook,catalog));
    // User-approved dairy consolidation: retain the ~40% band; review every other dairy rate.
    for(const row of catalog) if(!row.deleted && /creamy cow/i.test(row.vendor||'') && row.input && row.output?.appliedMarkupBp>=3995 && row.output.appliedMarkupBp<=4005 && !products.some(entry=>entry.id===Number(row.id)))
      products.push({id:Number(row.id),name:row.name,vendor:row.vendor,target:'creamyCow',bp:4000,sourceRows:[],notes:['Approved Creamy Cow 40% preset; existing rounding variation normalized'],reasons:[],status:'matched'});
    report={source:workbook.source,sourceHash:workbook.sha256,sheet:workbook.sheet,database:process.env.STORE_DB_DATABASE,createdAt:new Date().toISOString(),settingsHash:hash(settings),settings,externalPublications:0,products};
    for(const entry of products.filter(row=>row.status==='matched')) {
      const detail=await getEnterprisePricingProduct(entry.id);
      entry.before=detail.latest;entry.buyPriceRevision=detail.buyPrice?.revision||0;
      entry.baselineHash=hash({product:detail.product,packages:detail.packages,latest:detail.latest,buyPrice:detail.buyPrice});
      if(detail.latest && !['local-preview','active'].includes(detail.latest.status)){entry.status='held';entry.reasons.push(`Resolve ${detail.latest.status} pricing first`);continue;}
      try {
        const preview=await previewEnterprisePricing(entry.id,{...structuredClone(detail.suggestedInput),markupCategory:entry.target,customMarkupBp:null,priceEffectiveAt:new Date().toISOString()});
        entry.input=preview.input;entry.after=preview.output;
        if(entry.after.appliedMarkupBp!==entry.bp) throw new Error('Preset rate does not match the workbook');
        entry.status=detail.latest?.input.markupCategory===entry.target && detail.latest.input.customMarkupBp==null && hash(detail.latest.output)===hash(entry.after)?'unchanged':'planned';
      }catch(error){entry.status='held';entry.reasons.push(error.message);}
    }
  }
  report.summary={products:report.products.length,byStatus:Object.fromEntries(['planned','saved','unchanged','held'].map(status=>[status,report.products.filter(row=>row.status===status).length])),
    byPreset:Object.fromEntries(['shelfStable','perishable','highlyPerishable','creamyCow'].map(key=>[key,report.products.filter(row=>row.target===key&&row.status!=='held').length]))};
  persist();console.log(JSON.stringify({report:reportPath,...report.summary,externalPublications:0},null,2));
}catch(error){if(report){report.error=error.message;persist();}console.error(error.message);process.exitCode=1;}
finally{await pool.end();}
