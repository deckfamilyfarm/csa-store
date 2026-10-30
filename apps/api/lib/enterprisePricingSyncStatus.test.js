import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPricingSyncFilter, pricingSyncStatus, readPricingChannelRecords } from './enterprisePricingSyncStatus.js';
const revision = { input: { squareEnabled: true, pricingUnit: 'each' }, output: { squareUnitCents: 1000,
  packages: [{ packageId: 7, localLineRegularCents: 900, squareVariationCents: 1000 }] }, localOnly: true };
const record = { packages: [{ id: 7, name: 'Sausage', metadata: { localLinePackageId: 70 } }],
  localLinePrices: ['Guest Basket', 'CSA Members', 'Herd Share Members', 'SNAP'].map(listName => ({ packageId: 7, listName, finalPrice: '9.00' })),
  squarePrices: [{ packageId: 7, priceCents: 1000, rawJson: { item_variation_data: {} } }] };
const orange = result => result.channels.filter(row => row.state === 'attention').map(row => row.label);

test('sync filters use destination status and distinguish fixed deposits from missing inputs', () => {
 const row = {...revision,sync:pricingSyncStatus(revision,record)};
 assert.equal(matchesPricingSyncFilter(row,'synced'),true);
 assert.equal(matchesPricingSyncFilter(row,'inputs'),false);
 assert.equal(matchesPricingSyncFilter(row,'localline'),false);
 const changed = {...row,sync:pricingSyncStatus(revision,{...record,localLinePrices:[]})};
 assert.equal(matchesPricingSyncFilter(changed,'localline'),true);
 assert.equal(matchesPricingSyncFilter(changed,'square'),false);
 assert.equal(matchesPricingSyncFilter(changed,'synced'),false);
 assert.equal(matchesPricingSyncFilter({output:null,fixedDeposit:true},'inputs'),false);
 assert.equal(matchesPricingSyncFilter({output:null},'inputs'),true);
});

