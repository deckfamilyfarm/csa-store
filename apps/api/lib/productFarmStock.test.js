import { test } from "node:test";
import assert from "node:assert/strict";
import { farmStockValue, saveProductFarmStock, validateFarmStockInput } from "./productFarmStock.js";
import { inventoryChanges } from "./inventorySync.js";

test("farm availability preserves unchecked and explicit false, and accepts only explicit booleans", () => {
  for (const value of [null, undefined]) assert.equal(farmStockValue(value), null);
  for (const value of [false, 0, "0"]) assert.equal(farmStockValue(value), false);
  for (const value of [true, 1, "1"]) assert.equal(farmStockValue(value), true);
  for (const value of [true, false]) assert.equal(validateFarmStockInput({ stockOnFarm: value }), value);
  for (const input of [null, {}, { stockOnFarm: null }, { stockOnFarm: "false" }, { stockOnFarm: 0 }, { stockOnFarm: false, inventory: 0 }]) {
    assert.throws(() => validateFarmStockInput(input), /True or False/);
  }
  assert.throws(() => inventoryChanges({ stockOnFarm: true }), /stock, inventory tracking, and visibility only/);
});

test("read-only and remote-only roles cannot save farm stock, before any database or remote access", async () => {
  for (const roles of [[], ["localline_pull"], ["localline_push"], ["square_push"], ["membership_admin"]]) {
    await assert.rejects(saveProductFarmStock(7, { stockOnFarm: false }, { adminRoles: roles }), { status: 403 });
  }
  for (const id of [null, 0, -1, "", "7junk", 1.5, {}]) {
    await assert.rejects(saveProductFarmStock(id, { stockOnFarm: true }, { adminRoles: ["admin"] }), /Invalid product ID/);
  }
});
