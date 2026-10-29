import test from 'node:test';import assert from 'node:assert/strict';import mysql from 'mysql2/promise';
const socket=process.env.PRODUCT_SYNC_TEST_SOCKET;
test('bundle publication freezes review, holds drift and recovers a lost response without a second write',{skip:!socket},async t=>{
 assert.match(socket,/^\/(?:private\/)?tmp\/csa-product-sync-/);
 const database=`csa_bundle_publish_${process.pid}_${Date.now()}`,root=await mysql.createConnection({socketPath:socket,user:'root'});await root.query(`CREATE DATABASE \`${database}\``);await root.end();
 Object.assign(process.env,{STORE_DB_HOST:'127.0.0.1',STORE_DB_PORT:'1',STORE_DB_DATABASE:database,STORE_DB_USER:'root',STORE_DB_PASSWORD:'',CSA_LOCAL_ONLY:'false',LL_BASEURL:'https://localline.test/api/',LL_USERNAME:'test',LL_PASSWORD:'test',LL_PRICE_LIST_GUEST_ID:'1',LL_PRICE_LIST_CSA_MEMBERS_ID:'2',LL_PRICE_LIST_HERDSHARE_ID:'3',LL_PRICE_LIST_SNAP_ID:'4'});
 const {getPool}=await import('../db.js');const db=getPool();db.pool.config.connectionConfig.socketPath=socket;t.after(()=>db.end());
 for(const sql of ['CREATE TABLE vendors(id INT PRIMARY KEY,name VARCHAR(255))','CREATE TABLE categories(id INT PRIMARY KEY,name VARCHAR(255))','CREATE TABLE products(id INT PRIMARY KEY,name VARCHAR(255),vendor_id INT,category_id INT,is_deleted INT,track_inventory INT,inventory INT)','CREATE TABLE packages(id INT PRIMARY KEY,product_id INT,name VARCHAR(255),track_inventory INT,inventory INT,num_of_items INT,track_type VARCHAR(30))','CREATE TABLE local_line_product_meta(product_id INT,local_line_product_id INT)','CREATE TABLE local_line_package_meta(package_id INT,product_id INT,local_line_package_id INT)'])await db.query(sql);
 const {ensureEnterprisePricingSchema}=await import('./enterprisePricingSchema.js');await ensureEnterprisePricingSchema();
 await db.query("INSERT INTO vendors VALUES(2,'Farm')");await db.query("INSERT INTO products VALUES(1,'Beef',2,NULL,0,0,0)");await db.query("INSERT INTO packages VALUES(10,1,'1 lb',0,0,1,'package')");await db.query('INSERT INTO local_line_product_meta VALUES(1,100)');await db.query('INSERT INTO local_line_package_meta VALUES(10,1,1000)');
 await db.query("INSERT INTO enterprise_pricing_revisions (id,product_id,settings_version_id,status,input_json,output_json,editor_id,created_at) VALUES(1,1,1,'active','{}',?,1,UTC_TIMESTAMP())",[JSON.stringify({packages:[{packageId:10,localLineSaleCents:1000}]})]);await db.query('INSERT INTO enterprise_pricing_product_state(product_id,latest_revision_id,active_revision_id,updated_at) VALUES(1,1,1,UTC_TIMESTAMP())');
 let remote={id:77,name:'Bundle',description:'',visible:true,vendor:2,price:12,ownership:'MANAGED',track_inventory:true,inventory_type:'dynamic',images:[],box_contents:[{id:77,content_product_packages:[{id:1,product_package:1000,quantity:2,swaps:[]}]}],product_price_list_entries:[1,2,3,4].map(id=>({id,price_list:id,box_package_entry:{id,adjustment:true,adjustment_type:2,adjustment_value:50,on_sale:false}}))};
 const input={name:'Bundle',description:'',vendorId:2,buyPrice:'12.00',discountPercent:5,visible:true,inventoryMode:'components',stock:null,images:[],components:[{packageId:10,quantity:2}]};
 await db.query('INSERT INTO enterprise_bundles(id,remote_box_id,name,input_json,source_json,revision,edited_by,remote_captured_at,created_at,updated_at) VALUES(1,77,?,?,?,1,1,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())',[input.name,JSON.stringify(input),JSON.stringify(remote)]);
 let writes=0,componentPrice=10,loseResponse=true;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  const u=new URL(url);assert.equal(u.hostname,'localline.test');const json=v=>new Response(JSON.stringify(v),{status:200});
  if(u.pathname==='/api/token/')return json({access:'test'});
  if(u.pathname==='/api/vendors/')return json([{id:2,name:'Farm'}]);
  if(u.pathname==='/api/products/100/')return json({id:100,packages:[{id:1000,price_list_entries:[1,2,3,4].map(id=>({price_list_id:id,adjustment:true,adjustment_type:3,adjustment_value:componentPrice}))}]});
  assert.equal(u.pathname,'/api/boxes/77/');
  if(options.method==='PATCH'){
   writes++;for(const operation of JSON.parse(options.body)){const keys=operation.path.slice(1).split('/');let obj=remote;for(const k of keys.slice(0,-1))obj=obj[k];obj[keys.at(-1)]=operation.value;}
   if(loseResponse){loseResponse=false;throw new Error('Response lost');}
  }
  return json(remote);
 });
 const service=await import('./enterpriseBundlePublications.js');
 const review=await service.reviewBundlePublication(1,{userId:2});
 assert.equal(review.snapshot.expected.lists[0].value,19);assert.equal(writes,0);
 await assert.rejects(service.publishBundle(review.id,{userId:1}),/different publisher/);
 await assert.rejects(service.publishBundle(review.id,{userId:2}),/pilot/);assert.equal(writes,0);
 process.env.LL_BUNDLE_PUBLICATION_ENABLED='true';
 componentPrice=11;await assert.rejects(service.publishBundle(review.id,{userId:2}),/Sync individual/);assert.equal(writes,0);componentPrice=10;
 await assert.rejects(service.publishBundle(review.id,{userId:2}),/Response lost/);assert.equal(writes,1);assert.equal((await service.getBundlePublication(review.id)).status,'uncertain');
 await assert.rejects(service.reviewBundlePublication(1,{userId:2}),/existing bundle publication/);
 assert.equal((await service.publishBundle(review.id,{userId:2})).status,'verified');assert.equal(writes,1);
 assert.equal((await service.publishBundle(review.id,{userId:2})).status,'verified');assert.equal(writes,1);
 assert.equal(remote.price,12);assert.deepEqual(remote.product_price_list_entries.map(p=>p.box_package_entry.adjustment_value),[19,19,19,19]);
 const next=await service.reviewBundlePublication(1,{userId:2});await db.query('UPDATE enterprise_bundles SET revision=2 WHERE id=1');await assert.rejects(service.publishBundle(next.id,{userId:2}),/changed after review/);assert.equal(writes,1);
});
