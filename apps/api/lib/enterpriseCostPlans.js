import { simpleCategoryCostPlan } from './simpleCategoryCostPlan.js';
import { simpleBeefCostPlan } from './simpleBeefCostPlan.js';
import { getPool } from '../db.js';
import { calculateCostPlan } from './enterpriseCostPlanEngine.js';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const producerFor=name=>/creamy cow/i.test(name)?'creamy-cow':/hyland/i.test(name)?'hyland':/deck family farm/i.test(name)?'deck':null;
let schema;
export function ensureCostPlans(){return schema??=(async()=>{
 const db=getPool();
 await db.query(`CREATE TABLE IF NOT EXISTS enterprise_cost_plans (id INT AUTO_INCREMENT PRIMARY KEY, seed_key VARCHAR(40) UNIQUE, name VARCHAR(255) NOT NULL, producer VARCHAR(32) NOT NULL, revision INT NOT NULL DEFAULT 1, input_json LONGTEXT NOT NULL, output_json LONGTEXT NOT NULL, edited_by INT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB`);
 await db.query(`CREATE TABLE IF NOT EXISTS enterprise_cost_plan_revisions (id INT AUTO_INCREMENT PRIMARY KEY, plan_id INT NOT NULL, revision INT NOT NULL, input_json LONGTEXT NOT NULL, output_json LONGTEXT NOT NULL, edited_by INT NULL, created_at DATETIME NOT NULL, UNIQUE KEY plan_revision(plan_id,revision)) ENGINE=InnoDB`);
 for(const [program,cogs] of [['Beef','8.51'],['Lamb','10.79'],['Pork','5.22']]){
  const input={name:`Deck ${program}`,producer:'deck',program,unit:'lb',quantity:'',cogs,targetMargin:'23',notes:'',model:program==='Beef'?'simple-beef':'simple-average',quantity:'100',groups:program==='Beef'?[{name:'Ground beef',share:'44',rows:[]},{name:'Other beef products',share:'56',rows:[]}]:[{name:program,share:'100',rows:[]}]};
  await db.query(`INSERT IGNORE INTO enterprise_cost_plans(seed_key,name,producer,input_json,output_json,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())`,[program,input.name,input.producer,JSON.stringify(input),JSON.stringify(calculateCostPlan(input))]);
 }
 await db.query(`INSERT IGNORE INTO enterprise_cost_plan_revisions(plan_id,revision,input_json,output_json,edited_by,created_at) SELECT id,revision,input_json,output_json,edited_by,updated_at FROM enterprise_cost_plans`);
})().catch(e=>{schema=null;throw e;});}
export async function costPlanCatalog(){
 const [products]=await getPool().query(`SELECT p.id,p.name,v.name vendor,c.name category,bp.price,bp.purchasing_enterprise_id costEnterprise,r.input_json,r.output_json FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN enterprise_pricing_buy_price_drafts bp ON bp.product_id=p.id LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id WHERE COALESCE(p.is_deleted,0)=0 AND NOT EXISTS(SELECT 1 FROM enterprise_bundle_legacy_products b WHERE b.product_id=p.id)`);
 const [packages]=await getPool().query('SELECT id,product_id,name,num_of_items FROM packages');
 return products.filter(p=>producerFor(p.vendor)&&!/deposit|membership/i.test(p.name)&&!/membership/i.test(p.category||'')).flatMap(p=>{
  const input=parse(p.input_json)||{},output=parse(p.output_json)||{};
  return packages.filter(k=>k.product_id===p.id).map(k=>{
   const pkg=input.packages?.find(x=>Number(x.packageId)===Number(k.id));
   const perLb=input.pricingUnit==='lb';const unitCost=p.price??(output.buyFromTenThousandths==null?null:Number(output.buyFromTenThousandths)/10000);
   const explicit=!perLb&&pkg?.packageBuyPrice!=null;
   const cost=explicit?Number(pkg.packageBuyPrice):unitCost==null?null:Number(unitCost)*(perLb?1:Number(pkg?.quantity??k.num_of_items??1));
   const mismatch=p.price!=null&&Number(p.costEnterprise)!==Number(input.retailEnterpriseId);
   return {productId:p.id,packageId:k.id,name:p.name,packageName:k.name,category:p.category,producer:producerFor(p.vendor),baseline:{cost:Number.isFinite(cost)&&cost!==null?cost.toFixed(4):null,basis:perLb?'lb':'package',enterpriseId:input.retailEnterpriseId,capturedAt:new Date().toISOString(),issue:mismatch?'Purchasing enterprise needs review.':!['lb','each'].includes(input.pricingUnit)?'Pricing unit is missing.':cost==null?'Cost is missing.':null}};
  });
 });
}
export async function previewSimpleCategory(input,base=null){
 return prepareCostPlan(simpleCategoryCostPlan(input,await costPlanCatalog()),base);
}
export async function previewSimpleBeef(input,base=null){
 const draft=simpleBeefCostPlan(input,await costPlanCatalog());
 return prepareCostPlan(draft,base);
}
export async function listCostPlans(){await ensureCostPlans();const [rows]=await getPool().query('SELECT id,name,producer,revision,updated_at FROM enterprise_cost_plans ORDER BY name');return rows;}
export async function readCostPlan(id){await ensureCostPlans();const [rows]=await getPool().query('SELECT * FROM enterprise_cost_plans WHERE id=?',[id]);if(!rows.length)fail('Plan not found.',404);const r=rows[0];return {id:r.id,revision:r.revision,input:parse(r.input_json),output:parse(r.output_json)};}
export async function prepareCostPlan(input,base=null,refresh=false){
 if(!input||!String(input.name||'').trim()||String(input.name).length>255)fail('Enter a plan name (up to 255 characters).');
 if(!['deck','hyland','creamy-cow'].includes(input.producer))fail('Choose a producer.');
 if(!['lb','gallon','each'].includes(input.unit))fail('Choose an analysis unit.');
 if(input.model==='simple-average'&&input.groups?.length!==1)fail('Category average requires one product group.');
 if(input.model==='simple-beef'&&(input.producer!=='deck'||input.unit!=='lb'||input.groups?.length!==2))fail('Simple beef plans require Deck, pounds, and two groups.');
 if(!Array.isArray(input.groups)||input.groups.length>100)fail('Invalid groups.');
 const catalog=await costPlanCatalog(), old=(base?.groups||[]).flatMap(g=>g.rows||[]),changes=[];
 const draft={...input,groups:input.groups.map(g=>{
  if(!Array.isArray(g.rows)||g.rows.length>250)fail('Invalid product rows.');
  return {...g,rows:g.rows.map(r=>{
   const same=x=>Number(x.productId)===Number(r.productId)&&Number(x.packageId)===Number(r.packageId);
   const current=catalog.find(same), previous=old.find(same);
   if(current&&current.producer!==input.producer)fail('All products must belong to the plan producer.');
   if(previous&&base.producer!==input.producer)fail('Remove product rows before changing producer.');
   if(!current&&!previous)fail('Product/package is not available for this plan.');
   const baseline=(!refresh&&previous?previous.baseline:current?.baseline)||{...previous.baseline,issue:'Product/package is no longer available.'};
   if(refresh&&previous&&JSON.stringify([baseline.cost,baseline.basis,baseline.issue])!==JSON.stringify([previous.baseline.cost,previous.baseline.basis,previous.baseline.issue]))changes.push({name:current?.name||r.name,before:previous.baseline,after:baseline});
   return {...r,name:current?.name||previous.name,packageName:current?.packageName||previous.packageName,baseline,proposed:refresh&&previous&&previous.baseline?.basis!==baseline.basis?'':r.proposed,conversion:refresh&&previous&&previous.baseline?.basis!==baseline.basis?'':r.conversion};
  })};
 })};
 return {input:draft,output:calculateCostPlan(draft),changes};
}
export async function saveCostPlan(id,body,user,source=null){
 await ensureCostPlans();const base=id?await readCostPlan(id):null;
 const prepared=await prepareCostPlan(body.input,base?.input||source,body.refresh===true);
 if(body.refresh===true){
 const incoming=body.input.groups.flatMap(g=>g.rows);
 for(const r of prepared.input.groups.flatMap(g=>g.rows)){
  const seen=incoming.find(x=>Number(x.productId)===Number(r.productId)&&Number(x.packageId)===Number(r.packageId));
  if(JSON.stringify([seen?.baseline?.cost,seen?.baseline?.basis,seen?.baseline?.issue])!==JSON.stringify([r.baseline?.cost,r.baseline?.basis,r.baseline?.issue]))fail('Pricing Costs changed since the refresh preview. Refresh and review again.',409);
 }
 }
 const db=await getPool().getConnection();try{await db.beginTransaction();let revision=1;
 if(id){const [rows]=await db.query('SELECT revision FROM enterprise_cost_plans WHERE id=? FOR UPDATE',[id]);if(!rows.length||rows[0].revision!==body.expectedRevision||base.revision!==body.expectedRevision)fail('Plan changed. Reload and review before saving.',409);revision=base.revision+1;}
 const args=[prepared.input.name,prepared.input.producer,revision,JSON.stringify(prepared.input),JSON.stringify(prepared.output),user.userId||user.adminId];
 if(id)await db.query('UPDATE enterprise_cost_plans SET name=?,producer=?,revision=?,input_json=?,output_json=?,edited_by=?,updated_at=UTC_TIMESTAMP() WHERE id=?',[...args,id]);
 else {const [r]=await db.query('INSERT INTO enterprise_cost_plans(name,producer,revision,input_json,output_json,edited_by,updated_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())',args);id=r.insertId;}
 await db.query('INSERT INTO enterprise_cost_plan_revisions(plan_id,revision,input_json,output_json,edited_by,created_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())',[id,revision,args[3],args[4],args[5]]);
 await db.commit();return {id,revision,...prepared};
 }catch(e){await db.rollback();throw e;}finally{db.release();}
}
