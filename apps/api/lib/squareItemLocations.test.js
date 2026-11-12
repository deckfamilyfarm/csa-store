import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideSquareItemAtLocations, showSquareItemAtLocations, squareItemLocationSnapshot } from './squareItemLocations.js';
import { squareImageUpdateObject, squarePrimaryImageIds } from './squareProductImages.js';

const variation = { type: 'ITEM_VARIATION', id: 'V', version: 2, present_at_all_locations: true,
  item_variation_data: { item_id: 'I', price_money: { amount: 900, currency: 'USD' }, measurement_unit_id: 'LB', sku: 'CODE', track_inventory: true, channels: ['WEB'] } };
const item = { type: 'ITEM', id: 'I', version: 3, present_at_all_locations: true,
  item_data: { name: 'Cornish Medium', image_ids: ['OLD', 'SECOND'], variations: [variation], ecom_visibility: 'VISIBLE', tax_ids: ['TAX'] } };
test('hide an item and every variation at reviewed locations, preserving other settings', () => {
  const next = hideSquareItemAtLocations(item, ['MARKET1', 'MARKET2']);
  assert.deepEqual(squareItemLocationSnapshot(next, ['MARKET1', 'MARKET2', 'OTHER']), [
    { id: 'I', locations: { MARKET1: false, MARKET2: false, OTHER: true } },
    { id: 'V', locations: { MARKET1: false, MARKET2: false, OTHER: true } }
  ]);
  assert.deepEqual(next.item_data.variations[0].item_variation_data, variation.item_variation_data);
  assert.equal(next.item_data.ecom_visibility, item.item_data.ecom_visibility);
  assert.deepEqual(item.item_data.variations[0], variation, 'does not mutate the read baseline');
  assert.deepEqual(hideSquareItemAtLocations(next, ['MARKET2']), next, 'repeated operation is identical');
});
test('explicit location lists remove only reviewed locations and preserve inactive locations', () => {
  const baseline = structuredClone(item);
  for (const object of [baseline, ...baseline.item_data.variations]) {
    object.present_at_all_locations = false; object.present_at_location_ids = ['MARKET1', 'INACTIVE', 'OTHER'];
  }
  const next = hideSquareItemAtLocations(baseline, ['MARKET1']);
  assert.deepEqual(next.present_at_location_ids, ['INACTIVE', 'OTHER']);
  assert.deepEqual(next.item_data.variations[0].present_at_location_ids, ['INACTIVE', 'OTHER']);
});
test('primary photos retain additional images, locations, prices, inventory and units', () => {
  const next = squareImageUpdateObject(item, 'NEW');
  assert.deepEqual(next.item_data.image_ids, ['NEW', 'OLD', 'SECOND']);
  assert.deepEqual(next.item_data.variations, item.item_data.variations);
  assert.equal(next.present_at_all_locations, true);
  assert.equal(next.item_data.ecom_visibility, 'VISIBLE');
  assert.deepEqual(squarePrimaryImageIds('SECOND', item.item_data.image_ids), ['SECOND', 'OLD']);
  assert.throws(() => squareImageUpdateObject({ ...item, version: null }, 'NEW'), /version/);
});
test('enable the reviewed size at markets without changing other locations, photos or pricing', () => {
  const hidden = hideSquareItemAtLocations(item, ['MARKET1', 'OTHER']);
  const next = showSquareItemAtLocations(hidden, ['MARKET1']);
  assert.deepEqual(next.absent_at_location_ids, ['OTHER']);
  assert.deepEqual(next.item_data.variations[0].absent_at_location_ids, ['OTHER']);
  assert.deepEqual(next.item_data.variations[0].item_variation_data, variation.item_variation_data);
  assert.deepEqual(next.item_data.image_ids, ['OLD', 'SECOND']);
  hidden.present_at_all_locations = false; hidden.present_at_location_ids = ['INACTIVE'];
  assert.deepEqual(showSquareItemAtLocations(hidden, ['MARKET1']).present_at_location_ids, ['INACTIVE', 'MARKET1']);
});
