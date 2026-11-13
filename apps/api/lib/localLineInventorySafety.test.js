import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertNoUnsafeLocalLineStock} from './localLineInventorySafety.js';
import {patchLocalLineProduct} from '../localLine.js';
import {saveInventoryToLocalLine} from './inventorySync.js';
test('legacy absolute stock mutations remain held; dedicated saves require a baseline',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('No network call is permitted'));
 for(const payload of [{set_inventory:5},{inventory:5},{packages:[{id:1,set_inventory:5}]},{packages:[{id:1,current_inventory:5}]}]) {
  assert.throws(()=>assertNoUnsafeLocalLineStock(payload),{code:'LOCAL_LINE_STOCK_READ_ONLY'});
  await assert.rejects(patchLocalLineProduct(1,'test',payload),{code:'LOCAL_LINE_STOCK_READ_ONLY'});
 }
 await assert.rejects(saveInventoryToLocalLine(1,{inventory:5},{userId:1,adminRoles:['inventory_admin']}),{status:428});
 assert.doesNotThrow(()=>assertNoUnsafeLocalLineStock({visible:true,track_inventory:true,packages:[{id:1,unit_price:5}]}));
});

test('reviewed quantity transport sends exactly once even on server errors',async t=>{
 const {patchReviewedLocalLineInventory}=await import('../localLine.js');
 let attempts=0;
 t.mock.method(globalThis,'fetch',async()=>{attempts++;return new Response('unavailable',{status:503});});
 await assert.rejects(patchReviewedLocalLineInventory(1,'test',{set_inventory:5}),/503/);
 assert.equal(attempts,1);
 for(const payload of [{set_inventory:-1},{set_inventory:2,unit_price:3},{packages:[{id:2,set_inventory:1,unit_price:3}]}]) {
  await assert.rejects(patchReviewedLocalLineInventory(1,'test',payload),/Invalid reviewed/);
 }
 assert.equal(attempts,1);
});
