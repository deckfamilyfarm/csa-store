import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memberCommandKey} from './memberCommands.js';
test('uncertain billing commands keep the same key across reloads and isolate member identities',()=>{
 const map=new Map(),storage={getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
 const first=memberCommandKey(storage,1,'subscription',{plan:'a'},()=> 'request-1');
 assert.equal(memberCommandKey(storage,1,'subscription',{plan:'a'},()=> 'request-2').key,first.key);
 assert.throws(()=>memberCommandKey(storage,1,'subscription',{plan:'b'}),/previous billing/);
 assert.equal(memberCommandKey(storage,2,'subscription',{plan:'b'},()=> 'request-2').key,'request-2');
 first.complete();assert.equal(memberCommandKey(storage,1,'subscription',{plan:'b'},()=> 'request-3').key,'request-3');
});
