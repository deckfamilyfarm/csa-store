import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSale, discountPrice, buildPricingSalesReview } from './pricingSalesReview.mjs';
const pkg = () => ({ unit_price: 6.49, price_list_entries: [1,3,4].map(id => ({ price_list_id: id, adjustment: true, adjustment_type: 2, adjustment_value: 32.67, on_sale_toggle: true, strikethrough_display_value: 10.76 })) });
test('infers the Ground Pork sale from all three active baskets using exact cents', () => {
  const result = inspectSale(pkg(), [1,3,4]);
  assert.equal(result.discountPercent, 20);assert.equal(result.baskets[0].priceCents, 861);
  assert.equal(discountPrice(1080, 20), 864);
});
test('review compares bundle scenarios with sale prices per package and preserves vendor Buy Price', () => {
  const local = { tables: {
    products:[{id:1,name:'Pork'},{id:2,name:'Beef'}],packages:[{id:10,product_id:1},{id:20,product_id:2}],
    local_line_product_meta:[{product_id:1,local_line_product_id:100},{product_id:2,local_line_product_id:200}],
    local_line_package_meta:[{package_id:10,product_id:1,local_line_package_id:1000},{package_id:20,product_id:2,local_line_package_id:2000}],
    enterprise_pricing_revisions:[{product_id:1,output_json:JSON.stringify({packages:[{packageId:10,localLineRegularCents:1080}]})},{product_id:2,output_json:JSON.stringify({packages:[{packageId:20,localLineRegularCents:1260}]})}],
    square_variation_links:[],enterprise_bundles:[{id:8,remote_box_id:2260,input_json:JSON.stringify({name:'Beef & Pork',visible:true,buyPrice:'26.73',discountPercent:5,components:[{packageId:10,quantity:2},{packageId:20,quantity:2}]})}]
  }};
  const channels = {saleProductIds:[1],basketIds:[1,3,4],square:[],boxes:[],products:[{id:100,visible:true,packages:[{id:1000,...pkg()}]},
    {id:200,packages:[{id:2000,unit_price:12.60,price_list_entries:[1,3,4].map(id=>({price_list_id:id,adjustment:false,on_sale:false}))}]}]};
  const result = buildPricingSalesReview(local,channels);
  assert.equal(result.sales[0].proposedSaleCents,864);
  assert.equal(result.bundles[0].regularScenarioCents,4446);
  assert.equal(result.bundles[0].retainedSalesScenarioCents,4036);
  assert.equal(result.bundles[0].buyPrice,'26.73');
  channels.products[0].packages[0].price_list_entries[0].on_sale_toggle=false;
  assert.equal(buildPricingSalesReview(local,channels).bundles[0].retainedSalesScenarioCents,null);
});
test('does not invent a discount for missing, conflicting, inactive or inverted sales', () => {
  for (const change of [p => p.price_list_entries.pop(), p => p.price_list_entries[0].on_sale_toggle = false,
    p => p.price_list_entries.forEach(e => e.strikethrough_display_value = 8.12), p => p.price_list_entries.forEach(e => e.on_sale_toggle = false),
    p => p.price_list_entries.push(p.price_list_entries[0])]) {
    const p = pkg();change(p);const result = inspectSale(p, [1,3,4]);assert.equal(result.discountPercent, null);assert.ok(result.issue);
  }
});
