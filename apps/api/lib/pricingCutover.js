// A three-way catalog merge. This allowlist deliberately excludes accounts,
// orders, inventory, farm counts, publication receipts and authentication data.
import crypto from 'node:crypto';
import {calculateEnterprisePricing} from './enterprisePricingEngine.js';
export const catalogFields = {
  vendors: ['id','name'], categories: ['id','name'],
  products: ['id','name','description','visible','category_id','vendor_id','thumbnail_url','is_deleted'],
  packages: ['id','product_id','name','price','package_code','unit','num_of_items','track_type','charge_type','visible'],
  product_pricing_profiles: ['product_id','unit_of_measure','source_unit_price','min_weight','max_weight','avg_weight_override','source_multiplier','guest_markup','member_markup','herd_share_markup','snap_markup','on_sale','sale_discount','markup_override','customer_price_overrides_json'],
  product_images: ['id','product_id','url','url_hash'],
  product_media: ['id','product_id','source','source_media_id','source_url','remote_url','storage_key','public_url','thumbnail_url','sort_order','is_primary','alt_text','content_hash','width','height','mime_type'],
  local_line_product_meta: ['product_id','local_line_product_id'],
  local_line_package_meta: ['package_id','product_id','local_line_package_id'],
  square_variation_links: ['id','product_id','package_id','square_item_id','square_variation_id','match_score','match_notes','approved_by_user_id','approved_at'],
};
export const enterpriseTables = ['enterprise_pricing_enterprises','enterprise_pricing_settings_versions',
  'enterprise_pricing_revisions','enterprise_pricing_product_state','enterprise_pricing_buy_price_drafts',
  'enterprise_pricing_markup_assignments','enterprise_pricing_migration_rows','enterprise_purchase_cost_history',
  'enterprise_wholesale_price_history','enterprise_bundles','enterprise_bundle_revisions','enterprise_bundle_legacy_products'];