test('green requires all applicable prices to match; imported data is identified', () => {
 const result = pricingSyncStatus(revision, record);
 assert.equal(result.allMatched, true); assert.equal(result.basis, 'imported');
 assert(result.channels.every(row => row.reason.includes('imported')));
 assert.deepEqual(orange(pricingSyncStatus(revision, { ...record, localLinePrices: record.localLinePrices.map(p=>({...p,finalPrice:'8.00'})) })), ['LL']);
 assert.deepEqual(orange(pricingSyncStatus(revision, { ...record, squarePrices: [{ ...record.squarePrices[0],priceCents:1100 }] })), ['Sq']);
 assert.deepEqual(orange(pricingSyncStatus(revision, undefined)), ['LL','Sq']);
});
test('Square-disabled products never show Square, even with old mappings or publications', () => {
 const result = pricingSyncStatus({ ...revision, input:{squareEnabled:false}, publications:[{platform:'square',status:'failed'}] }, record);
 assert.equal(result.allMatched,true); assert.deepEqual(result.channels.map(c=>c.label),['LL']);
});
test('missing inputs, prices, basket coverage, mappings, and package changes cannot show green', () => {
 assert.equal(pricingSyncStatus({input:null,output:null},record).allMatched,false);
 assert.equal(pricingSyncStatus({...revision,output:{packages:[]}},record).allMatched,false);
 assert.deepEqual(orange(pricingSyncStatus(revision,{...record,localLinePrices:record.localLinePrices.slice(1)})),['LL']);
 assert.deepEqual(orange(pricingSyncStatus(revision,{...record,packages:[]})),['LL','Sq']);
 assert.equal(pricingSyncStatus({...revision,output:{...revision.output,packages:[{packageId:7,localLineRegularCents:null}]}},record).allMatched,false);
});
test('failed and pending publications stay orange; old verification never hides price drift', () => {
 assert.deepEqual(orange(pricingSyncStatus({...revision,publications:[{platform:'square',status:'failed'}]},record)),['Sq']);
 assert.deepEqual(orange(pricingSyncStatus({...revision,publications:[{platform:'localline',status:'publishing'}]},record)),['LL']);
 assert.deepEqual(orange(pricingSyncStatus({...revision,publications:[{platform:'square',status:'verified'}]}, {...record,squarePrices:[{...record.squarePrices[0],priceCents:1200}]})),['Sq']);
});
test('Square unit-only conflicts and location prices need review even when base prices match',()=>{
 assert.deepEqual(orange(pricingSyncStatus({...revision,input:{squareEnabled:true,pricingUnit:'lb'},publications:[{platform:'square',status:'verified'}]},record)),['Sq']);
 assert.deepEqual(orange(pricingSyncStatus(revision,{...record,squarePrices:[{...record.squarePrices[0],rawJson:null}]})),['Sq']);
 assert.deepEqual(orange(pricingSyncStatus(revision,{...record,squarePrices:[{...record.squarePrices[0],rawJson:{item_variation_data:{location_overrides:[{price_money:{amount:1200}}]}}}]})),['Sq']);
});
test('Square multipack comparisons use the actual variation price',()=>{
 const next={...revision,output:{...revision.output,packages:[{packageId:7,localLineRegularCents:900,squareVariationCents:6000}]}};
 assert.equal(pricingSyncStatus(next,{...record,squarePrices:[{...record.squarePrices[0],priceCents:6000}]}).allMatched,true);
});
test('active sales compare discounted LL prices while regular Square prices stay unchanged',()=>{
 const now=Date.parse('2026-10-28T12:00:00Z');
 const sale={status:'active',squareStatus:'verified',localLineStatus:'active',input:{channels:['localline','square'],startAt:'2026-10-28T00:00:00Z',endAt:'2026-10-29T00:00:00Z'},output:{localLinePrices:[{packageId:7,saleCents:720}]}};
 const discounted={...record,localLinePrices:record.localLinePrices.map(p=>({...p,finalPrice:'7.20'}))};
 assert.equal(pricingSyncStatus({...revision,promotions:[sale]},discounted,now).allMatched,true);
 assert.deepEqual(orange(pricingSyncStatus({...revision,promotions:[{...sale,squareStatus:'uncertain',status:'partial'}]},discounted,now)),['Sq']);
 assert.equal(pricingSyncStatus({...revision,promotions:[sale]},discounted,Date.parse('2026-10-30')).allMatched,false);
 const ongoing={...sale,input:{...sale.input,endAt:null}};
 assert.equal(pricingSyncStatus({...revision,promotions:[ongoing]},discounted,Date.parse('2099-10-30')).allMatched,true);
 assert.equal(pricingSyncStatus({...revision,promotions:[{...ongoing,status:'cancelling'}]},discounted,now).allMatched,false);
});
test('cached fixed-price contradictions cannot show green',()=>{
 assert.deepEqual(orange(pricingSyncStatus(revision,{...record,localLinePrices:record.localLinePrices.map(p=>({...p,adjustmentType:3,adjustmentValue:0}))})),['LL']);
});
test('channel reads are scoped SELECTs and deleted Square listings are unknown',async()=>{
 const calls=[];
 const pool={query:async(sql,args)=>{calls.push({sql,args});return [sql.includes('FROM packages')?[{id:7,productId:1,name:'Item',price:'9.00',remoteId:70}]:sql.includes('FROM local_line_price_list_entries')?[{productId:1,packageId:7,listName:'Guest Basket',finalPrice:'9.00'}]:[{productId:1,packageId:7,priceCents:1000,isDeleted:1}]];}};
 const records=await readPricingChannelRecords(pool,[1]);
 assert.equal(calls.length,3);assert(calls.every(call=>/^SELECT/.test(call.sql)&&call.args[0][0]===1));
 assert.equal(records.get(1).squarePrices[0].priceCents,null);
 assert.equal((await readPricingChannelRecords(pool,[])).size,0);assert.equal(calls.length,3);
});

test('a Local Line-only sale receipt turns LL green while Square remains pending',()=>{
 const sale={id:9,status:'pending',squareStatus:null,localLineStatus:'active',input:{channels:['localline','square'],startAt:'2026-01-01T00:00:00Z',endAt:null},output:{localLinePrices:[]}};
 const desiredSale={active:true,discountBp:1000,promotionId:9};
 const discounted={...record,localLinePrices:record.localLinePrices.map(p=>({...p,finalPrice:'8.10'}))};
 assert.deepEqual(orange(pricingSyncStatus({...revision,desiredSale,promotions:[sale]},discounted)),['Sq']);
 assert.deepEqual(orange(pricingSyncStatus({...revision,desiredSale,promotions:[{...sale,localLineStatus:null}]},discounted)),['LL','Sq']);
});
