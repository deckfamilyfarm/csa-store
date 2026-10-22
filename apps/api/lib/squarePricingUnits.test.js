import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSquareUnit, squareUnitSnapshot, expectedSquareUnit } from './squarePricingUnits.js';
import { buildSquarePriceAuditRow, buildVariationUpdateObject } from './squareStoreSync.js';
import { squareProjection, inspectAction } from './productSyncAdapters.js';
import { preflight } from './productSyncCore.js';

const pound = { id: 'LB', type: 'MEASUREMENT_UNIT', measurement_unit_data: { measurement_unit: { type: 'TYPE_WEIGHT', weight_unit: 'IMPERIAL_POUND' }, precision: 3 } };
const units = new Map([['LB', pound]]);
const variation = { id: 'V', type: 'ITEM_VARIATION', version: 1, present_at_all_locations: true,
  item_variation_data: { item_id: 'I', name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 250, currency: 'USD' },
    sku: 'BONES', track_inventory: false, location_overrides: [{ location_id: 'L', track_inventory: false }] } };
const row = { productId: 1, productName: 'Lamb Bones', packageId: 2, vendorName: 'Deck Family Farm', unitOfMeasure: 'lbs', sourceUnitPrice: 2.5,
  minWeight: 3, maxWeight: 5, sourceMultiplier: .5412, squareItemId: 'I', squareVariationId: 'V', squarePricingType: 'FIXED_PRICING', squarePriceAmount: 250, squareCurrency: 'USD', squareRawJson: variation };
const packages = new Map([[1, [{ id: 2, name: '3–5 lb bag', unit: 'pk', price: 5.41 }]]]);

test('Lamb and Pork Bones with equal prices still require a reviewed unit correction', () => {
  for (const productName of ['Lamb Bones', 'Pork Bones']) {
    const audit = buildSquarePriceAuditRow({ ...row, productName }, packages, new Map(), units);
    assert.equal(audit.status, 'changed'); assert.equal(audit.unitChanged, true);
    assert.equal(audit.proposedAmount, 250); assert.equal(audit.proposedUnit.id, 'LB');
    const updated = buildVariationUpdateObject(variation, audit.proposedAmount, audit.currency, audit.proposedUnit.id);
    assert.deepEqual(updated, { ...variation, item_variation_data: { ...variation.item_variation_data, measurement_unit_id: 'LB' } });
    assert.equal(buildSquarePriceAuditRow({ ...row, squareRawJson: updated }, packages, new Map(), units).status, 'synced');
    assert.equal(variation.item_variation_data.measurement_unit_id, undefined);
  }
});
test('a location price override prevents a false synced result and a base-price publication', () => {
  const atLocation = { ...variation, item_variation_data: { ...variation.item_variation_data,
    measurement_unit_id: 'LB', location_overrides: [{ location_id: 'KING', price_money: { amount: 1000, currency: 'USD' }, pricing_type: 'FIXED_PRICING' }] } };
  const audit = buildSquarePriceAuditRow({ ...row, squareRawJson: atLocation }, packages, new Map(), units);
  assert.equal(audit.status, 'blocked');
  assert.match(audit.message, /KING.*USD 10\.00/);
  assert.throws(() => buildVariationUpdateObject(atLocation, 250, 'USD', 'LB'), /location KING has a separate price/);
});
test('sale rates remain per pound, while standard bag prices remain per package', () => {
  const sale = buildSquarePriceAuditRow({ ...row, saleOnSale: 1, saleSaleDiscount: .2 }, packages, new Map(), units);
  assert.equal(sale.proposedAmount, 200); assert.equal(sale.expectedUnit, 'lb');
  const standard = buildSquarePriceAuditRow({ ...row, vendorName: 'Another Farm', squarePriceAmount: 541 }, packages, new Map(), units);
  assert.equal(standard.proposedAmount, 541); assert.equal(standard.proposedUnit.id, null); assert.equal(standard.status, 'synced');
});
test('unknown local units, custom bags, deleted units, and missing pound units block publication', () => {
  assert.equal(expectedSquareUnit(true, null), null);
  assert.equal(buildSquarePriceAuditRow({ ...row, unitOfMeasure: null }, packages, new Map(), units).status, 'blocked');
  assert.equal(buildSquarePriceAuditRow(row, packages, new Map()).status, 'blocked');
  for (const definition of [undefined, { ...pound, is_deleted: true }, { ...pound, measurement_unit_data: { measurement_unit: { type: 'TYPE_CUSTOM', custom_unit: { name: 'Bag', abbreviation: 'bag' } }, precision: 0 } }]) {
    const map = new Map([['LB', definition]]);
    const measured = { ...variation, item_variation_data: { ...variation.item_variation_data, measurement_unit_id: 'LB' } };
    assert.ok(planSquareUnit('lb', measured, map).issues.length);
  }
});
test('an explicitly reviewed each price clears only the pound unit', () => {
  const measured = { ...variation, item_variation_data: { ...variation.item_variation_data, measurement_unit_id: 'LB' } };
  const plan = planSquareUnit('each', measured, units);
  assert.equal(plan.changed, true); assert.deepEqual(plan.issues, []); assert.equal(plan.proposed.id, null);
  assert.deepEqual(buildVariationUpdateObject(measured, 250, 'USD', null), variation);
});
test('stock tracking/conversions are never silently reinterpreted when changing units', () => {
  for (const fields of [{ track_inventory: true }, { stockable_conversion: { stockable_item_variation_id: 'stock' } }, { location_overrides: [{ track_inventory: true }] }]) {
    const tracked = { ...variation, item_variation_data: { ...variation.item_variation_data, ...fields } };
    assert.ok(planSquareUnit('lb', tracked, units).issues.length);
    assert.throws(() => buildVariationUpdateObject(tracked, 250, 'USD', 'LB'), /inventory tracking/);
    assert.doesNotThrow(() => buildVariationUpdateObject(tracked, 250, 'USD'));
  }
});
test('unit id or definition drift holds frozen approvals; an unchanged price cannot confirm a missing unit', () => {
  const after = buildVariationUpdateObject(variation, 250, 'USD', 'LB');
  const baseline = squareProjection(variation, units), desired = squareProjection(after, units);
  const action = { mapping: {}, localBefore: {}, localAfter: {}, remoteBefore: baseline, desired };
  assert.equal(preflight(action, { mapping: {}, local: {}, remote: baseline, desired }).status, 'ready');
  assert.equal(preflight(action, { mapping: {}, local: {}, remote: desired, desired }).status, 'completed');
  const changed = new Map([['LB', { ...pound, measurement_unit_data: { ...pound.measurement_unit_data, precision: 1 } }]]);
  assert.equal(preflight(action, { mapping: {}, local: {}, remote: squareProjection(after, changed), desired }).status, 'held');
  assert.notDeepEqual(squareUnitSnapshot('LB', changed), squareUnitSnapshot('LB', units));
});
test('pre-unit approvals are held before remote calls, preserving any uncertain request', async () => {
  const checkpoint = { request: structuredClone(variation), idempotencyKey: 'keep' };
  await assert.rejects(inspectAction({ platform: 'square', payload: { amount: 250, currency: 'USD' }, checkpoint }), error => error.hold && /predates/.test(error.message));
  assert.equal(checkpoint.idempotencyKey, 'keep'); assert.deepEqual(checkpoint.request, variation);
});
