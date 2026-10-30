import test from 'node:test';
import assert from 'node:assert/strict';
import {productBasketFlags} from './productBasketEligibility.js';
import {validateProductBasketMappings,expectedLocalLineLists} from './localLinePricingLists.js';
import {buildLocalLineCreatePayload,buildLocalLinePricePayload} from '../localLine.js';
const remote=ids=>({packages:[{id:10,price_list_entries:ids.map(id=>({price_list:id,id:100+id}))}]});
test('Creamy Cow defaults to Guest exclusion and explicitly reviewed hard cheeses can be included',()=>{
 assert.equal(productBasketFlags({},'Creamy Cow, LLC').excludeFromGuest,true);
 assert.equal(productBasketFlags({excludeFromGuest:false},'Creamy Cow, LLC').excludeFromGuest,false);
 assert.deepEqual(productBasketFlags({},'Other',{excludeFromSnap:true,excludeFromGuest:false}),{excludeFromSnap:true,excludeFromGuest:false});
 assert.throws(()=>productBasketFlags({excludeFromSnap:'false'}),/must be/);
});
test('new excluded products omit those baskets from both creation and the staged price preview',()=>{
 Object.assign(process.env,{LL_PRICE_LIST_GUEST_ID:'1',LL_PRICE_LIST_HERDSHARE_ID:'3',LL_PRICE_LIST_SNAP_ID:'4',LL_PRICE_LIST_CSA_MEMBERS_ID:'2'});
 const context={product:{id:1,name:'Home goods',vendorId:2,excludeFromSnap:true},vendor:{id:2,name:'Maker'},packages:[{id:10,name:'each',price:10,unit:'each',numOfItems:1}],packageMeta:[],localLineVendorId:20,profile:{},imageUrls:[]};
 const creation=buildLocalLineCreatePayload(context,[{id:5,name:'Each',unit_type:'item'}]);
 assert.deepEqual(creation.product_price_list_entries.map(e=>e.price_list),[1,3]);
 assert.deepEqual(creation.packages[0].price_list_entries.map(e=>e.price_list),[1,3]);
 const staged={packages:[{id:10,price_list_entries:[1,3].map(id=>({price_list:id,product_price_list_entry:-id,adjustment_type:2}))}]};
 const preview=buildLocalLinePricePayload(context,staged);
 assert.deepEqual(preview.packages[0].price_list_entries.map(e=>e.price_list),[1,3]);
});
test('explicit exclusions allow two-basket pricing without silently enrolling products',()=>{
 assert.deepEqual(expectedLocalLineLists({excludeFromGuest:true},[1,3,4]),[3,4]);
 assert.doesNotThrow(()=>validateProductBasketMappings(remote([3,4]),{excludeFromGuest:true},'Creamy Cow',[1,3,4]));
 assert.doesNotThrow(()=>validateProductBasketMappings(remote([1,3]),{excludeFromSnap:true},'Home goods',[1,3,4]));
 assert.doesNotThrow(()=>validateProductBasketMappings(remote([1,3,4]),{excludeFromGuest:false},'Creamy Cow',[1,3,4]));
 assert.throws(()=>validateProductBasketMappings(remote([1,3,4]),{excludeFromGuest:true},'Milk',[1,3,4]),/availability differs/);
 assert.throws(()=>validateProductBasketMappings(remote([3,4]),{excludeFromGuest:false},'Cheese',[1,3,4]),/availability differs/);
 assert.throws(()=>validateProductBasketMappings(remote([]),{excludeFromGuest:true,excludeFromSnap:true},'Item',[1,3,4]),/valid active/);
});
