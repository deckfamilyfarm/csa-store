import test from "node:test";
import assert from "node:assert/strict";
import { mobileInventoryView, readMobileInventoryPages } from "./mobileInventoryView.js";
import { patchProductDraft } from "./productWorkspace.js";

const rows = [
  { productId: 1, name: "Lamb bones", stockOnFarm: null, inventory: 0, trackInventory: true, visible: true },
  { productId: 2, name: "Ground pork", stockOnFarm: false, inventory: 0, trackInventory: false, visible: true },
  { productId: 3, name: "Ground beef", stockOnFarm: true, inventory: 12, trackInventory: true, visible: false },
];
test("both yes and no are checked, independently of quantity, tracking and visibility", () => {
  assert.equal(mobileInventoryView(rows, {}, "", "all").checked, 2);
  assert.deepEqual(mobileInventoryView(rows, {}, "", "checked").rows.map(row => row.productId), [2, 3]);
  assert.deepEqual(mobileInventoryView(rows, {}, "", "not-checked").rows.map(row => row.productId), [1]);
});
test("the detailed farm filter composes with checked tabs and includes draft changes", () => {
  const drafts = patchProductDraft({}, rows[0], { stockOnFarm: true });
  const result = mobileInventoryView(rows, drafts, "", "checked", "true");
  assert.deepEqual(result.rows.map(row => row.productId), [1, 3]);
  assert.equal(result.checked, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(mobileInventoryView(rows, {}, "", "all", "false").rows.map(row => row.productId), [2]);
  assert.equal(mobileInventoryView(rows, {}, "", "checked", "not-checked").rows.length, 0);
});
test("search and status filters preserve the scope denominator and shared unsaved drafts", () => {
  const drafts = patchProductDraft({}, rows[0], { stockOnFarm: false, inventory: 8 });
  const before = JSON.stringify(drafts);
  const result = mobileInventoryView(rows, drafts, " GROUND ", "checked");
  assert.equal(result.total, 3);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.rows.map(row => row.productId), [2, 3]);
  assert.equal(JSON.stringify(drafts), before);
  assert.equal(mobileInventoryView(rows, drafts, "lamb", "checked").rows[0].productId, 1);
  const undone = patchProductDraft(drafts, rows[0], { stockOnFarm: null });
  assert.equal(mobileInventoryView(rows, undone, "", "all").checked, 2);
});
test("mobile progress reads every existing API page and deduplicates page overlap", async () => {
  const requested = [];
  const result = await readMobileInventoryPages(async page => {
    requested.push(page);
    return { rows: page === 1 ? rows.slice(0, 2) : rows.slice(1), pagination: { totalPages: 2 } };
  });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(mobileInventoryView(result.rows, {}, "", "all").total, 3);
});
test("failed or superseded page loads never produce misleading partial progress", async () => {
  await assert.rejects(readMobileInventoryPages(async page => {
    if (page === 2) throw new Error("Connection lost");
    return { rows, pagination: { totalPages: 2 } };
  }), /Connection lost/);
  assert.equal(await readMobileInventoryPages(async () => ({ rows, pagination: { totalPages: 2 } }), () => true), null);
});
