import test from 'node:test';import assert from 'node:assert/strict';
import {prepareBundlePatch,bundleRemoteState,componentPriceCents,assertBundlePilotAllowed} from './enterpriseBundlePublicationCore.js';
const remote=()=>({id:77,name:'Bundle',description:'',visible:true,vendor:2,price:12,ownership:'MANAGED',track_inventory:true,inventory_type:'dynamic',images:[],box_contents:[{id:77,content_product_packages:[{id:1,product_package:1000,quantity:2,swaps:[]}]}],product_price_list_entries:[1,2,3,4].map(id=>({id,price_list:id,box_package_entry:{id,adjustment:true,adjustment_type:2,adjustment_value:50,on_sale:false}}))});
const bundle={input:{name:'Bundle',description:'',visible:true,inventoryMode:'components',images:[]},output:{blockers:[],buyPriceCents:1200,priceCents:1900}};
test('pilot permission is restricted to explicitly named Local Line boxes',()=>{
 const enabled={LL_BUNDLE_PUBLICATION_ENABLED:'true',LL_BUNDLE_PILOT_BOX_IDS:'1173, 2260'};
 assert.doesNotThrow(()=>assertBundlePilotAllowed(2260,enabled));
 for(const env of [{},{...enabled,LL_BUNDLE_PUBLICATION_ENABLED:'false'},...['','*','2260,','2260,not-an-id','2260.0','9007199254740992'].map(ids=>({...enabled,LL_BUNDLE_PILOT_BOX_IDS:ids}))])assert.throws(()=>assertBundlePilotAllowed(2260,env),/enabled pilot/);
 assert.throws(()=>assertBundlePilotAllowed(1244,enabled),/enabled pilot/);
});
test('managed component sales require exact selling and crossed-out prices; legacy flags remain blocked',()=>{
 const entry={adjustment:true,adjustment_type:3,adjustment_value:8.64,on_sale_toggle:true,strikethrough_display_value:10.80};
 const promotion={id:1,regularCents:1080,saleCents:864};
 assert.equal(componentPriceCents({id:1},entry,promotion),864);
 assert.throws(()=>componentPriceCents({id:1},entry),/Resolve component sales/);
 for(const change of [{on_sale_toggle:false},{strikethrough_display_value:10.76},{adjustment_value:8.61},{adjustment_type:2}])assert.throws(()=>componentPriceCents({id:1},{...entry,...change},promotion),/managed component sale/);
 assert.throws(()=>componentPriceCents({id:1},entry,{...promotion,regularCents:864}),/managed component sale/);
});
test('bundle patch preserves buy price and inventory and updates exactly three active basket prices',()=>{const p=prepareBundlePatch(bundle,remote(),[1,3,4],2,[{remotePackageId:1000,quantity:2}]);assert.ok(p.patch.every(p=>p.path.startsWith('/product_price_list_entries/')));assert.deepEqual(p.expected.lists.map(p=>p.value),[19,50,19,19]);assert.equal(p.expected.price,1200);});
test('component edits are explicit, while swaps, missing baskets and inventory changes hold publication',()=>{const p=prepareBundlePatch(bundle,remote(),[1,3,4],2,[{remotePackageId:1000,quantity:3}]);assert.ok(p.patch.some(p=>p.path==='/box_contents/0/content_product_packages'));const r=remote();r.has_swaps=true;assert.throws(()=>prepareBundlePatch(bundle,r,[1,3,4],2,[]),/swappable/);assert.throws(()=>prepareBundlePatch(bundle,remote(),[1,3,5],2,[]),/basket mapping/);assert.throws(()=>prepareBundlePatch({...bundle,input:{...bundle.input,inventoryMode:'separate'}},remote(),[1,3,4],2,[]),/Inventory/);});
test('changing available inventory does not invalidate a price baseline; changing components does',()=>{const r=remote(),before=bundleRemoteState(r);r.inventory=99;r.box_contents[0].content_product_packages[0].available_inventory=2;assert.deepEqual(bundleRemoteState(r),before);r.box_contents[0].content_product_packages[0].quantity=3;assert.notDeepEqual(bundleRemoteState(r),before);assert.equal(componentPriceCents({id:1},{adjustment:true,adjustment_type:3,adjustment_value:'10.00'}),1000);assert.throws(()=>componentPriceCents({id:1},{on_sale:true}),/sales/);});
