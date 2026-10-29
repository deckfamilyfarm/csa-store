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

test("deposits retain zero markup even when vendor and profile defaults differ", async () => {
  const { deriveLegacyPricingEvidence } = await import('./legacyPricingEvidence.js');
  const record = { product: { name: 'Animal Side Deposit', vendorPriceListMarkup: 1.4 },
    profile: { pricingUnit: 'each', guestMarkup: 0.6, sourceUnitPrice: 200 },
    packages: [{ id: 1, name: 'ea', price: '200.00', numOfItems: 1 }],
    localLinePrices: ['Guest Basket', 'CSA Members', 'Herd Share Members', 'SNAP'].map(listName =>
      ({ packageId: 1, listName, adjustmentType: 3, adjustmentValue: '200.00', finalPrice: '200.00' })) };
  const evidence = deriveLegacyPricingEvidence(record);
  assert.equal(evidence.pricingRule, 'deposit-no-markup');
  assert.equal(evidence.markupPercent, 0);
  assert.equal(evidence.packages[0].displayedPriceCents, 20000);
  assert.equal(evidence.packages[0].estimatedCsaUnitCents, 20000);
  assert.deepEqual(evidence.warnings, []);
  assert.equal(deriveMigrationBuyPrice(record), null, 'Deposit amount is not inferred as an enterprise purchase cost');
  const conflict = deriveLegacyPricingEvidence({ ...record, localLinePrices: record.localLinePrices.map(row => ({ ...row, adjustmentValue: 0 })) });
  assert.equal(conflict.warnings.length, 4);
  assert.equal(conflict.packages[0].displayedPriceCents, 20000, 'Keep cached price and flag conflicting fixed adjustment');
});
