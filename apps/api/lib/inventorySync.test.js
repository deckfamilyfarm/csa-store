import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryChanges } from "./inventorySync.js";

test("direct inventory updates reject all other product fields and invalid stock", () => {
  assert.deepEqual(inventoryChanges({inventory:0,trackInventory:true}),{inventory:0,trackInventory:1});
  assert.deepEqual(inventoryChanges({visible:false}),{visible:0});
  assert.deepEqual(inventoryChanges({visible:true}),{visible:1});
  for (const changes of [{}, {visible:2}, {visible:null}, {onSale:1}, {images:[]}, {inventory:1,sourceUnitPrice:10},
    {inventory:-1}, {inventory:1.5}, {inventory:true}, {inventory:null}, {inventory:"2"}, {trackInventory:2}]) {
    assert.throws(()=>inventoryChanges(changes));
  }
});
