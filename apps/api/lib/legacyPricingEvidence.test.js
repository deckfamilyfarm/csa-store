import assert from "node:assert/strict";
import test from "node:test";
import { deriveMigrationBuyPrice } from "./legacyPricingEvidence.js";

test("migration Buy Price uses stored package price for each products", () => {
  assert.deepEqual(deriveMigrationBuyPrice({ profile: { pricingUnit: "each" },
    packages: [{ price: "10.55", numOfItems: 1 }] }),
  { cents: 1055, unit: "each", basis: "each" });
  assert.equal(deriveMigrationBuyPrice({ profile: { pricingUnit: "each" },
    packages: [{ price: "10.55", numOfItems: 2 }] }).cents, 528);
});

test("migration Buy Price converts weighted packages to two-decimal per-pound amounts", () => {
  assert.equal(deriveMigrationBuyPrice({ profile: { pricingUnit: "lbs", minWeight: "2.3", maxWeight: "2.9" },
    packages: [{ price: "22.51" }] }).cents, 866);
  assert.equal(deriveMigrationBuyPrice({ profile: { pricingUnit: "lbs", avgWeightOverride: "0.875" },
    packages: [{ price: "10.82" }] }).cents, 1237);
});

test("migration holds conflicting packages and retains missing unit for review", () => {
  assert.equal(deriveMigrationBuyPrice({ profile: { pricingUnit: "each" },
    packages: [{ price: "10.00" }, { price: "11.00" }] }), null);
  assert.deepEqual(deriveMigrationBuyPrice({ packages: [{ price: "15.00", numOfItems: 1 }] }),
    { cents: 1500, unit: null, basis: "package" });
});
