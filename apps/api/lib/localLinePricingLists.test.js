import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_LOCAL_LINE_BASKETS, activeLocalLinePriceListIds, validateActiveLocalLinePriceListIds, assertNoRetiredLocalLinePrices } from './localLinePricingLists.js';
import { getPriceListDefinitions } from './productPricing.js';
import { applyEnterpriseLocalLinePrices } from './enterprisePricingPublication.js';
import { localLineSalePatch } from './enterprisePromotionsCore.js';
import { compareLocalChannelPrices } from './enterprisePricingComparison.js';

test('CSA Members cannot be re-enabled by a lingering environment variable or frozen payload', () => {
  Object.assign(process.env, { LL_PRICE_LIST_GUEST_ID: '1', LL_PRICE_LIST_CSA_MEMBERS_ID: '2', LL_PRICE_LIST_HERDSHARE_ID: '3', LL_PRICE_LIST_SNAP_ID: '4' });
  assert.deepEqual(activeLocalLinePriceListIds(), [1,3,4]);
  assert.deepEqual(getPriceListDefinitions({guestMarkup:0,memberMarkup:0,herdShareMarkup:0,snapMarkup:0}).map(row=>row.id), [1,3,4]);
  assert.throws(()=>validateActiveLocalLinePriceListIds([1,2,4]), /three distinct/);
  assert.throws(()=>assertNoRetiredLocalLinePrices({packages:[{price_list_entries:[{price_list:2}]}]}), /retired/);
  assert.throws(()=>assertNoRetiredLocalLinePrices({product_price_list_entries:[{price_list:2}]}), /retired/);
  assert.doesNotThrow(()=>assertNoRetiredLocalLinePrices({set_inventory:5}));
  const payload={packages:[{id:20,name:'Deodorant',price_list_entries:[1,3,4].map(price_list=>({price_list,product_price_list_entry:price_list+100}))}]};
  const result=applyEnterpriseLocalLinePrices(payload,{packages:[{id:10}],packageMeta:[{packageId:10,localLinePackageId:20}]},{output:{packages:[{packageId:10,localLineRegularCents:1680}]}});
  assert.deepEqual(result.packages[0].price_list_entries.map(row=>row.price_list),[1,3,4]);
  assert(result.packages[0].price_list_entries.every(row=>row.adjustment_value===16.8));
  assert.throws(()=>applyEnterpriseLocalLinePrices({...payload,packages:[{...payload.packages[0],price_list_entries:payload.packages[0].price_list_entries.slice(0,2)}]},
    {packages:[{id:10}],packageMeta:[{packageId:10,localLinePackageId:20}]},{output:{packages:[{packageId:10,localLineRegularCents:1680}]}}), /three active/);
});
test('retired prices cannot cause comparison differences, and sales omit their mappings', () => {
  const record={packages:[{id:10,metadata:{localLinePackageId:20}}],squarePrices:[],localLinePrices:[...ACTIVE_LOCAL_LINE_BASKETS.map(list=>({listName:list.name,packageId:10,finalPrice:16.8})),{listName:'CSA Members',packageId:10,finalPrice:999}]};
  const comparison=compareLocalChannelPrices({input:{squareEnabled:false},output:{packages:[{packageId:10,localLineRegularCents:1680}]}},record);
  assert.equal(comparison.length,3);assert(comparison.every(row=>row.status==='matches'));
  const remote={vendor:1,packages:[{id:20,price_list_entries:[1,2,3,4].map(id=>({id:id+100,price_list:id}))},
    {id:21,unit_price:10,price_list_entries:[1,2,3,4].map(id=>({id:id+200,price_list:id,adjustment_type:3,adjustment_value:10}))}]};
  const patch=localLineSalePatch(remote,[{localLinePackageId:20,regularCents:1680,saleCents:1512}],[1,3,4],true);
  assert(patch.packages.every(pkg=>pkg.price_list_entries.every(entry=>entry.price_list!==2)));
});
