import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogReconciliationPlan,remoteEntryCents,mergeCatalogField,catalogHash} from './catalogReconciliationPlan.mjs';

function fixture(){
  const entry={id:90,price_list_id:3124,adjustment:true,adjustment_type:2,adjustment_value:'50'};
  const source={id:1,name:'Carrots',description:'Fresh',vendor:70,visible:true,track_inventory:true,inventory:4,packages:[{id:10,name:'Bunch',unit_price:'2.00',price_list_entries:[entry]}],product_price_list_entries:[{id:80}],images:[]};
  const tables={products:[{id:1,name:'Carrots',description:'Fresh',vendor_id:7,category_id:3,visible:1,track_inventory:1,inventory:4,stock_on_farm:1,stock_on_farm_lbs:'5.000',farm_stock_revision:2}],
    packages:[{id:10,product_id:1,name:'Bunch',price:'2.00',package_code:null}],vendors:[{id:7,name:'Farm'}],categories:[{id:3,name:'Produce'}],
    local_line_product_meta:[{product_id:1,local_line_product_id:1,raw_json:JSON.stringify({live:source})}],local_line_package_meta:[{package_id:10,local_line_package_id:10}],
    product_images:[],product_media:[],square_catalog_variations:[],square_variation_links:[]};
  return {local:{database:'csa_pricing_local_test',tables:structuredClone(tables)},baseline:{tables:structuredClone(tables)},remote:[structuredClone(source)],remoteVendors:[{id:70,name:'Farm'}],categoryData:{categories:[]},exportData:{availability:[{'Local Line Product ID':1}]},square:{objects:[]}};
}
test('remote observations calculate decimal-safe adjustments including zero and halfway cents',()=>{
  const p={unit_price:'11.20'};
  assert.equal(remoteEntryCents(p,{adjustment:true,adjustment_type:2,adjustment_value:'45'}),1624);
  assert.equal(remoteEntryCents({unit_price:'2.35'},{adjustment:true,adjustment_type:2,adjustment_value:'50'}),353);
  assert.equal(remoteEntryCents(p,{adjustment:true,adjustment_type:1,adjustment_value:'-1.20'}),1000);
  assert.equal(remoteEntryCents(p,{adjustment:true,adjustment_type:3,adjustment_value:'0'}),0);
  assert.equal(remoteEntryCents(p,{adjustment:false}),1120);
  assert.equal(remoteEntryCents(p,{adjustment:true,adjustment_type:2,adjustment_value:'-101'}),null);
  assert.equal(remoteEntryCents({},{adjustment:false}),null);
});
test('three-way merge preserves local edits and ignores equivalent HTML or numeric types',()=>{
  assert.equal(mergeCatalogField('Local edit','Original','Remote edit','name'),'conflict');
  assert.equal(mergeCatalogField('Original','Original','Remote edit','name'),'update');
  assert.equal(mergeCatalogField('Fresh & tasty','old','<p>Fresh &amp; tasty</p>','description'),'same');
  assert.equal(mergeCatalogField('1',0,1,'visible'),'same');
});
test('remote prices become observations without altering local Buy Price, package price or farm inventory',()=>{
  const f=fixture(),original=structuredClone(f.local);
  f.remote[0].packages[0].unit_price='3.00';f.remote[0].inventory=8;
  const p=catalogReconciliationPlan(f);
  assert.deepEqual(p.products[0].updates,{inventory:8});assert.equal(p.packages.length,0);
  assert.equal(p.priceChanges.length,2);assert.equal(p.channelPrices[0].currentCents,450);
  assert.deepEqual(f.local,original);
});
test('vendor resolution uses unique names rather than assuming IDs match',()=>{
  const f=fixture();f.local.tables.vendors.push({id:70,name:'Other farm'});
  assert.equal(catalogReconciliationPlan(f).newVendors.length,0);
  f.remoteVendors[0].name='New Farm';const p=catalogReconciliationPlan(f);
  assert.equal(p.newVendors[0].id,71);assert.equal(p.products[0].updates.vendor_id,71);
  f.local.tables.vendors.push({id:8,name:'New Farm'},{id:9,name:' new farm '});
  assert.ok(catalogReconciliationPlan(f).conflicts.some(c=>c.reason.includes('ambiguous remote vendor')));
});
test('package ownership conflicts never generate cached prices or package edits',()=>{
  const f=fixture();f.local.tables.packages[0].product_id=2;
  const p=catalogReconciliationPlan(f);assert.equal(p.channelPrices.length,0);assert.equal(p.packages.length,0);
  assert.ok(p.conflicts.some(c=>c.reason==='Package link conflict'));
});
test('new products require reviewed pricing and have no inferred enterprise inputs',()=>{
  const f=fixture();f.remote[0].id=2;f.remote[0].packages[0].id=20;
  const p=catalogReconciliationPlan(f);assert.equal(p.newProducts.length,1);
  assert.ok(p.conflicts.some(c=>c.reason.includes('reviewed Buy Price')));
  assert.equal(p.newProducts[0].values.stock_on_farm,undefined);
  assert.equal(p.newProducts[0].values.markupCategory,undefined);
});
test('local image uploads and thumbnails are preserved when remote images change',()=>{
  const f=fixture();f.remote[0].images=[{id:2,full:'https://example.com/new.jpg'}];f.remote[0].thumbnail='https://example.com/new-thumb.jpg';
  f.local.tables.product_media=[{product_id:1,source:'local-upload',public_url:'https://example.com/local.jpg'}];
  const p=catalogReconciliationPlan(f);assert.equal(p.images.length,0);
  assert.ok(p.products.every(p=>!('thumbnail_url' in p.updates)));
  assert.ok(p.conflicts.some(c=>c.reason.includes('images retained')));
});
test('catalog baseline fingerprint ignores SQL row order but detects edits',()=>{
  const a={products:[{id:1,name:'A'},{id:2,name:'B'}]},b=structuredClone(a);b.products.reverse();
  assert.equal(catalogHash(a),catalogHash(b));b.products[0].name='C';assert.notEqual(catalogHash(a),catalogHash(b));
});