export const keyFor = table => ['product_pricing_profiles','local_line_product_meta','enterprise_pricing_product_state','enterprise_pricing_buy_price_drafts','enterprise_pricing_markup_assignments','enterprise_bundle_legacy_products'].includes(table) ? 'product_id' : table === 'local_line_package_meta' ? 'package_id' : 'id';
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k,item[k]])) : item);
export const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const descriptionText = value => String(value??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();
const equalField=(field,a,b)=>field==='description'?descriptionText(a)===descriptionText(b):equal(a,b);
const equal = (a,b) => canonical(a ?? null) === canonical(b ?? null);
// MySQL pads DECIMAL scale and expands date-only DATETIME values on insertion.
// Compare those typed values without floating point or weakening text/JSON checks.
export function databaseFieldEqual(actual, expected, type) {
  const normalize = value => {
    if(value == null)return null;
    if(type==='decimal' && /^-?\d+(?:\.\d+)?$/.test(String(value)))return String(value).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
    if(['datetime','timestamp'].includes(type) && /^\d{4}-\d{2}-\d{2}$/.test(String(value)))return `${value} 00:00:00`;
    return value;
  };
  return equal(normalize(actual),normalize(expected));
}
const pick = (row, fields) => row ? Object.fromEntries(fields.filter(k => Object.hasOwn(row,k)).map(k => [k,row[k]])) : null;
const map = (rows,key) => new Map((rows || []).map(row => [String(row[key]),row]));
const deletable = new Set(['product_images','product_media','local_line_package_meta']);
export function buildCutoverPlan({baseline, source, target, editorId, allowSameApprover = false}) {
  if (!Number.isSafeInteger(editorId) || editorId <= 0) throw new Error('A production pricing editor is required.');
  const operations = [], conflicts = [], held = [], provenance = [];
  const sourceHash=digest(source);
  source=structuredClone(source);
  const activeSettings=source.enterprise_pricing_settings_versions?.find(s=>s.status==='active');
  if(!activeSettings)throw new Error('Reviewed local pricing settings are required.');
  const settings=JSON.parse(activeSettings.settings_json);
  settings.requireDifferentApprover=!allowSameApprover;
  const version=Math.max(...source.enterprise_pricing_settings_versions.map(s=>Number(s.id)))+1;
  activeSettings.status='superseded';
  source.enterprise_pricing_settings_versions.push({...activeSettings,id:version,status:'active',settings_json:JSON.stringify(settings),created_by:editorId,approved_by:null,approved_at:null});
  const latest=new Set((source.enterprise_pricing_product_state||[]).map(s=>s.latest_revision_id));
  for(const row of source.enterprise_pricing_revisions||[])if(latest.has(row.id)){
    const input=JSON.parse(row.input_json),before=JSON.parse(row.output_json);
    const cost=input.purchaseCosts.filter(c=>c.enterpriseId===input.retailEnterpriseId&&c.effectiveAt<=input.priceEffectiveAt).sort((a,b)=>b.effectiveAt.localeCompare(a.effectiveAt))[0];
    const output=calculateEnterprisePricing({...input,buyFromPrice:cost?.cost},settings);
    output.wholesale=before.wholesale||[];
    if(!equal(output.packages,before.packages)||output.squareUnitCents!==before.squareUnitCents||output.csaUnitCents!==before.csaUnitCents)conflicts.push({table:'enterprise_pricing_revisions',id:row.id,reason:'Current settings change a reviewed selling price.'});
    provenance.push({table:'enterprise_pricing_revisions',id:row.id,sourceSettingsVersion:row.settings_version_id});
    row.settings_version_id=version;row.output_json=JSON.stringify(output);
  }
  // Older local previews stored complete revisions but did not populate the
  // searchable cost/wholesale history tables. Preserve their effective dates.
  for(const [table,rowsFor] of [
    ['enterprise_purchase_cost_history',r=>JSON.parse(r.input_json).purchaseCosts.map(c=>({product_id:r.product_id,purchasing_enterprise_id:c.enterpriseId,cost:c.cost,effective_at:c.effectiveAt,documentation_ref:c.documentationRef??null,revision_id:r.id,recorded_at:r.created_at}))],
    ['enterprise_wholesale_price_history',r=>(JSON.parse(r.output_json).wholesale||[]).map(w=>({product_id:r.product_id,selling_enterprise_id:w.sellingEnterpriseId,mode:w.mode,price_cents:w.priceCents,markup_bp:w.markupBp??null,cost_enterprise_id:w.costEnterpriseId??null,revision_id:r.id,recorded_at:r.created_at}))]
  ]) {
    source[table] ||= [];
    const recorded=new Set(source[table].map(r=>r.revision_id));
    let next=Math.max(0,...source[table].map(r=>Number(r.id)));
    for(const revision of source.enterprise_pricing_revisions||[])if(!recorded.has(revision.id))for(const row of rowsFor(revision))source[table].push({id:++next,...row});
  }
  const sourceProducts = map(source.products,'id'), vendors = map(source.vendors,'id');
  const vendorless = new Set([...sourceProducts.values()].filter(p => !vendors.get(String(p.vendor_id))?.name?.trim()).map(p => String(p.id)));
  const ignoredProduct = row => row && vendorless.has(String(row.product_id ?? row.id));
  for (const [table,fields] of Object.entries(catalogFields)) {
    const key = keyFor(table), before = map(baseline[table],key), after = map(source[table],key), current = map(target[table],key);
    for (const id of new Set([...before.keys(),...after.keys()])) {
      const b = before.get(id), s = after.get(id), t = current.get(id);
      if (!['vendors','categories'].includes(table) && ignoredProduct(s || b)) { if (!equal(pick(b,fields),pick(s,fields))) held.push({table,id,reason:'Missing vendor; left unchanged.'}); continue; }
      if (!s) {
        if (b && t && deletable.has(table)) {
          if (!equal(pick(b,fields),pick(t,fields))) conflicts.push({table,id,reason:'Production changed a locally removed record.'});
          else operations.push({table,key,id,kind:'delete',before:t,after:null});
        }
        continue;
      }
      if (!b && !t) { operations.push({table,key,id,kind:'insert',before:null,after:pick(s,fields)}); continue; }
      if (!t) { if (!equal(pick(b,fields),pick(s,fields))) conflicts.push({table,id,reason:'Production removed a locally edited record.'}); continue; }
      const changed = fields.filter(k => k !== key && !equalField(k,s[k],b?.[k]) && !equalField(k,s[k],t[k]));
      const contested = changed.filter(k => !equalField(k,t[k],b?.[k]));
      if (contested.length) { conflicts.push({table,id,fields:contested.map(field => ({field,baseline:b?.[field],local:s[field],production:t[field]}))}); continue; }
      if (changed.length) operations.push({table,key,id,kind:'update',before:pick(t,changed),after:pick(s,changed)});
    }
  }
  // A first cutover may bootstrap empty enterprise tables, but must never merge
  // competing pricing revision histories by coincident numeric IDs.
  const occupied = enterpriseTables.filter(table => !['enterprise_pricing_enterprises','enterprise_pricing_settings_versions'].includes(table) && target[table]?.length);
  if (occupied.length) conflicts.push({reason:'Production already has enterprise pricing data; use its existing cutover receipt or review a follow-up migration.',tables:occupied});
  for (const table of enterpriseTables) for (const original of source[table] || []) {
    if (ignoredProduct(original) && !['enterprise_pricing_enterprises','enterprise_pricing_settings_versions','enterprise_bundles','enterprise_bundle_revisions'].includes(table)) continue;
    const row = structuredClone(original), key = keyFor(table);
    for (const actor of ['editor_id','created_by','approved_by','edited_by','assigned_by','actor_id']) if (row[actor] != null) { provenance.push({table,id:row[key],field:actor,sourceUserId:row[actor]}); row[actor] = editorId; }
    if (table === 'enterprise_pricing_revisions') { row.status = 'pending'; row.approver_id = null; row.approved_at = null; row.rejected_at = null; }
    if (table === 'enterprise_pricing_settings_versions') { row.approved_by = null; row.approved_at = null; }
    if (table === 'enterprise_pricing_migration_rows') row.run_key = `cutover-source:${row.run_key}`;
    const current = (target[table] || []).find(t => String(t[key]) === String(row[key]));
    if (current && !['enterprise_pricing_enterprises','enterprise_pricing_settings_versions'].includes(table)) continue;
    if (current && table === 'enterprise_pricing_enterprises' && (current.code !== row.code || current.name !== row.name)) { conflicts.push({table,id:row[key],reason:'Enterprise identity conflict.'}); continue; }
    if (current && table === 'enterprise_pricing_settings_versions' && (current.created_by != null || Number(current.id) !== 1)) { conflicts.push({table,id:row[key],reason:'Production has edited pricing settings.'}); continue; }
    operations.push({table,key,id:String(row[key]),kind:current?'update':'insert',before:current || null,after:row});
  }
  const plan = {version:1,reviewId:crypto.randomUUID(),editorId,allowSameApprover,sourceHash,baselineHash:digest(baseline),operations,conflicts,held,provenance,
    excluded:['users','roles','orders','payments','inventory','farm stock','channel publication receipts','promotions']};
  return {...plan,hash:digest(plan),summary:{operations:operations.length,conflicts:conflicts.length,held:held.length,byTable:Object.fromEntries([...new Set(operations.map(o=>o.table))].map(t=>[t,operations.filter(o=>o.table===t).length]))}};
}
export function validatePlan(plan) {
  const {hash,summary,...body}=plan;
  if (plan.version !== 1 || digest(body)!==hash || plan.conflicts.length) throw new Error('The reviewed migration plan is invalid or has unresolved conflicts.');
  for (const op of plan.operations) {
    if (!(op.table in catalogFields) && !enterpriseTables.includes(op.table)) throw new Error('Migration table is not allowed.');
    if (op.key !== keyFor(op.table) || !/^\d+$/.test(op.id)) throw new Error('Invalid migration record key.');
    if (op.table in catalogFields && Object.keys(op.after || {}).some(k => !catalogFields[op.table].includes(k))) throw new Error('Protected catalog field in migration.');
    if (!['insert','update','delete'].includes(op.kind) || op.kind==='delete' && !deletable.has(op.table)) throw new Error('Invalid migration action.');
  }
}
export async function applyCutover(db, plan) {
  validatePlan(plan);
  const [[lock]]=await db.query("SELECT GET_LOCK('enterprise-pricing-cutover',0) AS acquired");
  if (!lock.acquired) throw new Error('Another pricing migration is running.');
  try {
    await db.beginTransaction();
    const [existing]=await db.query('SELECT * FROM enterprise_pricing_cutovers WHERE plan_hash=? FOR UPDATE',[plan.hash]);
    if (existing.length) { await db.rollback(); if(existing[0].status==='rolled-back') throw new Error('This plan was rolled back. Generate a new reviewed plan.'); return {status:'already-applied',hash:plan.hash}; }
    for (const op of plan.operations) {
      const [[current]]=await db.query(`SELECT * FROM \`${op.table}\` WHERE \`${op.key}\`=? FOR UPDATE`,[op.id]);
      if (op.kind==='insert' ? !!current : !current || Object.keys(op.before).some(k=>!equal(current[k],op.before[k]))) throw new Error(`Production changed since review: ${op.table} ${op.id}.`);
      if (op.kind==='delete') await db.query(`DELETE FROM \`${op.table}\` WHERE \`${op.key}\`=?`,[op.id]);
      else if (op.kind==='insert') await db.query(`INSERT INTO \`${op.table}\` SET ?`,[op.after]);
      else await db.query(`UPDATE \`${op.table}\` SET ? WHERE \`${op.key}\`=?`,[op.after,op.id]);
    }
    await db.query("INSERT INTO enterprise_pricing_cutovers (plan_hash,status,plan_json,editor_id,applied_at) VALUES (?,'applied',?,?,UTC_TIMESTAMP())",[plan.hash,JSON.stringify(plan),plan.editorId]);
    await db.commit(); return {status:'applied',hash:plan.hash,operations:plan.operations.length};
  } catch(error) { await db.rollback(); throw error; } finally { await db.query("SELECT RELEASE_LOCK('enterprise-pricing-cutover')"); }
}
export async function rollbackCutover(db, hash) {
  const [[lock]]=await db.query("SELECT GET_LOCK('enterprise-pricing-cutover',0) AS acquired");
  if (!lock.acquired) throw new Error('Another pricing migration is running.');
  try {
    await db.beginTransaction();
    const [[receipt]]=await db.query('SELECT * FROM enterprise_pricing_cutovers WHERE plan_hash=? FOR UPDATE',[hash]);
    if (!receipt || receipt.status!=='applied') throw new Error('No applied migration to roll back.');
    // Publication or later pricing edits make automatic rollback unsafe.
    const [[pub]]=await db.query('SELECT COUNT(*) AS total FROM enterprise_pricing_publications');
    const [[bundles]]=await db.query('SELECT COUNT(*) AS total FROM enterprise_bundle_publications');
    if (Number(pub.total) || Number(bundles.total)) throw new Error('Channel reviews/publications exist; automatic rollback is held.');
    const plan=JSON.parse(receipt.plan_json);
    const [columns]=await db.query('SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,DATA_TYPE AS dataType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
    const types=new Map(columns.map(c=>[`${c.tableName}.${c.columnName}`,c.dataType]));
    const expectedRevisions=plan.operations.filter(o=>o.table==='enterprise_pricing_revisions').length;
    const [[count]]=await db.query('SELECT COUNT(*) AS total FROM enterprise_pricing_revisions');
    if (Number(count.total)!==expectedRevisions) throw new Error('Pricing changed after migration; rollback is held.');
    for (const op of [...plan.operations].reverse()) {
      const [[current]]=await db.query(`SELECT * FROM \`${op.table}\` WHERE \`${op.key}\`=? FOR UPDATE`,[op.id]);
      if (op.after ? !current || Object.keys(op.after).some(k=>!databaseFieldEqual(current[k],op.after[k],types.get(`${op.table}.${k}`))) : !!current) throw new Error(`Record changed after migration: ${op.table} ${op.id}.`);
      if (op.kind==='insert') {
        const reference={vendors:'vendor_id',categories:'category_id',products:'product_id',packages:'package_id'}[op.table];
        if(reference){
          const [references]=await db.query('SELECT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME=?',[reference]);
          for(const row of references){
            if(!/^[a-z0-9_]+$/.test(row.name))throw new Error('Review unusual schema before rollback.');
            const [[count]]=await db.query(`SELECT COUNT(*) AS n FROM \`${row.name}\` WHERE \`${reference}\`=?`,[op.id]);
            if(Number(count.n))throw new Error(`A record still references ${op.table} ${op.id}; rollback held.`);
          }
        }
        await db.query(`DELETE FROM \`${op.table}\` WHERE \`${op.key}\`=?`,[op.id]);
      }
      else if(op.kind==='delete') await db.query(`INSERT INTO \`${op.table}\` SET ?`,[op.before]);
      else await db.query(`UPDATE \`${op.table}\` SET ? WHERE \`${op.key}\`=?`,[op.before,op.id]);
    }
    await db.query("UPDATE enterprise_pricing_cutovers SET status='rolled-back',rolled_back_at=UTC_TIMESTAMP() WHERE plan_hash=?",[hash]);
    await db.commit(); return {status:'rolled-back',hash};
  } catch(error){await db.rollback();throw error;} finally {await db.query("SELECT RELEASE_LOCK('enterprise-pricing-cutover')");}
}
