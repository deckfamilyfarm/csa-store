import test from "node:test";
import assert from "node:assert/strict";
import { markupValue, selectMarkupCategory, usesProductMarkup } from "./enterpriseMarkup.js";
import { calculateEnterprisePricing, DEFAULT_PRICING_SETTINGS } from "../../../../../apps/api/lib/enterprisePricingEngine.js";

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
  assert.equal(markupValue({ ...input, customMarkupBp: null }, DEFAULT_PRICING_SETTINGS), 6000);
  assert.deepEqual(selectMarkupCategory("custom", { ...input, customMarkupBp: null }, DEFAULT_PRICING_SETTINGS), { markupCategory: "custom", customMarkupBp: 6000 });
});

test("enterprise vendors use direct markup entry; ordinary vendors expose categories", () => {
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
