import assert from 'node:assert/strict';
import test from 'node:test';
import { CART_KEY, readCart, saveCart, addToCart, cartLines, cartMatches, rememberCheckoutCart, settleCheckoutCart, turkeyLink, turkeyRoute, sortTurkeyOptions } from './turkeyCart.js';
import { descriptionBlocks } from './productDescriptionText.js';
const browser = () => { const entries = new Map(); return {localStorage:{getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)}}; };
const option = {id:1008413,label:'White small turkey',preorderBreed:'broad-breasted-white',priceCents:9500,available:3};
test('cart retains exact variant, merges additions, and validates total quantity and current price', () => {
  const cart = addToCart([], option, 1);
  assert.deepEqual(addToCart(cart, option, 2), [{optionId:1008413,quantity:3,expectedPriceCents:9500}]);
  assert.throws(()=>addToCart(cart, option,3), /available stock/);
  assert.throws(()=>addToCart(cart, option,1.5), /quantity/);
  assert.throws(()=>addToCart(cart, {...option,priceCents:10000},1), /price changed/);
  assert.equal(cartLines(cart,{options:[option]})[0].issue,'');
  assert.match(cartLines(cart,{options:[]})[0].issue,/no longer available/);
  assert.match(cartLines(cart,{options:[{...option,available:0}]})[0].issue,/Only 0/);
  assert.equal(cartLines(cart,{options:[{...option,priceCents:10000}]})[0].priceChanged,true);
});
test('cart persists only variant IDs, quantities and displayed prices, and rejects corrupt storage', () => {
  const store=browser(), cart=addToCart([],option,1);
  saveCart([{...cart[0],customer:{email:'private@example.com'},token:'secret'}],store);
  assert.deepEqual(readCart(store),cart);
  assert.doesNotMatch(store.localStorage.getItem(CART_KEY),/private|secret|customer/);
  store.localStorage.setItem(CART_KEY,'corrupt'); assert.deepEqual(readCart(store),[]);
  store.localStorage.setItem(CART_KEY,JSON.stringify([{optionId:1,quantity:-1,expectedPriceCents:100}])); assert.deepEqual(readCart(store),[]);
});
test('confirmed payment clears only its matching cart once, while expiry and other carts survive', () => {
  const store=browser(),cart=addToCart([],option,1);
  saveCart(cart,store); rememberCheckoutCart('a',cart,store);
  assert.equal(settleCheckoutCart({id:'a',status:'reserved'},store),false);
  assert.deepEqual(readCart(store),cart);
  assert.equal(settleCheckoutCart({id:'a',status:'paid'},store),true);
  assert.deepEqual(readCart(store),[]);
  saveCart(cart,store); assert.equal(settleCheckoutCart({id:'a',status:'paid'},store),false);
  rememberCheckoutCart('b',cart,store); assert.equal(settleCheckoutCart({id:'b',status:'expired'},store),false);
  assert.deepEqual(readCart(store),cart);
  rememberCheckoutCart('c',cart,store); saveCart(addToCart(cart,option,1),store);
  assert.equal(settleCheckoutCart({id:'c',status:'paid'},store),false);
  assert.equal(readCart(store)[0].quantity,2);
  assert.equal(cartMatches(cart,[{optionId:option.id,quantity:1,priceCents:9500}]),true);
});
test('white variants sort before heritage, ascending price, and preview follows navigation', () => {
  assert.deepEqual(sortTurkeyOptions([{...option,id:1,priceCents:13000},{...option,id:2,preorderBreed:'heritage',priceCents:10500},option]).map(row=>row.id),[1008413,1,2]);
  assert.equal(turkeyLink('product',true),'#/turkeys/product?preview=1');
  assert.equal(turkeyRoute(turkeyLink('cart',true)),'cart');
});
test('plain text paragraphs and bullet lists retain their content without becoming markup', () => {
  assert.deepEqual(descriptionBlocks('Our turkeys.\nRaised here.\n\n- First benefit\n- Second benefit\n\nPickup Saturday.'),[
    {type:'paragraph',lines:['Our turkeys.','Raised here.']},{type:'list',lines:['First benefit','Second benefit']},{type:'paragraph',lines:['Pickup Saturday.']}
  ]);
});
