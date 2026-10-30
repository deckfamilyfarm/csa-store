import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLocalLinePriceScope,priceOnlyLocalLinePayload,LOCAL_LINE_PRICE_SCOPE} from './localLinePricePublication.js';
test('Local Line-only scope cannot authorize Square, incoming, staging, or unapproved legacy prices',()=>{
  const options={publicationScope:LOCAL_LINE_PRICE_SCOPE,platforms:['localline'],enterpriseRevisionId:1};
  assert.equal(validateLocalLinePriceScope(options),true);
  for(const change of [{platforms:['localline','square']},{platforms:['square']},{incoming:true},{staged:{1:{onSale:true}}},{enterpriseRevisionId:null}])
    assert.throws(()=>validateLocalLinePriceScope({...options,...change}));
});
test('price-only update uses each package price, supports ending sales, and preserves channel limits without inventory/catalog fields',()=>{
  const remote={vendor:7,inventory:17,visible:false,description:'Remote',packages:[{id:20,name:'Channel package',unit_price:4,
    price_list_entries:[1,3,4].map(price_list=>({price_list,product_price_list_entry:price_list+100,max_units_per_order:5}))}]};
  const regular={vendor:7,description:'Local',inventory:99,packages:[{id:20,name:'Local',unit_price:7.25,inventory_per_unit:1}]};
  const result=priceOnlyLocalLinePayload(regular,remote,{discountBp:500},[1,3,4]);
  assert.deepEqual(Object.keys(result).sort(),['packages','vendor']);
  assert.deepEqual(Object.keys(result.packages[0]).sort(),['id','name','price_list_entries','unit_price']);
  assert.equal(result.packages[0].name,'Channel package');
  for(const row of result.packages[0].price_list_entries){assert.equal(row.adjustment_value,6.89);assert.equal(row.strikethrough_display_value,7.25);assert.equal(row.on_sale_toggle,true);assert.equal(row.max_units_per_order,5);}
  const ended=priceOnlyLocalLinePayload(regular,remote,{discountBp:0},[1,3,4]);
  assert.ok(ended.packages[0].price_list_entries.every(e=>e.adjustment_value===7.25&&e.strikethrough_display_value===null&&e.on_sale_toggle===false));
  assert.throws(()=>priceOnlyLocalLinePayload(regular,{...remote,packages:[]},{discountBp:0},[1,3,4]),/package definitions/);
  remote.packages[0].price_list_entries.pop();
  assert.equal(priceOnlyLocalLinePayload(regular,remote,{discountBp:0},[1,3,4]).packages[0].price_list_entries.length,2);
  remote.packages[0].price_list_entries=[];
  assert.throws(()=>priceOnlyLocalLinePayload(regular,remote,{discountBp:0},[1,3,4]),/valid active/);
});
