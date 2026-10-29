import test from 'node:test';
import assert from 'node:assert/strict';
import {workbookMarkupPlan,matchingProducePresets} from './workbookMarkupPlan.mjs';
const product={id:1,name:'Carrots',vendor:'Farm',category:'Roots',packages:[{id:10},{id:11}]};
const row={row:2,'Product ID':'1.0',Product:'Carrots',Vendor:'Farm','Package ID':'10.0','New markup':'0.65'};
const plan=(rows=[row],catalog=[product])=>workbookMarkupPlan({rows},catalog);
test('workbook percentages become named presets, grouped once per product',()=>{
 const [result]=plan([row,{...row,row:3,'Package ID':11}]);
 assert.equal(result.status,'matched');assert.equal(result.target,'perishable');assert.equal(result.bp,6500);assert.deepEqual(result.sourceRows,[2,3]);
 assert.equal(plan([{...row,'New markup':.5}])[0].target,'shelfStable');
 assert.equal(plan([{...row,'New markup':1}])[0].target,'highlyPerishable');
});
test('additional matches require an unambiguous produce name, real vendor and no special pricing',()=>{
 const products=[{...product,id:2,category:null},{...product,id:3,category:null,vendor:'Deck Family Farm'}, {...product,id:4,category:null,vendor:null}];
 assert.deepEqual(matchingProducePresets({rows:[row]},products).map(row=>row.id),[2]);
 assert.deepEqual(matchingProducePresets({rows:[row,{...row,'New markup':1}]},products),[]);
});
test('conflicts, missing vendors, wrong links and special prices are held',()=>{
 assert.equal(plan([row,{...row,'Package ID':11,'New markup':1}])[0].status,'held');
 for(const patch of [{vendor:null},{deleted:1},{name:'Other carrots'},{name:'Carrot deposit'}, {category:'Membership'},{packages:[]}])assert.equal(plan([row],[{...product,...patch}])[0].status,'held');
 assert.equal(plan([{...row,'New markup':.6}])[0].status,'held');
 assert.equal(plan([{...row,'Product ID':2}])[0].status,'held');
 assert.equal(plan([{...row,'New markup':''}]).length,0);
});
