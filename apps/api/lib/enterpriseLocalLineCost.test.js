import test from 'node:test';
import assert from 'node:assert/strict';
import {enterprisePackageCostCents,requireEnterpriseCostPolicy,ENTERPRISE_LOCAL_LINE_COST_POLICY} from './enterpriseLocalLineCost.js';
import {calculateEnterprisePricing,DEFAULT_PRICING_SETTINGS} from './enterprisePricingEngine.js';
import {applyEnterpriseLocalLinePrices} from './enterprisePricingPublication.js';
import {priceOnlyLocalLinePayload} from './localLinePricePublication.js';
const input={pricingUnit:'each',buyFromPrice:'2.75',markupCategory:'shelfStable',squareEnabled:false,packages:[{packageId:1,quantity:1}]};
const remote={vendor:7,charge_type:'package',inventory:9,visible:true,packages:[{id:101,name:'1 bunch',unit_price:4.13,price_list_entries:[1,3,4].map(price_list=>({price_list,product_price_list_entry:price_list+10,adjustment:true,adjustment_type:3,adjustment_value:4.13}))}]};
const context={packages:[{id:1}],packageMeta:[{packageId:1,localLinePackageId:101}]};
test('Red Tail regression: ordinary and sale sync retain $2.75 Cost, retail $4.13, and correct vendor reporting',()=>{
 const output=calculateEnterprisePricing(input,DEFAULT_PRICING_SETTINGS);
 const regular=applyEnterpriseLocalLinePrices(remote,context,{output},[1,3,4],remote);
 assert.equal(regular.packages[0].unit_price,2.75);
 assert.ok(regular.packages[0].price_list_entries.every(e=>e.adjustment_value===4.13&&e.base_price_used===2.75));
 for(const discountBp of [0,2000]){
  const patch=priceOnlyLocalLinePayload(regular,remote,{discountBp},[1,3,4]);
  assert.equal(patch.packages[0].unit_price,2.75);
  assert.ok(patch.packages[0].price_list_entries.every(e=>e.adjustment_value===(discountBp?3.30:4.13)));
  assert.equal(patch.packages[0].unit_price*39,107.25,'39 bunches owe the vendor $107.25, not retail $161.07');
  assert.equal(patch.inventory,undefined);assert.equal(patch.visible,undefined);
 }
 assert.equal(remote.packages[0].unit_price,4.13,'building the correction does not mutate the server snapshot');
});
test('Cost conversion covers weighted packages, fixed each packs and explicit package-specific costs',()=>{
 for(const [changes,expected] of [
  [{pricingUnit:'lb',buyFromPrice:'5',packages:[{packageId:1,minWeight:3,maxWeight:5}]},2000],
  [{packages:[{packageId:1,quantity:5}]},1375],
  [{packages:[{packageId:1,quantity:5,packageBuyPrice:'5.00'}]},500],
  [{buyFromPrice:'4.25',packages:[{packageId:1,quantity:1}]},425]
 ])assert.equal(enterprisePackageCostCents(calculateEnterprisePricing({...input,...changes}),1),expected);
 assert.throws(()=>enterprisePackageCostCents({pricingUnit:'lb',buyFromTenThousandths:50000,packages:[{packageId:1}]},1),/missing/);
 const output=calculateEnterprisePricing(input);
 assert.throws(()=>applyEnterpriseLocalLinePrices(remote,context,{output},[1,3,4],{...remote,charge_type:'weight'}),/by weight/);
});
test('old queued enterprise approvals cannot replay retail into the vendor Cost field',()=>{
 const old={platform:'localline',enterpriseRevisionId:123};
 assert.throws(()=>requireEnterpriseCostPolicy(old),e=>e.hold&&/approve again/.test(e.message));
 requireEnterpriseCostPolicy({...old,enterpriseCostPolicy:ENTERPRISE_LOCAL_LINE_COST_POLICY});
 requireEnterpriseCostPolicy({platform:'square',enterpriseRevisionId:123});
 requireEnterpriseCostPolicy({platform:'localline'});
});
test('both publication entry points hold stale approvals before any external request',async t=>{
 const {inspectAction,executeAction}=await import('./productSyncAdapters.js');
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('Must not reach a channel');});
 const old={platform:'localline',enterpriseRevisionId:123,payload:{packages:[{unit_price:4.13}]}};
 await assert.rejects(inspectAction(old),e=>e.hold===true);
 await assert.rejects(executeAction(old,{},async()=>{}),e=>e.hold===true);
 assert.equal(calls,0);
});
