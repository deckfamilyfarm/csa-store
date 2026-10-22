import test from "node:test";
import assert from "node:assert/strict";
import { planProductMigration, buildMigrationPlan } from "./enterprisePricingMigration.js";

const sample = overrides => ({ product: { id: 1, name: "Sausage 12 oz", vendorId: 1,
  vendorName: "Deck Family Farm", categoryName: "Meat" },
  vendor: { id: 1, name: "Deck Family Farm", priceListMarkup: "0.6574" },
  profile: { pricingUnit: "each", unitOfMeasure: "each", sourceUnitPrice: "19.50", sourceMultiplier: "0.5412", onSale: 0 },
  sale: { onSale: 0 }, packages: [{ id: 10, name: "12 oz", price: "10.55", numOfItems: 1, visible: 1 }],
  localLinePrices: ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"].map(listName => ({ packageId: 10, listName, finalPrice: "17.55" })),
  squarePrices: [{ packageId: 10, priceCents: 1950 }], ...overrides });

test("migration calibrates the new markup from inferred cost and current Square reference", () => {
  const plan = planProductMigration(sample());
  assert.equal(plan.action, "ready");
  assert.equal(plan.buyPrice.cents, 1055);
  assert.equal(plan.input.pricingUnit, "each");
  assert.equal(plan.output.squareUnitCents, 1950);
  assert.equal(plan.output.csaUnitCents, 1755);
  assert.deepEqual(Object.values(plan.output.packages[0].localLineBasketCents), [1755, 1755, 1755, 1755]);
  assert.equal(plan.approvedForMigration, false);
});

test("weighted package prices convert to lb and Square rounds under the new rules", () => {
  const plan = planProductMigration(sample({ profile: { pricingUnit: "lbs", unitOfMeasure: "lbs", minWeight: "2.3", maxWeight: "2.9", sourceUnitPrice: "16.00" },
    packages: [{ id: 10, name: "Chuck", price: "22.51", numOfItems: 1 }], squarePrices: [{ packageId: 10, priceCents: 1624 }] }));
  assert.equal(plan.buyPrice.cents, 866);
  assert.equal(plan.output.squareUnitCents, 1600);
  assert.equal(plan.output.csaUnitCents, 1440);
  assert.equal(plan.output.packages[0].localLineRegularCents, 3744);
});

test("legacy discounted Square price does not become the permanent regular price", () => {
  const plan = planProductMigration(sample({ profile: { pricingUnit: "each", sourceUnitPrice: "19.50", onSale: 1, saleDiscount: "0.1" },
    sale: { onSale: 1, saleDiscount: "0.1" }, squarePrices: [{ packageId: 10, priceCents: 1755 }] }));
  assert.equal(plan.output.squareUnitCents, 1950);
  assert.equal(plan.input.saleBp, 0);
  assert.equal(plan.sale.discountBp, 1000);
  assert.equal(plan.comparisons[0].currentSquare[0].proposedSaleCents, 1755);
  assert(plan.reviewReasons.some(reason => reason.includes("separate promotion")));
});

test("CSA-only products preserve reference price without creating Square actions", () => {
  const plan = planProductMigration(sample({ product: { id: 2, name: "Granola", vendorName: "Other Farm" },
    vendor: { name: "Other Farm" }, profile: null, squarePrices: [],
    packages: [{ id: 10, name: "Bag", price: "6.00", numOfItems: 1 }],
    localLinePrices: [{ packageId: 10, listName: "Guest Basket", finalPrice: "8.70" }] }));
  assert.equal(plan.output.csaUnitCents, 870);
  assert.equal(plan.input.customMarkupBp, 4500);
  assert.equal(plan.input.squareEnabled, false);
  assert.equal(plan.output.squareUnitCents, null);
});

test("missing explicit Square units and special products remain held or preserved", () => {
  const plan = buildMigrationPlan([sample({ profile: null }), sample({ product: { id: 3, name: "Bottle deposit" } })]);
  assert.equal(plan.summary.held, 1);
  assert.equal(plan.summary.preservedSpecial, 1);
  assert.equal(plan.rows[0].input, null);
});
