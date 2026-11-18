import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanCart,cartKey,cartAfterPayment,rememberAccess,orderAccess,readPending,merchandiseCartLines,MERCH_PENDING} from './merchandiseCart.js';
import {usesMerchandiseStorefront,usesTurkeyStorefront,usesAdminPortal} from '../storefrontRouting.js';
test('merchandise storage keeps only IDs, counts and displayed prices; duplicate/invalid rows are rejected',()=>{
  const row={variantId:1,quantity:1,expectedPriceCents:1000,email:'private@example.com'};
  assert.deepEqual(cleanCart([row,row,{variantId:2,quantity:-1,expectedPriceCents:1000}]),[{variantId:1,quantity:1,expectedPriceCents:1000}]);
});
test('payment clears only the matching saved cart and guest access expires',()=>{
  const cart=[{variantId:1,quantity:1,expectedPriceCents:1000}],pending={orderId:'one',cartKey:cartKey(cart)};
  assert.deepEqual(cartAfterPayment(cart,pending,{id:'two',paid:true}),cart);
  assert.deepEqual(cartAfterPayment(cart,pending,{id:'one',paid:true}),[]);
  const map=new Map(),storage={getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};
  rememberAccess(storage,'one','a'.repeat(64),100);assert.equal(orderAccess(storage,'one',101),'a'.repeat(64));assert.equal(orderAccess(storage,'one',8*86400000),null);
  storage.setItem(MERCH_PENDING,JSON.stringify({token:'invalid',quoteId:'q',expiresMs:500}));assert.equal(readPending(storage,100),null);
});
test('merchandise routes preserve existing turkey, admin and password recovery entry points',()=>{
  assert.equal(usesMerchandiseStorefront('https://store.deckfamilyfarm.com/#/merchandise/order?order=one'),true);
  assert.equal(usesMerchandiseStorefront('http://localhost:5173/merchandise'),true);
  assert.equal(usesTurkeyStorefront('https://turkeys.deckfamilyfarm.com/'),true);
  assert.equal(usesMerchandiseStorefront('https://turkeys.deckfamilyfarm.com/'),false);
  assert.equal(usesMerchandiseStorefront('https://admin.deckfamilyfarm.com/#/merchandise'),false);
  assert.equal(usesAdminPortal('https://admin.deckfamilyfarm.com/#/merchandise'),true);
  assert.equal(usesMerchandiseStorefront('https://store.deckfamilyfarm.com/merchandise#/reset-password'),false);
});
test('cart review identifies price changes and unavailable items and uses the matching photo',()=>{
  const cart=[{variantId:1,quantity:2,expectedPriceCents:2500},{variantId:2,quantity:1,expectedPriceCents:1000}];
  const catalog={products:[{name:'Farm cap',images:[{src:'other-color'},{src:'navy',variantIds:[1]}],variants:[{id:1,title:'Navy',retailCents:3000}]}]};
  const [changed, removed]=merchandiseCartLines(cart,catalog);
  assert.equal(changed.priceChanged,true);
  assert.equal(changed.expectedPriceCents,2500);
  assert.equal(changed.variant.imageUrl,'navy');
  assert.equal(removed.unavailable,true);
  assert.equal(merchandiseCartLines([{...cart[0],expectedPriceCents:3000}],catalog)[0].priceChanged,false);
  const [held]=merchandiseCartLines(cart,catalog,[{variantId:1,code:'supplier_review'}]);
  assert.equal(held.issue,'supplier_review');
});
