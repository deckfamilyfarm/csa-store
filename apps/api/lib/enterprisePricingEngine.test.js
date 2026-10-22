import test from "node:test";
import assert from "node:assert/strict";
import { averagePackageWeight, calculateEnterprisePricing, DEFAULT_PRICING_SETTINGS } from "./enterprisePricingEngine.js";

test("Square per-pound price drives one discounted Local Line package price for all baskets", () => {
  const result = calculateEnterprisePricing({
    pricingUnit: "lb", buyFromPrice: "5.0000", markupCategory: "custom", customMarkupBp: 10000,
    squareEnabled: true, saleBp: 2000,
    packages: [{ packageId: 1, minWeight: "3.000", maxWeight: "5.000" }]
  });
  assert.equal(result.squareUnitCents, 1000);
  assert.equal(result.csaUnitCents, 900);
  assert.equal(result.packages[0].localLineRegularCents, 3600);
  assert.equal(result.packages[0].localLineSaleCents, 2880);
  assert.deepEqual(Object.values(result.packages[0].localLineBasketCents), [2880, 2880, 2880, 2880]);
  assert.equal(result.packages[0].weightSource, "midpoint");
});

test("fixed 12 oz sausage sold each remains one package and multipacks multiply price", () => {
  const result = calculateEnterprisePricing({
    pricingUnit: "each", buyFromPrice: "3.0000", markupCategory: "perishable", squareEnabled: true,
    packages: [{ packageId: 1, quantity: 1, cachedWeight: "0.750" }, { packageId: 2, quantity: 6 }]
  });
  assert.equal(result.squareUnitCents, 500);
  assert.equal(result.csaUnitCents, 450);
  assert.equal(result.packages[0].localLineRegularCents, 450);
  assert.equal(result.packages[0].averageWeightMilliPounds, null);
  assert.equal(result.packages[1].squareVariationCents, 3000);
  assert.equal(result.packages[1].localLineRegularCents, 2700);
});

test("category markups, override, and global discount use deterministic rounding", () => {
  const base = { pricingUnit: "each", squareEnabled: false, packages: [{ packageId: 1, quantity: 1 }] };
  for (const [markupCategory, buyFromPrice, expected] of [
    ["highlyPerishable", "2.0000", 400], ["perishable", "3.5000", 560], ["shelfStable", "6.0000", 870]
  ]) assert.equal(calculateEnterprisePricing({ ...base, markupCategory, buyFromPrice }).csaUnitCents, expected);
  const custom = calculateEnterprisePricing({ ...base, markupCategory: "shelfStable", customMarkupBp: 5000, buyFromPrice: "2.0000", csaOverride: "3.25" });
  assert.equal(custom.calculatedRetailCents, 300);
  assert.equal(custom.csaUnitCents, 325);
  assert.equal(custom.effectiveMarkupBp, 6250);
  const beef = calculateEnterprisePricing({ ...base, pricingUnit: "lb", squareEnabled: true, markupCategory: "custom", customMarkupBp: 14000, buyFromPrice: "5.0000", packages: [{ packageId: 1, minWeight: "1.000" }] });
  assert.equal(beef.squareUnitCents, 1200);
  assert.equal(beef.csaUnitCents, 1080);
  assert.equal(calculateEnterprisePricing({ ...base, pricingUnit: "lb", squareEnabled: true, markupCategory: "custom", customMarkupBp: 14000, buyFromPrice: "5.0000", packages: [{ packageId: 1, minWeight: "1.000" }] }, { ...DEFAULT_PRICING_SETTINGS, localLineDiscountBp: 500 }).csaUnitCents, 1140);
});

test("weight source precedence and invalid inputs are explicit", () => {
  assert.deepEqual(averagePackageWeight({ avgWeightOverride: "3.250", minWeight: "2.000", maxWeight: "4.000" }), { milliPounds: 3250, source: "override" });
  assert.deepEqual(averagePackageWeight({ cachedWeight: "2.125", minWeight: "2.000" }), { milliPounds: 2125, source: "cached" });
  assert.throws(() => averagePackageWeight({ minWeight: "5", maxWeight: "3" }), /Maximum weight/);
  assert.throws(() => calculateEnterprisePricing({ pricingUnit: "each", buyFromPrice: "2", markupCategory: "perishable", squareEnabled: true, squareOverride: "4.20" }), /multiple/);
});

test("fixed Square and CSA overrides stay fixed as purchase costs change", () => {
  const base = { pricingUnit: "each", markupCategory: "perishable", packages: [{ packageId: 1, quantity: 1 }] };
  const squareA = calculateEnterprisePricing({ ...base, buyFromPrice: "3.0000", squareEnabled: true, squareOverride: "7.50" });
  const squareB = calculateEnterprisePricing({ ...base, buyFromPrice: "4.0000", squareEnabled: true, squareOverride: "7.50" });
  assert.equal(squareA.squareUnitCents, 750);
  assert.equal(squareB.squareUnitCents, 750);
  assert.equal(squareA.csaUnitCents, 675);
  assert.equal(squareB.csaUnitCents, 675);
  assert.notEqual(squareA.effectiveMarkupBp, squareB.effectiveMarkupBp);
  const csaA = calculateEnterprisePricing({ ...base, buyFromPrice: "3.0000", squareEnabled: false, csaOverride: "6.25" });
  const csaB = calculateEnterprisePricing({ ...base, buyFromPrice: "4.0000", squareEnabled: false, csaOverride: "6.25" });
  assert.equal(csaA.csaUnitCents, 625);
  assert.equal(csaB.csaUnitCents, 625);
});
