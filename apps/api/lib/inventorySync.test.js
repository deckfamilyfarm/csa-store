import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryConflict, inventoryChanges, saveInventoryToLocalLine } from "./inventorySync.js";
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


test('stock edits reject diminished remote quantities and changed tracking baselines',()=>{
  const remote={inventory:3,track_inventory:true};
  assert.equal(inventoryConflict(remote,{inventory:3,trackInventory:true}),null);
  assert.equal(inventoryConflict(remote,{inventory:5,trackInventory:true}).inventory,3);
  assert.equal(inventoryConflict({...remote,track_inventory:false},{inventory:3,trackInventory:true}).trackInventory,false);
  for(const baseline of [null,{}, {inventory:'3',trackInventory:true}]) assert.throws(()=>inventoryConflict(remote,baseline),{status:428});
});

test('package stock targets exact mapped packages and keeps product totals separate', async()=>{
 const {remoteInventory,stockPayload}=await import('./inventorySnapshot.js');
 const remote={inventory_type:'package',inventory:0,track_inventory:true,packages:[{id:8,name:'ea',current_inventory:9},{id:9,name:'Box',current_inventory:2}]};
 const mappings=[{packageId:80,remoteId:8},{packageId:90,remoteId:9}];
 const before=remoteInventory(remote,mappings);assert.equal(before.inventory,null);assert.equal(before.packages[0].inventory,9);
 assert.deepEqual(stockPayload(remote,{packageInventory:[{packageId:80,inventory:5}]},before,mappings).payload,{packages:[{id:8,set_inventory:5},{id:9}]});
 remote.packages[1].current_inventory=1;
 assert.equal(stockPayload(remote,{packageInventory:[{packageId:80,inventory:5}]},before,mappings).conflict,undefined,'unmodified sibling sales do not block or get overwritten');
 remote.packages[0].current_inventory=3;
 assert.equal(stockPayload(remote,{packageInventory:[{packageId:80,inventory:5}]},before,mappings).conflict.packages[0].inventory,3);
 assert.throws(()=>stockPayload(remote,{inventory:5},before,mappings),/by package/);
 assert.equal(inventoryConflict({...remote,inventory_type:'product'},before,mappings).inventoryType,'product');
 assert.equal(inventoryConflict(remote,before,[{packageId:80,remoteId:9}], [{packageId:80}]).packages[0].packageId,null);
});
