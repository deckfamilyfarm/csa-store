import test from "node:test";
import assert from "node:assert/strict";
import { refreshInventoryBatches } from "./inventoryRefresh.js";
import { adminResponseError } from "../adminErrors.js";

test("inventory updates arrive in small batches and a failed batch preserves successful results", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => i + 1), calls = [], results = [];
  await refreshInventoryBatches(ids, async batch => {
    calls.push(batch);
    if (batch[0] === 7) throw new Error("Timed out");
    return { rows: batch.map(productId => ({ productId, inventory: 5 })) };
  }, (rows, count) => results.push({ rows, count }));
  assert.deepEqual(calls.map(batch => batch.length), [6, 6, 3]);
  assert.deepEqual(results.map(result => result.count), [6, 12, 15]);
  assert.equal(results[0].rows[0].inventory, 5);
  assert.match(results[1].rows[0].error, /FF inventory check failed.*Timed out/);
  assert.equal(results[2].rows[0].inventory, 5);
});

test("changing pages discards stale inventory results and stops additional requests", async () => {
  let cancelled = false, calls = 0, received = false;
  await refreshInventoryBatches([1,2,3,4,5,6,7], async () => {
    calls++; cancelled = true; return { rows: [] };
  }, () => { received = true; }, () => cancelled);
  assert.equal(calls, 1); assert.equal(received, false);
});

test("an HTML gateway timeout is explained without a misleading create error", async () => {
  const error = await adminResponseError(new Response("<html>504 Gateway Time-out</html>", { status: 504 }), "Admin create failed");
  assert.equal(error.status, 504); assert.match(error.message, /could not finish/);
  assert.doesNotMatch(error.message, /create|html/);
});

test("inventory conflict details and backend validation messages survive", async () => {
  const error = await adminResponseError(new Response(JSON.stringify({ error: "Review current stock", inventoryConflict: { inventory: 9 } }), { status: 409 }), "Failed");
  assert.equal(error.message, "Review current stock"); assert.deepEqual(error.inventoryConflict, { inventory: 9 });
});
