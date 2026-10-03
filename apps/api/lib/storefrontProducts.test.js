import assert from 'node:assert/strict';
import test from 'node:test';
import { storefrontRetailPrice, turkeyVariant, duplicateTurkeyVariants } from './storefrontProducts.js';

test('turkeys use Products retail per bird, without CSA pricing factors or markups', () => {
  assert.deepEqual(storefrontRetailPrice({ vendor: 'Deck Family Farm', source_unit_price: '115.00', unit_of_measure: 'each',
    source_multiplier: 0.5412, guest_markup: 0.6574 }), { retailPriceCents: 11500, priceError: '' });
  assert.equal(storefrontRetailPrice({ vendor: 'Hyland', source_unit_price: '123.45', unit_of_measure: 'ea' }).retailPriceCents, 12345);
});

test('six catalog turkey combinations resolve to separate breeds and actual package weight ranges', () => {
  for (const [name, breed, typeLabel] of [['Broad Breasted White Turkeys', 'broad-breasted-white', 'White'], ['Heritage Thanksgiving Turkey', 'heritage', 'Heritage']]) {
    for (const [size, packageName, expected] of [['Small','9 - 12  lbs','9–12 lb'], ['Medium','12.01 - 14.00  lbs','12.01–14.00 lb'], ['Large','14.01 - 16.00 lbs','14.01–16.00 lb']]) {
      const result = turkeyVariant({ name: `${name}, ${size}` }, [{ name: packageName }]);
      assert.equal(result.preorderBreed, breed); assert.equal(result.typeLabel, typeLabel);
      assert.equal(result.sizeLabel, expected); assert.equal(result.variantError, '');
    }
  }
});
test('missing, conflicting or invalid package weights cannot be offered as guessed variants', () => {
  const product = { name:'Heritage Turkey, Small' };
  for (const names of [[], ['Small'], ['9–12 lbs','12–14 lbs'], ['12–9 lbs'], ['0–12 lbs','9–12 lbs'], ['9–12 lbs','each']]) {
    assert.ok(turkeyVariant(product, names.map(name => ({ name }))).variantError);
  }
  assert.ok(turkeyVariant({name:'Turkey pieces'}, [{name:'9–12 lbs'}]).variantError);
  assert.equal(turkeyVariant(product, [{name:'9–12 lbs'},{name:'9.00 - 12.00 lb'}]).variantError, '');
});
test('duplicate active combinations are detected without changing variant identities', () => {
  const products = new Map([[1,turkeyVariant({name:'Heritage Turkey'},[{name:'9–12 lbs'}])],[2,turkeyVariant({name:'Heritage Turkey'},[{name:'9.00 - 12.00 lbs'}])]]);
  assert.deepEqual([...duplicateTurkeyVariants([{product_id:1,active:1},{product_id:2,active:1}], products)], ['heritage:9-12']);
  assert.equal(duplicateTurkeyVariants([{product_id:1,active:1},{product_id:2,active:0}], products).size, 0);
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
