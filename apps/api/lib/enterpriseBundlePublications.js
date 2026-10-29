import {getPool} from '../db.js';
import {getLocalLineBaseUrl,getLocalLineAccessToken} from '../localLineAuth.js';
import {getBundle} from './enterpriseBundles.js';
import {getPricingSettings} from './enterprisePricingService.js';
import {matchLocalLineVendor} from './productVendor.js';
import {bundleRemoteState,prepareBundlePatch,componentPriceCents,assertBundlePilotAllowed} from './enterpriseBundlePublicationCore.js';
import {digest} from './pricingCutover.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const actor=user=>Number(user?.userId??user?.id);
const lists=()=>['LL_PRICE_LIST_GUEST_ID','LL_PRICE_LIST_CSA_MEMBERS_ID','LL_PRICE_LIST_HERDSHARE_ID','LL_PRICE_LIST_SNAP_ID'].map(k=>Number(process.env[k]));
async function request(path,body){
  if(process.env.CSA_LOCAL_ONLY==='true')fail('Channel access is disabled in isolated local mode.',403);
  const base=new URL(getLocalLineBaseUrl()),url=new URL(path,base);
  if(url.origin!==base.origin)fail('Unexpected Local Line endpoint.');
  const token=await getLocalLineAccessToken();
  const response=await fetch(url,{method:body?'PATCH':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':body?'application/json-patch+json':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error(`Local Line bundle request failed (${response.status}).`);
  return response.json();
}
async function remoteVendors(){const result=[];let page='vendors/';while(page){const data=await request(page);result.push(...(Array.isArray(data)?data:data.results||[]));page=Array.isArray(data)?null:data.next;}return result;}
async function inspect(id){
 const bundle=await getBundle(id),db=getPool();
 const [[vendor]]=await db.query('SELECT id,name FROM vendors WHERE id=?',[bundle.input.vendorId]);
 const remoteVendor=matchLocalLineVendor({vendorId:bundle.input.vendorId},vendor,await remoteVendors());
 const components=[];
 for(const c of bundle.output.components){
  const [rows]=await db.query('SELECT m.local_line_package_id AS packageId,p.local_line_product_id AS productId FROM local_line_package_meta m JOIN local_line_product_meta p ON p.product_id=m.product_id WHERE m.package_id=?',[c.packageId]);
  if(rows.length!==1||!rows[0].packageId||!rows[0].productId)fail(`${c.name} needs a Local Line mapping.`);
  components.push({name:c.name,packageId:c.packageId,remotePackageId:Number(rows[0].packageId),remoteProductId:Number(rows[0].productId),quantity:c.quantity,priceCents:c.priceCents,
    promotion:c.promotionId?{id:c.promotionId,regularCents:c.promotionRegularCents,saleCents:c.priceCents}:null});
 }
 const remote=await request(`boxes/${bundle.remoteBoxId}/`);
 const prepared=prepareBundlePatch(bundle,remote,lists(),remoteVendor,components);
 await checkComponents(components);
 return {bundle,remote,snapshot:{...prepared,components,remoteBoxId:bundle.remoteBoxId,revision:bundle.revision,pricingHash:bundle.pricingHash,settingsVersionId:(await getPricingSettings()).id,listIds:lists()}};
}
async function checkComponents(components){
 const products=new Map();
 for(const c of components){
  if(!products.has(c.remoteProductId))products.set(c.remoteProductId,await request(`products/${c.remoteProductId}/?expand=packages,product_price_list_entries`));
  const pkg=products.get(c.remoteProductId)?.packages?.find(p=>Number(p.id)===c.remotePackageId);
  if(!pkg)fail('A bundle component package is missing from Local Line.');
  for(const id of lists()){
   const entries=(pkg.price_list_entries||[]).filter(e=>Number(e.price_list_id??e.price_list)===id);
   if(entries.length!==1||componentPriceCents(pkg,entries[0],c.promotion)!==c.priceCents)fail('Sync individual component prices to all four Local Line baskets before publishing the bundle discount.');
  }
 }
}
export async function reviewBundlePublication(id,user){
 const db=getPool();await getBundle(id);
 const [pending]=await db.query("SELECT id FROM enterprise_bundle_publications WHERE bundle_id=? AND status IN ('publishing','uncertain') ORDER BY id DESC LIMIT 1",[id]);
 if(pending.length)fail(`Verify existing bundle publication ${pending[0].id} before starting another review.`);
 const {bundle,snapshot}=await inspect(id);
 const [result]=await db.query("INSERT INTO enterprise_bundle_publications (bundle_id,status,snapshot_json,editor_id,created_at) VALUES (?,'reviewed',?,?,UTC_TIMESTAMP())",[id,JSON.stringify(snapshot),bundle.editedBy]);
 return getBundlePublication(result.insertId);
}
export async function getBundlePublication(id){const [[row]]=await getPool().query('SELECT * FROM enterprise_bundle_publications WHERE id=?',[id]);if(!row)fail('Bundle publication was not found.',404);return {...row,snapshot:JSON.parse(row.snapshot_json),snapshot_json:undefined};}
export async function publishBundle(id,user){
 const db=await getPool().getConnection();
 try{
  const [[lock]]=await db.query("SELECT GET_LOCK('enterprise-bundle-publication',0) AS acquired");if(!lock.acquired)fail('Another bundle publication is running.');
  const row=await getBundlePublication(id),saved=row.snapshot;
  if(row.status==='verified')return row;
  const settings=await getPricingSettings();
  if(settings.requireDifferentApprover&&actor(user)===Number(row.editor_id))fail('A different publisher must approve this bundle.',403);
  if(!['reviewed','publishing','uncertain'].includes(row.status))fail('Review this bundle again.');
  const bundle=await getBundle(row.bundle_id);
  const liveRemote=await request(`boxes/${saved.remoteBoxId}/`);
  const live=bundleRemoteState(liveRemote);
  if(row.attempted_at&&digest(live)===digest(saved.expected)){
    await db.query("UPDATE enterprise_bundle_publications SET status='verified',verified_at=UTC_TIMESTAMP(),last_error=NULL WHERE id=?",[id]);
    await db.query('UPDATE enterprise_bundles SET source_json=?,remote_captured_at=UTC_TIMESTAMP() WHERE id=?',[JSON.stringify(liveRemote),row.bundle_id]);
    return getBundlePublication(id);
  }
  if(bundle.revision!==saved.revision||bundle.pricingHash!==saved.pricingHash||settings.id!==saved.settingsVersionId||digest(lists())!==digest(saved.listIds))fail('Bundle, components or pricing settings changed after review.');
  if(digest(live)!==digest(saved.before))fail('Local Line changed after review. Check the bundle again.');
  const fresh=await inspect(row.bundle_id);
  if(digest(fresh.snapshot.components)!==digest(saved.components)||digest(fresh.snapshot.expected)!==digest(saved.expected))fail('Component mappings or vendor changed after review.');
  assertBundlePilotAllowed(saved.remoteBoxId);
  await db.query("UPDATE enterprise_bundle_publications SET status='publishing',approver_id=?,approved_at=COALESCE(approved_at,UTC_TIMESTAMP()),attempted_at=UTC_TIMESTAMP(),last_error=NULL WHERE id=?",[actor(user),id]);
  try{
    await request(`boxes/${saved.remoteBoxId}/`,saved.patch);
    const after=await request(`boxes/${saved.remoteBoxId}/`);
    if(digest(bundleRemoteState(after))!==digest(saved.expected))throw new Error('Local Line did not confirm the complete bundle update.');
    await db.query("UPDATE enterprise_bundle_publications SET status='verified',verified_at=UTC_TIMESTAMP() WHERE id=?",[id]);
    await db.query('UPDATE enterprise_bundles SET source_json=?,remote_captured_at=UTC_TIMESTAMP() WHERE id=?',[JSON.stringify(after),row.bundle_id]);
  }catch(error){await db.query("UPDATE enterprise_bundle_publications SET status='uncertain',last_error=? WHERE id=?",[error.message,id]);throw error;}
  return getBundlePublication(id);
 }finally{await db.query("SELECT RELEASE_LOCK('enterprise-bundle-publication')").catch(()=>{});db.release();}
}
