import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {getTableConfig} from 'drizzle-orm/mysql-core';
import * as schema from '../schema.js';
import {syncLocalLineOrdersToStore} from './localLineAutomationSync.js';
const socket=process.env.PRODUCT_SYNC_TEST_SOCKET;
test('the actual order pull revisits old IDs, reconciles changed entries and refreshes both reporting months',{skip:!socket},async t=>{
 assert.match(socket,/^\/(private\/)?tmp\/csa-product-sync-/);
 t.mock.method(globalThis,'fetch',()=>assert.fail('No provider network access'));
 const root=await mysql.createConnection({socketPath:socket,user:'root'}),database=`csa_order_test_${process.pid}`;
 await root.query(`CREATE DATABASE \`${database}\``);
 const pool=mysql.createPool({socketPath:socket,user:'root',database});
 t.after(async()=>{await pool.end();await root.query(`DROP DATABASE \`${database}\``);await root.end();});
 for(const table of [schema.localLineOrders,schema.localLineOrderEntries,schema.localLineSyncCursors,schema.localLineOrderReportingEntries]){
  const c=getTableConfig(table),columns=c.columns.map(col=>`\`${col.name}\` ${col.getSQLType()}${col.notNull?' NOT NULL':''}${col.autoIncrement?' AUTO_INCREMENT':''}${col.primary?' PRIMARY KEY':''}${col.default!==undefined && (typeof col.default!=='object'||col.default===null)?` DEFAULT ${pool.escape(col.default)}`:''}`);
  for(const index of c.indexes.filter(index=>index.config.unique))columns.push(`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map(col=>`\`${col.name}\``).join(',')})`);
  await pool.query(`CREATE TABLE \`${c.name}\` (${columns.join(',')}) ENGINE=InnoDB`);
 }
 const old={id:1,created_at:'2025-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',status:'OPEN',customer_id:1,payment:{status:'PAID',store_credit_amount:10},
  fulfillment:{fulfillment_date:'2026-09-15'},total:10,order_entries:[{id:10,product:10,unit_quantity:1,total_price:10}]};
 const newer={...old,id:1000,created_at:'2026-10-01T00:00:00Z',order_entries:[]};
 let pages=[[newer],[old]],calls=[],months=[];
 const dependencies={pool,fetchOrders:async({page})=>{calls.push(page);return {results:structuredClone(pages[page-1] || []),count:2,next:page<pages.length?'next':null};},
  syncReporting:async({monthKeys})=>{months=monthKeys;return {refreshedMonths:monthKeys};}};
 const run=()=>syncLocalLineOrdersToStore({includeSubscriberSnapshot:false},dependencies);
 assert.equal((await run()).stored,2);
 pages=[[newer],[{...old,updated_at:'2026-10-02T00:00:00Z',fulfillment:{fulfillment_date:'2026-10-15'},total:15,order_entries:[{id:11,product:10,unit_quantity:2,total_price:15}]}]];
 calls=[];assert.equal((await run()).stored,1);assert.deepEqual(calls,[1,2]);
 assert.ok(months.includes('2026-09') && months.includes('2026-10'));
 assert.equal(Number((await pool.query('SELECT total FROM local_line_orders WHERE local_line_order_id=1'))[0][0].total),15);
 assert.deepEqual((await pool.query('SELECT local_line_order_entry_id FROM local_line_order_entries WHERE local_line_order_id=1'))[0].map(row=>row.local_line_order_entry_id),[11]);
 assert.equal((await run()).stored,0,'Identical order pages do not rewrite orders or entries');
 pages=[[newer],[old]];assert.equal((await run()).stored,0,'Stale provider snapshots cannot undo the changed order');
 assert.equal(Number((await pool.query('SELECT total FROM local_line_orders WHERE local_line_order_id=1'))[0][0].total),15);
 pages=[[newer],[{...old,updated_at:'2026-10-02T00:00:00Z',total:16}]];
 assert.equal((await run()).heldOrders[0].orderId,1);
});
