import { test } from "node:test";
import assert from "node:assert/strict";
import { farmPounds, resolveFarmInventory } from "./farmInventory.js";
import { validateFarmStockInput } from "./productFarmStock.js";

test("farm pounds distinguish unknown from zero and reject invalid/over-precise counts", () => {
  for (const value of [null, ""]) assert.equal(farmPounds(value), null);
  for (const value of [0, "0", 0.125, "25.500", 9999999.999]) assert.equal(farmPounds(value), Number(value));
  for (const value of [-1, Infinity, NaN, undefined, true, {}, " ", "1e2", "1,000", "2lbs", "1.2345", 10000000]) assert.throws(() => farmPounds(value));
  for (const value of [-1, "1", null, 1.1, undefined]) assert.throws(() => validateFarmStockInput({ stockOnFarmLbs: 2, expectedRevision: value }), /revision/);
  for (const stockOnFarmLbs of ["", "2", true, -1, 1.2345]) assert.throws(() => validateFarmStockInput({ stockOnFarmLbs, expectedRevision: 0 }));
  assert.deepEqual(validateFarmStockInput({ stockOnFarmLbs: null, expectedRevision: 0 }), { stockOnFarmLbs: null });
});

test("farm counts and availability link without inventing unknown weights", () => {
  const current = { stockOnFarm: null, stockOnFarmLbs: null };
  assert.deepEqual(resolveFarmInventory(current, { stockOnFarmLbs: 12.125 }), { stockOnFarm: true, stockOnFarmLbs: 12.125 });
  assert.deepEqual(resolveFarmInventory(current, { stockOnFarmLbs: 0 }), { stockOnFarm: false, stockOnFarmLbs: 0 });
  assert.deepEqual(resolveFarmInventory(current, { stockOnFarmLbs: null }), current);
  assert.deepEqual(resolveFarmInventory({ stockOnFarm: true, stockOnFarmLbs: 8 }, { stockOnFarmLbs: null }), { stockOnFarm: true, stockOnFarmLbs: null });
  assert.deepEqual(resolveFarmInventory({ stockOnFarm: true, stockOnFarmLbs: 8 }, { stockOnFarm: false }), { stockOnFarm: false, stockOnFarmLbs: 0 });
  assert.deepEqual(resolveFarmInventory({ stockOnFarm: false, stockOnFarmLbs: 0 }, { stockOnFarm: true }), { stockOnFarm: true, stockOnFarmLbs: null });
  assert.deepEqual(resolveFarmInventory({ stockOnFarm: true, stockOnFarmLbs: 8 }, { stockOnFarm: true }), { stockOnFarm: true, stockOnFarmLbs: 8 });
  assert.throws(() => resolveFarmInventory(current, { stockOnFarm: false, stockOnFarmLbs: 8 }), /agree/);
  assert.throws(() => resolveFarmInventory(current, { stockOnFarm: true, stockOnFarmLbs: 0 }), /agree/);
});
