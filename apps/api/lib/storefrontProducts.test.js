import assert from 'node:assert/strict';
import test from 'node:test';
import { storefrontRetailPrice } from './storefrontProducts.js';

test('turkeys use Products retail per bird, without CSA pricing factors or markups', () => {
  assert.deepEqual(storefrontRetailPrice({ vendor: 'Deck Family Farm', source_unit_price: '115.00', unit_of_measure: 'each',
    source_multiplier: 0.5412, guest_markup: 0.6574 }), { retailPriceCents: 11500, priceError: '' });
  assert.equal(storefrontRetailPrice({ vendor: 'Hyland', source_unit_price: '123.45', unit_of_measure: 'ea' }).retailPriceCents, 12345);
});
test('per-pound or missing retail prices cannot become whole-bird charges', () => {
  for (const source_unit_price of [null, '', 0, '-1', 'not a price']) {
    assert.equal(storefrontRetailPrice({ vendor: 'Deck Family Farm', unit_of_measure: 'each', source_unit_price }).retailPriceCents, null);
  }
  assert.equal(storefrontRetailPrice({ vendor: 'Deck Family Farm', unit_of_measure: 'lbs', source_unit_price: 8 }).retailPriceCents, null);
});
test('standard products require a single package with a price for one turkey', () => {
  const product = { vendor: 'Another farm' };
  const pkg = { price: '120.00', charge_type: 'package', num_of_items: 1, visible: 1 };
  assert.equal(storefrontRetailPrice(product, [pkg]).retailPriceCents, 12000);
  for (const packages of [[], [pkg,pkg], [{...pkg,num_of_items:2}], [{...pkg,charge_type:'unit',unit:'lbs'}]]) {
    assert.equal(storefrontRetailPrice(product, packages).retailPriceCents, null);
  }
});
