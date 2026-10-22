import assert from "node:assert/strict";
import { assertLocalDatabase, installLocalEnvironment, installLoopbackNetworkGuard } from "./env.mjs";

installLocalEnvironment();
assertLocalDatabase();
installLoopbackNetworkGuard();
const { getPool } = await import("../../apps/api/db.js");
const { listEnterprisePricingProducts, getEnterprisePricingProduct } = await import("../../apps/api/lib/enterprisePricingService.js");
try {
  const listing = await listEnterprisePricingProducts({ limit: 100 });
  const result = { rows: listing.rows.filter(row => row.id >= 9100001 && row.id <= 9100015) };
  assert.equal(result.rows.length, 15);
  assert.deepEqual(Object.fromEntries(["Deck Family Farm", "Deck Family Farm's Hyland Artisinal Meats", "Creamy Cow, LLC"]
    .map(name => [name, result.rows.filter(row => row.vendorName === name).length])),
  { "Deck Family Farm": 5, "Deck Family Farm's Hyland Artisinal Meats": 5, "Creamy Cow, LLC": 5 });
  assert(result.rows.every(row => row.approvedSquareLinks === 0));
  assert(result.rows.every(row => row.legacy.packages.length > 0));
  assert.deepEqual(result.rows.filter(row => !row.sourceEvidence || !row.buyPrice || row.buyPrice.cents <= 0)
    .map(row => row.name), []);
  const bratwurst = result.rows.find(row => row.name === "Bratwurst");
  assert.equal(bratwurst.sourceEvidence.square[0].priceCents, 1755);
  assert.equal(bratwurst.sourceEvidence.packages[0].displayedPriceCents, 1574);
  assert.equal(bratwurst.sourceEvidence.sale.discountPercent, 10);
  assert.equal(bratwurst.buyPrice.cents, 1055);
  const chuck = await getEnterprisePricingProduct(9100003);
  const hylandWeighted = await getEnterprisePricingProduct(9100010);
  const milk = await getEnterprisePricingProduct(9100011);
  assert.equal(chuck.suggestedInput.pricingUnit, "lb");
  assert.equal(chuck.buyPrice.cents, 866);
  assert.equal(chuck.suggestedInput.purchaseCosts[0].cost, "8.66");
  assert.equal(Number(chuck.suggestedInput.packages[0].minWeight), 2.3);
  assert.equal(hylandWeighted.suggestedInput.pricingUnit, "lb");
  assert.equal(Number(hylandWeighted.suggestedInput.packages[0].avgWeightOverride), 0.875);
  assert.equal(hylandWeighted.buyPrice.cents, 1237);
  assert.equal(milk.suggestedInput.pricingUnit, null);
  assert.equal(milk.buyPrice.cents, 1000);
  assert.equal(milk.sourceEvidence.packages[0].basketCount, 2);
  assert.equal(milk.sourceEvidence.packages[0].displayedPriceCents, 1400);
  console.log("15 local samples verified: two-decimal Buy Prices, markups, sale flags, channel prices, and units visible; no remote links.");
} finally {
  await getPool().end();
}
