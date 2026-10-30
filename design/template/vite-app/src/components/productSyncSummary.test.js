import test from "node:test";
import assert from "node:assert/strict";
import { productSyncSummary, syncMoney } from "./productSyncSummary.js";
import { comparisonGroups } from "./productSyncView.js";

const action = {
  direction: "outgoing", platform: "localline", display: {
    current: { fields: { packages: [{ name: "2.5 oz ea", unit_price: 11.2, price_list_entries: [{ adjustment_type: 2, adjustment_value: 45 }] }] }, images: [{ product_image: 440536, priority_order: 0 }] },
    proposed: { fields: { packages: [{ name: "2.5 oz ea", unit_price: 16.8, price_list_entries: [{ adjustment_type: 3, adjustment_value: 16.8 }] }] }, images: { sources: ["https://example.test/product.jpg"] } },
    pricingComparison: ["Guest Basket", "Herd Share Members", "SNAP"].map((listName, index) => ({
      remotePackageId: 10, remoteListId: index + 1, packageName: "2.5 oz ea", listName,
      currentCents: 1624, localCents: 1680
    }))
  }
};
test("customer price review condenses matching baskets without confusing base price and markup", () => {
  const result = productSyncSummary(action);
  assert.equal(result.prices.length, 1);
  assert.equal(result.prices[0].currentCents, 1624);
  assert.equal(result.prices[0].localCents, 1680);
  assert.equal(result.prices[0].totalBaskets, 3);
  assert.deepEqual(result.prices[0].baskets, ["Guest Basket", "Herd Share Members", "SNAP"]);
  assert(result.notes.some(note => note.includes("saved product photo")));
  assert(result.notes.some(note => note.includes("separate markup")));
  assert(!JSON.stringify(result).includes("440536"));
  assert(!JSON.stringify(result).includes("https://"));
  assert(comparisonGroups(action).some(group => group.rows.some(row => row.current === 45)), "technical values remain available");
});
test("basket differences and unknown customer prices remain distinct", () => {
  const changed = structuredClone(action);
  changed.display.pricingComparison[1].currentCents = null;
  changed.display.pricingComparison[2].currentCents = 1700;
  assert.equal(productSyncSummary(changed).prices.length, 3);
  assert.equal(syncMoney(null), "Not available");
  assert.equal(syncMoney(0), "$0.00");
  delete changed.display.pricingComparison;
  assert.equal(productSyncSummary(changed).prices.length, 0, "do not substitute a base price for missing customer prices");
});
test("unit-only Square changes and non-price changes remain visible", () => {
  const square = productSyncSummary({ platform: "square", display: { current: { price: 10, sellingUnit: "each" }, proposed: { price: 10, sellingUnit: "lb" } } });
  assert.equal(square.prices[0].currentUnit, "each");
  assert.equal(square.prices[0].proposedUnit, "lb");
  const changed = structuredClone(action);
  changed.display.current.fields.visible = false;
  changed.display.proposed.fields.visible = true;
  assert(productSyncSummary(changed).otherGroups.some(group => group.title === "Visibility & inventory"));
  assert.equal(productSyncSummary({ ...action, direction: "incoming" }), null);
});
