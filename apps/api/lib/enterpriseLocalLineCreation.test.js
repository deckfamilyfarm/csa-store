import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enterpriseLocalLineCreation} from './enterpriseLocalLineCreation.js';
test('new each and weighted products create with vendor Cost, distinct retail and explicit eligible baskets',()=>{
 // The public builder takes a frozen pricing snapshot, not legacy source multipliers.
 Object.assign(process.env,{LL_PRICE_LIST_GUEST_ID:'1',LL_PRICE_LIST_HERDSHARE_ID:'3',LL_PRICE_LIST_SNAP_ID:'4'});
 const units=[{id:1,unit_type:'item',name:'each'},{id:2,unit_type:'weight',name:'pound'}];
 for(const pricingUnit of ['lb','each']){
  const context={product:{name:'Test product',visible:true,trackInventory:true,excludeFromGuest:true},localLineVendorId:17,
   packages:[{id:10,name:'Small'},{id:20,name:'Large'}]};
  const revision={output:{pricingUnit,buyFromTenThousandths:50000,packages:[{packageId:10,quantity:2,averageWeightMilliPounds:2000,localLineRegularCents:1665},{packageId:20,quantity:3,averageWeightMilliPounds:3000,localLineRegularCents:2498}]}};
  const {createPayload,payload}=enterpriseLocalLineCreation(context,revision,units);
  assert.equal(createPayload.vendor,17);assert.equal(createPayload.set_inventory,0);
  assert.equal(createPayload.visible,false);assert.equal(payload.visible,true);
  assert.equal(createPayload.packages[0].unit_price,10);assert.equal(createPayload.packages[1].unit_price,15);
  assert.equal(payload.packages[0].unit_price,10);assert.equal(payload.packages[0].price_list_entries[0].adjustment_value,16.65);
  assert.deepEqual(createPayload.product_price_list_entries.map(e=>e.price_list),[3,4]);
  assert.equal(createPayload.base_unit_id,pricingUnit==='lb'?2:1);
  context.packages[1].name='Small';assert.throws(()=>enterpriseLocalLineCreation(context,revision,units),/distinct name/);
 }
});
