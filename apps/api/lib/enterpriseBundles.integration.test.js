import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import express from 'express';
const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test('bundle import, local editing, dependent pricing, history and permission boundaries', {skip:!socket}, async t => {
  assert.match(socket,/^\/(?:private\/)?tmp\/csa-product-sync-/);
  const database=`csa_bundles_test_${process.pid}_${Date.now()}`;
  const root=await mysql.createConnection({socketPath:socket,user:'root'});
  await root.query(`CREATE DATABASE \`${database}\``);await root.end();
  Object.assign(process.env,{STORE_DB_HOST:'127.0.0.1',STORE_DB_PORT:'1',STORE_DB_DATABASE:database,STORE_DB_USER:'root',STORE_DB_PASSWORD:'',CSA_LOCAL_ONLY:'false'});
  const {getPool}=await import('../db.js');const pool=getPool();pool.pool.config.connectionConfig.socketPath=socket;
  process.env.CSA_LOCAL_ONLY='true';
  t.after(()=>pool.end());
  for(const sql of [
    'CREATE TABLE vendors(id INT PRIMARY KEY,name VARCHAR(255))',
    'CREATE TABLE categories(id INT PRIMARY KEY,name VARCHAR(255))',
    'CREATE TABLE products(id INT PRIMARY KEY,name VARCHAR(255),vendor_id INT,category_id INT,is_deleted INT,track_inventory INT,inventory INT)',
    'CREATE TABLE packages(id INT PRIMARY KEY,product_id INT,name VARCHAR(255),track_inventory INT,inventory INT,num_of_items INT,track_type VARCHAR(30))',
    'CREATE TABLE local_line_product_meta(product_id INT,local_line_product_id INT)',
    'CREATE TABLE local_line_package_meta(package_id INT,local_line_package_id INT)'
  ])await pool.query(sql);
  const {ensureEnterprisePricingSchema}=await import('./enterprisePricingSchema.js');await ensureEnterprisePricingSchema();
  await pool.query("INSERT INTO vendors VALUES (1,'Farm')");
  await pool.query("INSERT INTO products VALUES (1,'Pork',1,NULL,0,1,20),(2,'Beef',1,NULL,0,1,30),(3,'Legacy bundle',1,NULL,0,0,0)");
  await pool.query("INSERT INTO packages VALUES (10,1,'1 lb',0,NULL,1,'package'),(20,2,'1 lb',0,NULL,1,'package')");
  await pool.query('INSERT INTO local_line_product_meta VALUES(3,300)');
  await pool.query('INSERT INTO local_line_package_meta VALUES(10,100),(20,200)');
  for(const [id,packageId,cents]of [[1,10,1080],[2,20,1260]]){
    await pool.query("INSERT INTO enterprise_pricing_revisions(id,product_id,settings_version_id,status,input_json,output_json,editor_id,created_at) VALUES (?,?,1,'local-preview','{}',?,1,UTC_TIMESTAMP())",[id,id,JSON.stringify({packages:[{packageId,localLineRegularCents:cents,localLineSaleCents:cents}]})]);
    await pool.query('INSERT INTO enterprise_pricing_product_state VALUES (?,?,?,NULL,UTC_TIMESTAMP())',[id,id,id]);
  }
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,options)=>{assert.equal(new URL(url).hostname,'127.0.0.1','No external requests');return originalFetch(url,options);});
  const service=await import('./enterpriseBundles.js');
  const source={id:99,name:'Beef & Pork',vendor:11,description:'<p>Four pounds</p>',visible:true,track_inventory:true,inventory_type:'static',inventory:0,price:26.73,images:[],
    box_contents:[{content_product_packages:[{product_package:100,quantity:2,swaps:[]},{product_package:200,quantity:2,swaps:[]}]}],
    product_price_list_entries:[1,2,3,4].map(id=>({price_list:id,price_list_name:String(id),box_package_entry:{adjustment:true,adjustment_type:3,adjustment_value:40}}))};
  const snapshot={boxes:[source],vendors:[{id:11,name:'Farm'}],legacyProductIds:[300],capturedAt:new Date().toISOString()};
  const first=await service.importLocalBundles(snapshot,{userId:1});assert.equal(first.imported.length,1);
  const again=await service.importLocalBundles(snapshot,{userId:1});assert.equal(again.skipped.length,1);
  const id=first.imported[0].id,initial=await service.getBundle(id);assert.equal(initial.output.priceCents,4446);assert.equal(initial.type,'bundle');
  const changed={...initial.input,discountPercent:10,visible:false};
  const preview=await service.previewBundle(changed);
  await service.saveBundle(id,{input:changed,expectedRevision:1,pricingHash:preview.pricingHash},{userId:1});
  let current=await service.getBundle(id);assert.equal(current.output.priceCents,4212);assert.equal(current.input.buyPrice,'26.73');assert.equal(current.input.visible,false);assert.equal(current.history.length,2);
  await assert.rejects(()=>service.saveBundle(id,{input:changed,expectedRevision:1,pricingHash:preview.pricingHash},{userId:1}),e=>e.status===409);
  const before=await service.previewBundle(current.input);
  await pool.query('UPDATE enterprise_pricing_revisions SET output_json=? WHERE id=1',[JSON.stringify({packages:[{packageId:10,localLineRegularCents:1000,localLineSaleCents:1000}]})]);
  assert.equal((await service.getBundle(id)).output.priceCents,4068,'Recalculate without rewriting purchase cost');
  await assert.rejects(()=>service.saveBundle(id,{input:changed,expectedRevision:2,pricingHash:before.pricingHash},{userId:1}),e=>e.status===409);
  await pool.query('UPDATE products SET is_deleted=1 WHERE id=1');
  assert.equal((await service.getBundle(id)).output.priceCents,null);
  await pool.query('UPDATE products SET is_deleted=0 WHERE id=1');
  const {default:router}=await import('../routes/enterprisePricing.js');
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.admin={userId:1,adminRoles:[req.headers['x-test-role']||'pricing_publisher']};next();});app.use('/pricing',router);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/pricing`;
  let response=await fetch(`${url}/bundles`);assert.equal(response.status,200);
  response=await fetch(`${url}/bundles/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:changed})});assert.equal(response.status,403,'Publish-only users cannot edit');
  response=await fetch(`${url}/bundles/preview`,{method:'POST',headers:{'Content-Type':'application/json','x-test-role':'pricing_editor'},body:JSON.stringify({input:changed})});assert.equal(response.status,200);
  response=await fetch(`${url}/bundles/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});assert.equal(response.status,403);
  response=await fetch(`${url}/bundles/${id}/publish`,{method:'POST'});assert.equal(response.status,404,'There is no accidental remote publish endpoint');
  current=await service.getBundle(id);assert.equal(current.input.buyPrice,'26.73');assert.equal(current.revision,2);
  const {assertLegacyPricingPublicationAllowed}=await import('./enterprisePricingService.js');
  await assert.rejects(()=>assertLegacyPricingPublicationAllowed([3]),e=>e.status===409&&/Bundles use native/.test(e.message));
});
