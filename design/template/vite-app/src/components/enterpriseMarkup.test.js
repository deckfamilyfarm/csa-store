import test from "node:test";
import assert from "node:assert/strict";
import { markupValue, selectMarkupCategory, usesProductMarkup, retailMarginPercent } from "./enterpriseMarkup.js";
import { calculateEnterprisePricing, DEFAULT_PRICING_SETTINGS } from "../../../../../apps/api/lib/enterprisePricingEngine.js";

test("margin uses selling price as denominator and respects the effective retail channel", () => {
  const row = { input: { squareEnabled: true }, buyPrice: { cents: 500 }, output: { squareUnitCents: 1000, csaUnitCents: 900 } };
  assert.equal(retailMarginPercent(row), 50);
  assert.equal(retailMarginPercent({ ...row, input: { squareEnabled: false } }).toFixed(2), "44.44");
  assert.equal(retailMarginPercent({ ...row, buyPrice: { cents: 1200 } }), -20);
  assert.equal(retailMarginPercent({ ...row, buyPrice: null, output: { ...row.output, buyFromTenThousandths: 50000 } }), 50);
  assert.equal(retailMarginPercent({}), null);
  assert.equal(retailMarginPercent({ ...row, output: { squareUnitCents: 0 } }), null);
});

test("category selection clears migrated custom markup and uses configured defaults", () => {
  const settings = { ...DEFAULT_PRICING_SETTINGS, markupBp: { ...DEFAULT_PRICING_SETTINGS.markupBp, perishable: 6500 } };
  const input = { pricingUnit: "each", buyFromPrice: "2.00", squareEnabled: false,
    markupCategory: "custom", customMarkupBp: 12950, packages: [] };
  const selected = { ...input, ...selectMarkupCategory("perishable", input, settings) };
  assert.equal(selected.customMarkupBp, null);
  assert.equal(markupValue(selected, settings), 6500);
  assert.equal(calculateEnterprisePricing(selected, settings).csaUnitCents, 330);
});

test("product override retains category, including zero; custom selection preserves the effective rate", () => {
  const input = { markupCategory: "perishable", customMarkupBp: 0 };
  assert.equal(markupValue(input, DEFAULT_PRICING_SETTINGS), 0);
  assert.deepEqual(selectMarkupCategory("custom", input, DEFAULT_PRICING_SETTINGS), { markupCategory: "custom", customMarkupBp: 0 });
  assert.equal(markupValue({ ...input, customMarkupBp: null }, DEFAULT_PRICING_SETTINGS), 6500);
  assert.deepEqual(selectMarkupCategory("custom", { ...input, customMarkupBp: null }, DEFAULT_PRICING_SETTINGS), { markupCategory: "custom", customMarkupBp: 6500 });
});

test("enterprise vendor detection excludes ordinary third-party vendors", () => {
  for (const name of ["Deck Family Farm", "HYLAND", "Creamy Cow Dairy"]) assert.equal(usesProductMarkup(name), true);
  for (const name of ["Other Farm", "", null]) assert.equal(usesProductMarkup(name), false);
});

test("markup preview retains fixed price overrides and computes Square to CSA prices", () => {
  const input = { pricingUnit: "lb", buyFromPrice: "5.00", markupCategory: "custom", customMarkupBp: 14000, squareEnabled: true, packages: [] };
  const output = calculateEnterprisePricing(input);
  assert.equal(output.squareUnitCents, 1200);
  assert.equal(output.csaUnitCents, 1080);
  const fixed = calculateEnterprisePricing({ ...input, customMarkupBp: 10000, squareOverride: "12.00" });
  assert.equal(fixed.calculatedRetailCents, 1000);
  assert.equal(fixed.squareUnitCents, 1200);
  assert.equal(fixed.effectiveMarkupBp, 14000);
});

test("deposit display uses the fixed package amount without treating it as editable markup", async () => {
  const { isDepositPricing, depositBaseCents } = await import('./enterpriseMarkup.js');
  const row = { name: 'Bottle DEPOSIT', legacy: { packages: [{ storedPrice: '2.50' }] } };
  assert.equal(isDepositPricing(row), true);
  assert.equal(depositBaseCents(row), 250);
  assert.equal(isDepositPricing({ name: 'Milk' }), false);
  assert.equal(depositBaseCents({ ...row, legacy: { packages: [{ storedPrice: '2.50' }, { storedPrice: '5.00' }] } }), null);
});

test("Square price labels use the explicit local unit intended for publication", async () => {
  const { productPricingUnit } = await import('./enterpriseMarkup.js');
  assert.equal(productPricingUnit({ input: { pricingUnit: 'each' }, legacy: { pricingUnit: 'lb' } }), 'each');
  assert.equal(productPricingUnit({ legacy: { pricingUnit: 'lbs' } }), 'lb');
  assert.equal(productPricingUnit({ sourceEvidence: { unit: 'each' } }), 'each');
  assert.equal(productPricingUnit({ legacy: { packages: [{ name: '12 oz sausage' }] } }), null);
});

test("Deck/Hyland preset clears a custom override and uses the configured rate", () => {
  const selected = selectMarkupCategory("deckHyland", { markupCategory: "custom", customMarkupBp: 14000 }, DEFAULT_PRICING_SETTINGS);
  assert.deepEqual(selected, { markupCategory: "deckHyland", customMarkupBp: null });
  assert.equal(markupValue(selected, DEFAULT_PRICING_SETTINGS), 8500);
});
