import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBundle, calculateBundle, observedBundlePrices } from './enterpriseBundlesCore.js';
const input = () => normalizeBundle({ name:'Ground Beef & Pork',description:'',vendorId:1,buyPrice:'26.73',discountPercent:5,visible:true,
  images:[],inventoryMode:'separate',stock:0,components:[{packageId:10,quantity:2},{packageId:20,quantity:2}] });
const catalog = () => [{packageId:10,productId:1,name:'Pork',packageName:'1 lb',priceCents:1080,revisionId:1},
  {packageId:20,productId:2,name:'Beef',packageName:'1 lb',priceCents:1260,revisionId:2}];
test('bundle uses component selling prices and leaves vendor Buy Price intact',()=>{
 const source=input(),before=structuredClone(source),out=calculateBundle(source,catalog());
 assert.equal(out.subtotalCents,4680);assert.equal(out.priceCents,4446);assert.equal(out.buyPriceCents,2673);
 assert.deepEqual(Object.values(out.baskets),[4446,4446,4446,4446]);assert.deepEqual(source,before);
});
test('price and membership savings recalculate when a component changes',()=>{
 const rows=catalog();rows[0].priceCents=1000;assert.equal(calculateBundle(input(),rows).priceCents,4294);
});
test('weighted components use the FF package price exactly once and round the final total',()=>{
 const draft=input();draft.components=[{packageId:10,quantity:1}];
 const out=calculateBundle(draft,[{packageId:10,name:'Roast',priceCents:3601}]);
 assert.equal(out.priceCents,3421);assert.equal(out.savingsCents,180);
});
test('missing or blocked ingredients hold the whole bundle instead of pricing a partial recipe',()=>{
 assert.equal(calculateBundle(input(),catalog().slice(0,1)).priceCents,null);
 const rows=catalog();rows[0].blocker='Pork pricing needs approval';
 assert.deepEqual(calculateBundle(input(),rows).blockers,['Pork pricing needs approval']);
});
test('invalid quantities, duplicate components, unsafe images and invalid discounts are rejected',()=>{
 for(const patch of [{discountPercent:100},{discountPercent:-1},{components:[]},{components:[{packageId:10,quantity:1.5}]},
  {components:[{packageId:10,quantity:1},{packageId:10,quantity:2}]},{images:['javascript:alert(1)']},{inventoryMode:'separate',stock:null},{visible:'false'}])
  assert.throws(()=>normalizeBundle({...input(),...patch}));
});
test('shared product stock is allocated across all its packages; unknown stock stays unknown',()=>{
 const draft=input();draft.inventoryMode='components';const rows=catalog().map(row=>({...row,stockResource:'product:1',availableStock:10}));
 assert.equal(calculateBundle(draft,rows).availableBundles,2);
 delete rows[0].stockResource;assert.equal(calculateBundle(draft,rows).availableBundles,null);
 draft.inventoryMode='separate';draft.stock=7;assert.equal(calculateBundle(draft,rows).availableBundles,7);
});
test('remote box adjustments are observations, independent of local bundle discount',()=>{
 const source={price:26.73,product_price_list_entries:[{price_list:1,price_list_name:'Members',box_package_entry:{adjustment:true,adjustment_type:2,adjustment_value:55}}]};
 assert.equal(observedBundlePrices(source)[0].priceCents,4143);
 assert.equal(calculateBundle(input(),catalog()).priceCents,4446);
});
