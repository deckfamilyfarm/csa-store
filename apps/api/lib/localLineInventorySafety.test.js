import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertNoUnsafeLocalLineStock} from './localLineInventorySafety.js';
import {patchLocalLineProduct} from '../localLine.js';
import {saveInventoryToLocalLine} from './inventorySync.js';
test('every absolute stock mutation is held before transport, including old reviewed actions',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('No network call is permitted'));
 for(const payload of [{set_inventory:5},{inventory:5},{packages:[{id:1,set_inventory:5}]},{packages:[{id:1,current_inventory:5}]}]) {
  assert.throws(()=>assertNoUnsafeLocalLineStock(payload),{code:'LOCAL_LINE_STOCK_READ_ONLY'});
  await assert.rejects(patchLocalLineProduct(1,'test',payload),{code:'LOCAL_LINE_STOCK_READ_ONLY'});
 }
 await assert.rejects(saveInventoryToLocalLine(1,{inventory:5},{userId:1,adminRoles:['inventory_admin']}),{code:'LOCAL_LINE_STOCK_READ_ONLY'});
 assert.doesNotThrow(()=>assertNoUnsafeLocalLineStock({visible:true,track_inventory:true,packages:[{id:1,unit_price:5}]}));
});
