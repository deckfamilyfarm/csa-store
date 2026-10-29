import test from 'node:test';
import assert from 'node:assert/strict';
import { markupPresetAssignment } from './markupPresetPlan.mjs';
const row = { name:'Product',vendorName:'Other Farm',output:{appliedMarkupBp:4500} };
test('Deck and Hyland take priority; deposits and memberships never change',()=>{
 for (const vendorName of ['Deck Family Farm','Hyland Processing Prices',"Deck Family Farm's Hyland Artisinal Meats"]) {
   assert.equal(markupPresetAssignment({...row,vendorName}),'deckHyland');
   for (const name of ['Animal Side Deposit','Membership Fee','Harvester CSA Membership']) assert.equal(markupPresetAssignment({...row,vendorName,name}),null);
 }
 assert.equal(markupPresetAssignment({...row,categoryName:'Membership'}),null);
 assert.equal(markupPresetAssignment({...row,vendorName:'Creamy Cow',output:{appliedMarkupBp:7000}}),null);
});
test('43–48% inclusive uses configured markup, with no margin or retail-override guessing',()=>{
 for(const bp of [4300,4500,4800])assert.equal(markupPresetAssignment({...row,output:{appliedMarkupBp:bp}}),'shelfStable');
 for(const bp of [4299,4801,0])assert.equal(markupPresetAssignment({...row,output:{appliedMarkupBp:bp,effectiveMarkupBp:4500}}),null);
 assert.equal(markupPresetAssignment({...row,output:null,sourceMarkupBp:4500}),'shelfStable');
 assert.equal(markupPresetAssignment({...row,output:{appliedMarkupBp:6000},input:{markupCategory:'perishable',customMarkupBp:null}}),'perishable');
 assert.equal(markupPresetAssignment({...row,output:{appliedMarkupBp:6000},input:{markupCategory:'perishable',customMarkupBp:6000}}),null);
});
