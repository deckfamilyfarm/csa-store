import test from "node:test";
import assert from "node:assert/strict";
import { compareLocalChannelPrices } from "./enterprisePricingComparison.js";
const revision = { input: { squareEnabled: true, pricingUnit: "lb" }, output: { squareUnitCents: 1000, packages: [{ packageId: 7, localLineRegularCents: 3600 }] } };
const record = { packages: [{ id: 7, name: "Roast", metadata: { localLinePackageId: 70 } }],
  localLinePrices: ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"].map(listName => ({ packageId: 7, listName, finalPrice: "36.00" })),
  squarePrices: [{ packageId: 7, priceCents: 1050 }] };
test("review compares four baskets and eligible Square prices without inventing verification", () => {
  const result = compareLocalChannelPrices(revision, record);
  assert.equal(result.length, 5);
  assert.equal(result.filter(row => row.status === "matches").length, 4);
  assert.equal(result.at(-1).status, "different");
  assert.equal(result.at(-1).currentCents, 1050);
});
test("Square disabled products have no Square comparisons; missing prices and mappings need checking", () => {
  const result = compareLocalChannelPrices({ ...revision, input: { squareEnabled: false } }, { ...record, packages: [], localLinePrices: [] });
  assert.equal(result.length, 4);
  assert(result.every(row => row.destination === "Local Line" && row.status === "needs-check"));
  assert(compareLocalChannelPrices(revision, undefined).every(row => row.status === "needs-check"));
});
