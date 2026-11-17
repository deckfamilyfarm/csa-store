import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchLocalLineOrdersPage} from '../localLine.js';

test('operational order reads preserve explicit date scopes and allow slow read responses',async t=>{
 const old={username:process.env.LL_USERNAME,password:process.env.LL_PASSWORD};
 process.env.LL_USERNAME='read-test';process.env.LL_PASSWORD='read-test';
 t.after(()=>{for(const [key,value] of [['LL_USERNAME',old.username],['LL_PASSWORD',old.password]])value===undefined?delete process.env[key]:process.env[key]=value;});
 const timeouts=[],timeout=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return timeout(ms);});
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.endsWith('/token/'))return new Response(JSON.stringify({access:'test-access'}));
  const q=new URL(url).searchParams;
  assert.equal(q.get('fulfillment_date_start'),'2026-11-01');assert.equal(q.get('fulfillment_date_end'),'2026-11-17');
  assert.equal(q.get('page'),'2');assert.equal(q.get('page_size'),'25');assert.equal(q.get('ordering'),'-id');
  return new Response(JSON.stringify({count:1,results:[{id:1}],next:null}));
 });
 assert.equal((await fetchLocalLineOrdersPage({page:2,pageSize:25,dateFilters:{fulfillment_date_start:'2026-11-01',fulfillment_date_end:'2026-11-17'}})).results[0].id,1);
 assert.equal(timeouts.at(-1),60000);
 await assert.rejects(fetchLocalLineOrdersPage({dateFilters:{unknown:'2026-11-01'}}),/Invalid Local Line order date filter/);
});
