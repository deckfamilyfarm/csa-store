import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryChanges, saveInventoryToLocalLine } from "./inventorySync.js";
import { canPublishInventory, hasAdminPermission } from "./adminRoles.js";

test("inventory publishing permits inventory admins and retains existing editor/push grants", () => {
  for (const roles of [["admin"], ["inventory_admin"], ["inventory_admin", "localline_pull"],
    ["inventory_admin", "localline_push"], ["pricing_admin", "localline_push"], ["local_pricelist_admin", "localline_push"]]) {
    assert.equal(canPublishInventory(roles), true, roles.join(","));
  }
  assert.equal(hasAdminPermission(["inventory_admin"], "localline_push"), false);
});

test("inventory saves reject unauthorized roles before any database or remote access", async () => {
  for (const roles of [[], ["pricing_admin"], ["local_pricelist_admin"], ["localline_push"],
    ["localline_pull"], ["membership_admin", "localline_push"], ["pricing_admin", "square_push"]]) {
    assert.equal(canPublishInventory(roles), false, roles.join(","));
    await assert.rejects(saveInventoryToLocalLine(7, { inventory: 5 }, { adminRoles: roles }), { status: 403 });
  }
});

test("inventory admins cannot publish other product fields through the inventory endpoint", async () => {
  for (const changes of [{ inventory: 5, onSale: 1 }, { sourceUnitPrice: 12 }, { description: "Updated" }, { images: [] }]) {
    await assert.rejects(saveInventoryToLocalLine(7, changes, { adminRoles: ["inventory_admin"] }), /stock, inventory tracking, and visibility only/);
  }
});

test("direct inventory updates reject all other product fields and invalid stock", () => {
  assert.deepEqual(inventoryChanges({inventory:0,trackInventory:true}),{inventory:0,trackInventory:1});
  assert.deepEqual(inventoryChanges({visible:false}),{visible:0});
  assert.deepEqual(inventoryChanges({visible:true}),{visible:1});
  for (const changes of [{}, {visible:2}, {visible:null}, {onSale:1}, {images:[]}, {inventory:1,sourceUnitPrice:10},
    {inventory:-1}, {inventory:1.5}, {inventory:true}, {inventory:null}, {inventory:"2"}, {trackInventory:2}]) {
    assert.throws(()=>inventoryChanges(changes));
  }
});
