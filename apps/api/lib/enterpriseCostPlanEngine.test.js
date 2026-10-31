import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCostPlan} from './enterpriseCostPlanEngine.js';
const row=(id,cost,share='100')=>({productId:id,packageId:id,name:`Product ${id}`,share,baseline:{cost,basis:'lb'}});
const plan=(cogs='8.51')=>({unit:'lb',quantity:'100',cogs,targetMargin:'23',groups:[{name:'All',share:'100',rows:[row(1,'12')]}]});
test('23 percent is margin on revenue, not markup on cost',()=>{
 for(const [cost,target] of [['8.51','11.05'],['10.79','14.01'],['5.22','6.78']]){const r=calculateCostPlan(plan(cost));assert.equal(r.complete,true);assert.equal(r.requiredUnit.toFixed(2),target);}
});
test('nested cut mix weights producer revenue, not product margins',()=>{
 const p=plan();p.groups=[{name:'Ground',share:'45',rows:[row(1,'8')]},{name:'Cuts',share:'55',rows:[row(2,'20','25'),row(3,'12','75')]}];const r=calculateCostPlan(p);
 assert.equal(r.current.revenue,1130);assert.equal(r.cost,851);assert.equal(r.groups[1].rows[0].quantity,13.75);assert.ok(Math.abs(r.current.margin-279/1130*100)<1e-8);
});
test('package conversions and group finished-product COGS',()=>{
 const p=plan();p.groups[0].cogs='10';p.groups[0].rows=[{...row(1,'9'),baseline:{cost:'9',basis:'package'},conversion:'0.750',proposed:'10.50'}];const r=calculateCostPlan(p);assert.equal(r.complete,true);assert.equal(r.current.revenue,1200);assert.equal(r.proposed.revenue,1400);assert.equal(r.cost,1000);
});
test('incomplete mixes and missing costs cannot meet target',()=>{
 const p=plan();p.groups[0].share='45';p.groups[0].rows[0].share='50';p.groups[0].rows[0].baseline.cost=null;
 const r=calculateCostPlan(p);assert.equal(r.complete,false);assert.ok(r.issues.some(s=>s.includes('45%')));assert.ok(r.issues.some(s=>s.includes('50%')));assert.ok(r.issues.some(s=>s.includes('Cost')));
});
test('no guessed conversions and no duplicate packages',()=>{
 const p=plan();p.groups[0].rows[0].baseline.basis='package';p.groups[0].rows.push({...p.groups[0].rows[0]});const r=calculateCostPlan(p);assert.equal(r.complete,false);assert.ok(r.issues.some(s=>s.includes('once')));assert.ok(r.issues.some(s=>s.includes('enter lb per package')));
});
test('negative margin and zero proposed revenue stay meaningful',()=>{
 const p=plan();p.groups[0].rows[0].baseline.cost='5';p.groups[0].rows[0].proposed='0';const r=calculateCostPlan(p);assert.equal(r.complete,true);assert.equal(r.current.profit,-351);assert.equal(r.proposed.margin,null);assert.equal(r.proposed.profit,-851);
});
test('preview is immutable and invalid targets remain incomplete',()=>{
 const p=plan();p.targetMargin='100';const before=JSON.stringify(p);const r=calculateCostPlan(p);assert.equal(JSON.stringify(p),before);assert.equal(r.complete,false);assert.equal(r.requiredRevenue,null);
});
test('gallon and each analyses require explicit packaged conversions',()=>{
 for(const unit of ['gallon','each']){const p=plan('2');p.unit=unit;p.groups[0].rows=[{...row(1,'4'),baseline:{cost:'4',basis:'package'},conversion:'0.5'}];assert.equal(calculateCostPlan(p).current.unitCharge,8);}
});

test('simple beef averages both grounds at 44 percent and all other products at 56 percent',()=>{
 const p={...plan(),producer:'deck',model:'simple-beef',groups:[{name:'Ground',share:'99',rows:[row(1,'8'),row(2,'10')]},{name:'Other',share:'1',rows:[row(3,'12'),row(4,'15'),row(5,'18')]}]};
 const r=calculateCostPlan(p);assert.equal(r.complete,true);assert.equal(r.groups[0].averageUnit,9);assert.equal(r.groups[1].averageUnit,15);assert.equal(r.current.revenue,1236);assert.equal(r.current.unitCharge,12.36);assert.equal(r.groups[0].quantity,44);assert.equal(r.groups[1].quantity,56);
 assert.ok(Math.abs(r.current.margin-(1236-851)/1236*100)<1e-8);
 p.groups[0].proposedAverage='10';p.groups[1].proposedAverage='16';const next=calculateCostPlan(p);assert.equal(next.current.revenue,1236);assert.equal(next.proposed.revenue,1336);assert.ok(next.proposedRequiredOtherUnit<next.requiredOtherUnit);
});
test('simple beef requires priced products and explicit package weights, rejects duplicate products',()=>{
 const p={...plan(),producer:'deck',model:'simple-beef',groups:[{name:'Ground',rows:[row(1,'8')]},{name:'Other',rows:[{...row(2,'12'),baseline:{cost:'12',basis:'package'}}]}]};
 assert.equal(calculateCostPlan(p).complete,false);p.groups[1].rows[0].conversion='0.750';assert.equal(calculateCostPlan(p).groups[1].averageUnit,16);assert.equal(calculateCostPlan(p).complete,true);
 p.groups[1].rows.push({...row(2,'15'),packageId:99});assert.equal(calculateCostPlan(p).complete,false);
});
test('simple beef catalog selection averages both grounds, de-duplicates packages and excludes other producers',async()=>{
 const {simpleBeefCostPlan}=await import('./simpleBeefCostPlan.js');
 const catalog=[{productId:1,packageId:1,name:'Natural Ground Beef',producer:'deck',category:'Beef'},{productId:2,packageId:2,name:'Organic Ground Beef',producer:'deck',category:'Beef'},{productId:3,packageId:3,name:'Ribeye',producer:'deck',category:'Grass-fed Beef'},{productId:3,packageId:4,name:'Ribeye',producer:'deck',category:'Grass-fed Beef'},{productId:4,packageId:5,name:'Beef Sausage',producer:'hyland',category:'Beef'}];
 const r=simpleBeefCostPlan(plan(),catalog);assert.equal(r.groups[0].rows.length,2);assert.equal(r.groups[1].rows.length,1);assert.equal(r.groups[1].rows[0].packageId,3);
});

