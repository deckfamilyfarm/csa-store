import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
const socket=process.env.PRODUCT_SYNC_TEST_SOCKET;
test('cost plan persistence, snapshots, refresh and isolation',{skip:!socket},async t=>{
 assert.match(socket,/^\/(?:private\/)?tmp\/csa-product-sync-/);
 const database=`cost_plan_test_${process.pid}`;
 const root=await mysql.createConnection({socketPath:socket,user:'root'});
 await root.query(`CREATE DATABASE ${database}`);await root.end();
 Object.assign(process.env,{STORE_DB_HOST:'127.0.0.1',STORE_DB_PORT:'1',STORE_DB_DATABASE:database,STORE_DB_USER:'root',STORE_DB_PASSWORD:''});
 const {getPool}=await import('../db.js');const db=getPool();db.pool.config.connectionConfig.socketPath=socket;t.after(()=>db.end());
 t.mock.method(globalThis,'fetch',()=>{throw Error('Planning must not call external services');});
 for(const sql of [
 'CREATE TABLE products(id INT,name TEXT,vendor_id INT,category_id INT,is_deleted INT)',
 'CREATE TABLE vendors(id INT,name TEXT)', 'CREATE TABLE categories(id INT,name TEXT)',
 'CREATE TABLE packages(id INT,product_id INT,name TEXT,num_of_items INT)',
 'CREATE TABLE enterprise_bundle_legacy_products(product_id INT)',
 'CREATE TABLE enterprise_pricing_buy_price_drafts(product_id INT,price DECIMAL(14,4),purchasing_enterprise_id INT)',
 'CREATE TABLE enterprise_pricing_product_state(product_id INT,latest_revision_id INT)',
 'CREATE TABLE enterprise_pricing_revisions(id INT,input_json LONGTEXT,output_json LONGTEXT)'
 ])await db.query(sql);
 await db.query("INSERT INTO products VALUES(1,'Ground Beef',1,1,0)");await db.query("INSERT INTO vendors VALUES(1,'Deck Family Farm')");await db.query("INSERT INTO categories VALUES(1,'Beef')");await db.query("INSERT INTO packages VALUES(1,1,'1 lb',1)");await db.query('INSERT INTO enterprise_pricing_buy_price_drafts VALUES(1,12,1)');await db.query('INSERT INTO enterprise_pricing_product_state VALUES(1,1)');await db.query('INSERT INTO enterprise_pricing_revisions VALUES(1,?,?)',[JSON.stringify({pricingUnit:'lb',retailEnterpriseId:1,packages:[]}),JSON.stringify({buyFromTenThousandths:120000})]);
 const api=await import('./enterpriseCostPlans.js');
 assert.equal((await api.listCostPlans()).length,3);assert.equal((await api.listCostPlans()).length,3);
 const input={name:'Beef test',producer:'deck',unit:'lb',quantity:'100',cogs:'8.51',targetMargin:'23',groups:[{name:'Ground',share:'100',rows:[{productId:1,packageId:1,share:'100'}]}]};
 const first=await api.saveCostPlan(null,{input},{userId:1});assert.equal(first.output.current.revenue,1200);
 await db.query('UPDATE enterprise_pricing_buy_price_drafts SET price=13');
 const second=await api.saveCostPlan(first.id,{input:first.input,expectedRevision:1},{userId:1});assert.equal(second.output.current.revenue,1200);
 await assert.rejects(api.saveCostPlan(first.id,{input:first.input,expectedRevision:1},{userId:1}),e=>e.status===409);
 const preview=await api.prepareCostPlan(second.input,second.input,true);assert.equal(preview.output.current.revenue,1300);assert.equal(preview.changes.length,1);
 const refreshed=await api.saveCostPlan(first.id,{input:preview.input,expectedRevision:2,refresh:true},{userId:1});assert.equal(refreshed.output.current.revenue,1300);
 const copy=await api.saveCostPlan(null,{input:{...first.input,name:'Copy'}},{userId:1},first.input);assert.equal(copy.output.current.revenue,1200);
 await db.query('UPDATE enterprise_pricing_buy_price_drafts SET price=14');
 await assert.rejects(api.saveCostPlan(first.id,{input:refreshed.input,expectedRevision:3,refresh:true},{userId:1}),e=>e.status===409);
 assert.equal(Number((await db.query('SELECT price FROM enterprise_pricing_buy_price_drafts'))[0][0].price),14);
 assert.equal((await db.query('SELECT COUNT(*) n FROM enterprise_pricing_revisions'))[0][0].n,1);
 assert.equal((await db.query('SELECT COUNT(*) n FROM enterprise_cost_plan_revisions WHERE plan_id=?',[first.id]))[0][0].n,3);
});
