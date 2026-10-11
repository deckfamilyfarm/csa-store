import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireProductPricingUnit } from './productPricingUnitInput.js';
test('all new local products require a deliberate valid pricing unit', () => {
  for (const usesSourcePricing of [true, false]) {
    for (const unitOfMeasure of [undefined, null, '', 'lb', 'bag', 'typo']) {
      assert.throws(() => requireProductPricingUnit({ pricingProfile: { unitOfMeasure } }, usesSourcePricing), /Pricing unit is required/);
    }
    assert.equal(requireProductPricingUnit({ pricingProfile: { unitOfMeasure: 'each' } }, usesSourcePricing), 'each');
  }
  assert.equal(requireProductPricingUnit({ pricingProfile: { unitOfMeasure: 'lbs' } }, true), 'lbs');
  assert.throws(() => requireProductPricingUnit({ pricingProfile: { unitOfMeasure: 'lbs' } }, false), /package price/);
});