test('every producer can use a category average with a single proposed average',()=>{
 for(const producer of ['deck','hyland','creamy-cow']){
  const p={...plan('5'),producer,model:'simple-average',proposedAverage:'12',groups:[{name:'Category',share:'100',rows:[row(1,'6'),row(2,'9'),row(3,'12')]}]};
  const result=calculateCostPlan(p);assert.equal(result.complete,true);assert.equal(result.current.unitCharge,9);assert.equal(result.proposed.unitCharge,12);assert.equal(result.current.revenue,900);assert.equal(result.proposed.revenue,1200);
 }
});
test('category selection stays within the exact producer and category',async()=>{
 const {simpleCategoryCostPlan}=await import('./simpleCategoryCostPlan.js');
 const catalog=[{productId:1,packageId:1,name:'Cheese',producer:'creamy-cow',category:'Dairy'},{productId:1,packageId:2,name:'Cheese',producer:'creamy-cow',category:'Dairy'},{productId:2,packageId:3,name:'Milk',producer:'creamy-cow',category:'Dairy'},{productId:3,packageId:4,name:'Yogurt',producer:'deck',category:'Dairy'},{productId:4,packageId:5,name:'Butter',producer:'creamy-cow',category:'Other'}];
 const result=simpleCategoryCostPlan({...plan(),producer:'creamy-cow',category:'Dairy'},catalog);assert.equal(result.model,'simple-average');assert.equal(result.groups.length,1);assert.deepEqual(result.groups[0].rows.map(r=>r.productId).sort(),[1,2]);
 const empty=simpleCategoryCostPlan({...plan(),producer:'hyland',category:'Missing'},catalog);assert.equal(calculateCostPlan(empty).complete,false);
});

test('fixed package weights convert pounds and ounces without guessing ambiguous labels',async()=>{
 const {fixedPackagePounds}=await import('./enterpriseCostPlanEngine.js');
 for(const [label,pounds] of [['1 lbs','1.0000'],['3 oz','0.1875'],['12 oz ea','0.7500'],['.5 lb','0.5000']])assert.equal(fixedPackagePounds(label),pounds);
 for(const label of ['2-3 lbs','2 Pack','16 fl oz','1 lb each x 2','about 1 lb','0 lb'])assert.equal(fixedPackagePounds(label),null);
 const p={...plan(),model:'simple-average'};p.groups[0].rows=[{...row(1,'3'),baseline:{cost:'3',basis:'package',packageWeightLb:'0.1875'}}];
 const r=calculateCostPlan(p);assert.equal(r.complete,true);assert.equal(r.comparison.average,16);
 p.groups[0].rows[0].conversion='0.5';assert.equal(calculateCostPlan(p).comparison.average,6);
});
test('comparison uses actual Costs, preserves the beef mix and labels incomplete estimates',()=>{
 const p={...plan(),producer:'deck',model:'simple-beef',proposedAverage:'99',groups:[{name:'Ground',rows:[{...row(1,'6.49'),baseline:{cost:'6.49',basis:'package',packageWeightLb:'1.0000'}},row(2,'7.58')]},{name:'Other',rows:[row(3,'12'),row(4,null)]}]};
 const c=calculateCostPlan(p).comparison;
 assert.equal(c.average,9.8154);assert.equal(c.requiredUnit,11.0519);assert.equal(c.available,true);assert.equal(c.estimated,true);assert.equal(c.included,3);assert.equal(c.total,4);assert.equal(c.omitted[0].productId,4);
 assert.equal(c.gapPerUnit,-1.2365);assert.ok(Math.abs(c.margin-(9.8154-8.51)/9.8154*100)<1e-8);
 p.groups[0].rows=[];const missing=calculateCostPlan(p).comparison;assert.equal(missing.available,false);assert.equal(missing.average,null);assert.equal(missing.requiredUnit,11.0519);
});
test('target remains available with no product Costs; zero and losses remain valid',()=>{
 const p={...plan(),model:'simple-average'};p.groups[0].rows=[];let c=calculateCostPlan(p).comparison;assert.equal(c.requiredUnit,11.0519);assert.equal(c.average,null);
 p.groups[0].rows=[row(1,'0')];c=calculateCostPlan(p).comparison;assert.equal(c.available,true);assert.equal(c.average,0);assert.equal(c.margin,null);
 p.groups[0].rows=[row(1,'5')];c=calculateCostPlan(p).comparison;assert.ok(c.margin<0);
 p.cogs='';assert.equal(calculateCostPlan(p).comparison.requiredUnit,null);
 p.cogs='8.51';p.targetMargin='100';assert.equal(calculateCostPlan(p).comparison.requiredUnit,null);
});
