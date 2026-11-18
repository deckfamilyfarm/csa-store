import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import {migrateMerchandise,merchandisePreflight} from './merchandiseSchema.js';
import {createMerchandiseService} from './merchandiseService.js';
import express from 'express';
import {createMerchandiseRouters} from '../routes/merchandise.js';
import Stripe from 'stripe';
import {createStorefrontStripeWebhook} from '../routes/storefront.js';
import {storefrontWebhookEvent} from './storefrontStripe.js';
import {dispatchStorefrontStripeEvent} from './storefrontStripeDispatch.js';
const socket=process.env.PRODUCT_SYNC_TEST_SOCKET;
test('native merchandise catalog, Stripe payments and independent supplier fulfillment on disposable MySQL',{skip:!socket},async t=>{
  assert.match(socket,/^\/(?:private\/)?tmp\/csa-product-sync-[^/]+\//);
  const database=`merchandise_test_${process.pid}_${Date.now()}`;
  const root=await mysql.createConnection({socketPath:socket,user:'root'});await root.query(`CREATE DATABASE \`${database}\``);
  const pool=mysql.createPool({socketPath:socket,user:'root',database,connectionLimit:12});
  await pool.query('CREATE TABLE vendors (id INT PRIMARY KEY,name VARCHAR(255)) ENGINE=InnoDB');
  await pool.query("INSERT INTO vendors VALUES (1,'Deck Family Farm'),(2,'')");
  t.after(async()=>{await pool.end();await root.query(`DROP DATABASE \`${database}\``);await root.end();});
  let clock=Date.parse('2026-11-17T12:00:00Z'),shipping=500,loseCheckout=false,loseSupplier=false,hideSupplier=false,loseRefund=false,loseCancel=false,mailFail=true;
  let checkoutCalls=0,supplierCalls=0,refundCalls=0,cancelCalls=0,productionCalls=0,loseProduction=false;
  const sessions=new Map(),sessionKeys=new Map(),payments=new Map(),remoteOrders=new Map(),refunds=new Map(),mail=[];
  const product={id:'source-product',shop_id:1,title:'Farm shirt',description:'<p>Farm shirt</p>',blueprint_id:10,print_provider_id:20,visible:true,
    print_areas:[{variant_ids:[101,102],placeholders:[{position:'front',images:[{id:'art-one',x:.5,y:.5,scale:1,angle:0}]}]}],print_details:[],images:[{src:'https://images.printify.com/test.jpg',variant_ids:[101,102]}],
    options:[{type:'size',values:[{id:1,title:'Small'},{id:2,title:'Large'}]}],variants:[{id:101,title:'Small',sku:'small',cost:1000,price:900,is_enabled:true,is_available:true,options:[1]},{id:102,title:'Large',sku:'large',cost:1200,price:1300,is_enabled:true,is_available:false,options:[2]}]};
  const metadata={provider:{id:20,title:'Supplier'},variants:{variants:[{id:101},{id:102}]},shipping:{profiles:[]},unresolvedArtwork:[]};
  const provider={key:'printify',supportsTestOrders:true,product:async()=>structuredClone(product),metadata:async()=>structuredClone(metadata),
    quoteShipping:async()=>({standard:shipping}),
    createOrder:async(shop,request)=>{
      supplierCalls++;
      const receipt={id:`remote-${remoteOrders.size+1}`,metadata:{shop_order_id:request.external_id},line_items:request.line_items,address_to:request.address_to,shipping_method:request.shipping_method,
        status:'on-hold',total_price:1000,total_shipping:500,total_tax:0,shipments:[]};
      remoteOrders.set(receipt.id,receipt);if(loseSupplier){loseSupplier=false;throw new Error('Lost supplier response');}return {id:receipt.id};
    },order:async(_shop,id)=>structuredClone(remoteOrders.get(id)),findOrder:async(_shop,external)=>hideSupplier?null:structuredClone([...remoteOrders.values()].find(r=>r.metadata.shop_order_id===external)),
    cancelOrder:async(_shop,id)=>{cancelCalls++;remoteOrders.get(id).status='canceled';if(loseCancel){loseCancel=false;throw new Error('Lost cancel response');}},
    sendToProduction:async(_shop,id)=>{productionCalls++;Object.assign(remoteOrders.get(id),{status:'in-production',sent_to_production_at:'now'});if(loseProduction){loseProduction=false;throw new Error('Lost production response');}}
  };
  const makeStripe=(mode='test')=>({accounts:{retrieve:async()=>({id:'acct_existing'})},taxRates:{retrieve:async()=>({id:'txr_reviewed',active:true,inclusive:false,country:'US',state:'WA',percentage:10})},
    checkout:{sessions:{create:async(request,{idempotencyKey})=>{
      checkoutCalls++;let session=sessionKeys.get(idempotencyKey);
      if(!session){session={id:`cs_${mode}_${sessions.size+1}`,url:'https://checkout.stripe.com/test',client_reference_id:request.client_reference_id,metadata:request.metadata,currency:'usd',livemode:mode==='live',
        amount_total:request.line_items.reduce((sum,row)=>sum+row.quantity*row.price_data.unit_amount+(row.tax_rates?Math.round(row.quantity*row.price_data.unit_amount*.1):0),0),status:'open',payment_status:'unpaid',expires_at:request.expires_at};sessions.set(session.id,session);sessionKeys.set(idempotencyKey,session);}
      if(loseCheckout){loseCheckout=false;throw new Error('Lost session response');}return structuredClone(session);
    },retrieve:async id=>structuredClone(sessions.get(id))}},
    paymentIntents:{retrieve:async id=>structuredClone(payments.get(id))},
    refunds:{create:async(request)=>{refundCalls++;const r={...request,id:`re_${refunds.size+1}`,currency:'usd',status:'succeeded'};refunds.set(r.id,r);if(loseRefund){loseRefund=false;throw new Error('Lost refund response');}return structuredClone(r);},
      list:({payment_intent})=>({async *[Symbol.asyncIterator](){for(const refund of refunds.values())if(refund.payment_intent===payment_intent)yield structuredClone(refund);}})}
  });
  const stripe=makeStripe();
  const config={mode:'test',checkoutEnabled:true,catalogEnabled:true,webhookReady:true,baseUrl:'http://localhost:5177',accountId:'acct_existing',ordersEnabled:true,manualApprovalVerified:true,approvedShopId:1,productionEnabled:true,
    taxRules:{'US:OR':{exempt:true},'US:WA':{rateId:'txr_reviewed',shippingTaxable:true}}};
  const service=createMerchandiseService({pool,stripeClients:{test:stripe},provider,config,now:()=>clock,sendEmail:async data=>{if(mailFail)throw new Error('SMTP failed');mail.push(data);}});
  let webhookService=service;
  const signatureStripe=new Stripe('sk_test_signature_validation_only'),turkeyEvents=[];
  const webhookApp=express();
  webhookApp.post('/api/storefront/stripe/webhook',express.raw({type:'application/json'}),createStorefrontStripeWebhook({
    verifyEvent:(body,signature)=>storefrontWebhookEvent(signatureStripe,body,signature,{
      STOREFRONT_STRIPE_WEBHOOK_SECRET:'whsec_existing_live',STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET:'whsec_existing_test'
    }),
    dispatchEvent:event=>dispatchStorefrontStripeEvent(event,{pool,merchandise:()=>webhookService,
      storefront:()=>({webhook:async event=>turkeyEvents.push(event.id),deliverEmails:async()=>{}})})
  }));
  const webhookServer=await new Promise(resolve=>{const server=webhookApp.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(()=>new Promise(resolve=>webhookServer.close(resolve)));
  const webhookUrl=`http://127.0.0.1:${webhookServer.address().port}/api/storefront/stripe/webhook`;
  const sharedEvent=async event=>{
    const body=JSON.stringify(event),signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:event.livemode?'whsec_existing_live':'whsec_existing_test'});
    const response=await fetch(webhookUrl,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body});
    assert.equal(response.status,200,await response.text());
    // Drain the serialized outbox worker before advancing the fixture clock.
    if(!event.data?.object?.metadata?.storefront_order_id)await webhookService.deliverEmails();
  };
  let localProduct,localVariant;
  const token=()=>crypto.randomBytes(32).toString('hex');
  const customer={firstName:'Farm',lastName:'Buyer',email:'buyer@example.com',phone:'5415551234',addressLine1:'1 Main St',addressLine2:'',city:'Eugene',state:'OR',postalCode:'97401',country:'US'};
  const makeQuote=(access=token(),extra={})=>service.quote({token:access,items:[{variantId:localVariant,quantity:1,expectedPriceCents:2000}],customer,...extra}).then(quote=>({access,quote}));
  const checkout=async()=>{const q=await makeQuote();return {...q,result:await service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177')};};
  const pay=async result=>{
    const [[o]]=await pool.query('SELECT * FROM commerce_orders WHERE id=?',[result.orderId]);const session=sessions.get(o.stripe_session_id);
    Object.assign(session,{status:'complete',payment_status:'paid',payment_intent:`pi_${session.id}`});
    payments.set(session.payment_intent,{id:session.payment_intent,status:'succeeded',currency:'usd',amount_received:session.amount_total,metadata:session.metadata,livemode:session.livemode,
      latest_charge:{id:`ch_${session.id}`,payment_intent:session.payment_intent,amount:session.amount_total,balance_transaction:{id:`txn_${session.id}`,currency:'usd',source:`ch_${session.id}`,fee:103}}});
    const event={id:`evt_${session.id}`,type:'checkout.session.completed',livemode:session.livemode,data:{object:structuredClone(session)}};
    await sharedEvent(event);return event;
  };
  const fulfillment=async orderId=>(await service.viewOrder(orderId,null,true)).fulfillments[0];
  await t.test('readiness is read-only and migration creates only the eight new tables',async()=>{
    assert.equal((await merchandisePreflight(pool)).ready,false);
    await assert.rejects(service.catalog(true),/migration/);
    const [[before]]=await pool.query('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');assert.equal(before.n,1);
    assert.equal((await migrateMerchandise(pool)).ready,true);
    const [tables]=await pool.query('SHOW TABLES');assert.equal(tables.length,9);
  });
  await t.test('supplier import creates disabled drafts, preserves local retail and rejects stale edits',async()=>{
    await assert.rejects(service.importRecords([{shopId:1,vendorId:2,product,catalog:metadata}],1),/existing named/);
    await service.importRecords([{shopId:1,vendorId:1,product,catalog:metadata}],1,undefined,{initialOnly:true});
    let p=(await service.catalog(true)).products[0];localProduct=p.id;localVariant=p.variants[0].id;
    assert.equal(p.active,false);assert.equal(p.currency,null);assert.equal(p.variants[0].retailCents,null);assert.equal(p.variants[0].proposedRetailCents,1500);
    await service.importRecords([{shopId:1,vendorId:1,product,catalog:metadata}],1,undefined,{initialOnly:true});
    assert.equal((await service.catalog(true)).products[0].id,p.id);
    p=await service.saveProduct(p.id,{version:p.version,active:true,artworkReviewed:true,currency:'USD',variants:[{id:localVariant,enabled:true,retailCents:2000}]},1);
    await assert.rejects(service.importRecords([{shopId:1,vendorId:1,product,catalog:metadata}],1,undefined,{initialOnly:true}),/existing merchandise edits/);
    assert.equal((await service.catalog(true)).products[0].active,true);
    await assert.rejects(service.saveProduct(p.id,{version:p.version-1,active:false,artworkReviewed:true,currency:'USD',variants:[]},1),/changed/);
    const changed=structuredClone(product);changed.description='Updated';
    await service.importRecords([{shopId:1,vendorId:1,product:changed,catalog:metadata}],1);
    p=(await service.catalog(true)).products[0];assert.equal(p.active,false);assert.equal(p.artworkReviewed,false);assert.equal(p.variants[0].retailCents,2000);
    await service.importRecords([{shopId:1,vendorId:1,product,catalog:metadata}],1);
    p=(await service.catalog(true)).products[0];await service.saveProduct(p.id,{version:p.version,active:true,artworkReviewed:true,currency:'USD',variants:[]},1);
  });
  await t.test('supplier refresh rejects a concurrent local save and public HTTP does not expose supplier costs',async()=>{
    let release;const barrier=new Promise(resolve=>{release=resolve;});
    const original=provider.product;let started;
    const fetched=new Promise(resolve=>{started=resolve;});
    provider.product=async()=>{started();await barrier;return structuredClone(product);};
    const refreshing=service.refreshProduct(localProduct,1);await fetched;
    const p=(await service.catalog(true)).products[0];await service.saveProduct(p.id,{version:p.version,active:true,artworkReviewed:true,currency:'USD',variants:[]},1);
    release();await assert.rejects(refreshing,/changed while supplier/);provider.product=original;
    const app=express();app.use(express.json());
    const {publicRouter,adminRouter}=createMerchandiseRouters({getService:()=>service,adminAuth:(req,res,next)=>req.headers.authorization==='Bearer reviewed-admin'?next():res.status(403).json({error:'Denied'})});
    app.use('/api/merchandise',publicRouter);app.use('/api/admin/merchandise',adminRouter);
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    try {
      const base=`http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/api/admin/merchandise/catalog`)).status,403);
      const publicCatalog=await (await fetch(`${base}/api/merchandise/catalog`)).json();
      assert.equal(publicCatalog.products.length,1);assert.equal(publicCatalog.products[0].variants.length,1);
      assert.equal('costCents' in publicCatalog.products[0].variants[0],false);assert.equal('shopId' in publicCatalog.products[0],false);
      assert.equal((await fetch(`${base}/api/admin/merchandise/catalog`,{headers:{authorization:'Bearer reviewed-admin'}})).status,200);
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
  await t.test('shipping and reviewed tax are charged before payment; stale prices and mixed carts are rejected',async()=>{
    const q=await makeQuote();assert.equal(q.quote.totalCents,2500);assert.equal(q.quote.shippingCents,500);
    const wa=await makeQuote(token(),{customer:{...customer,state:'WA'}});assert.equal(wa.quote.totalCents,2750);
    const checked=await service.checkout({quoteId:wa.quote.quoteId,token:wa.access},'http://localhost:5177');assert.equal((await service.viewOrder(checked.orderId,wa.access)).taxCents,250);
    shipping=600;await assert.rejects(service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177'),/Shipping or tax changed/);shipping=500;
    await assert.rejects(makeQuote(token(),{items:[{variantId:localVariant,quantity:1,expectedPriceCents:1500}]}),/price changed/);
    await assert.rejects(makeQuote(token(),{items:[{variantId:localVariant,quantity:1,expectedPriceCents:2000,fulfillmentKind:'farm'}]}),/Mixed/);
    await assert.rejects(makeQuote(token(),{customer:{...customer,state:'CA'}}),/Tax configuration/);
  });
  let first,event;
  await t.test('existing signed storefront endpoint rejects unverified requests and routes turkey events separately',async()=>{
    const body=JSON.stringify({id:'evt_turkey_existing',livemode:false,type:'checkout.session.completed',data:{object:{metadata:{storefront_order_id:'1'}}}});
    const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:'whsec_existing_test'});
    const send=(payload,headers={})=>fetch(webhookUrl,{method:'POST',headers:{'content-type':'application/json',...headers},body:payload});
    assert.equal((await send(body)).status,400);
    assert.equal((await send(body+' ',{'stripe-signature':signature})).status,400);
    assert.equal(turkeyEvents.length,0);
    await sharedEvent(JSON.parse(body));assert.deepEqual(turkeyEvents,['evt_turkey_existing']);
    const [[count]]=await pool.query('SELECT COUNT(*) n FROM commerce_webhooks');assert.equal(count.n,0);
  });
  await t.test('lost Stripe response recovers one session; guest reads cannot mark paid; verified webhook enqueues once',async()=>{
    const q=await makeQuote();const before=checkoutCalls;loseCheckout=true;
    await assert.rejects(service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177'),/outcome is unknown/);
    const result=await service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177');first={...q,result};
    assert.equal(checkoutCalls-before,2);assert.equal(sessionKeys.size,sessions.size);
    assert.equal((await service.viewOrder(result.orderId,q.access)).paid,false);
    await assert.rejects(service.viewOrder(result.orderId,token()),/not found/);
    await assert.rejects(service.processFulfillment((await fulfillment(result.orderId)).id),/webhook/);
    event=await pay(result);await sharedEvent(event);assert.equal((await service.stripeWebhook(event)).duplicate,true);
    assert.deepEqual(turkeyEvents,['evt_turkey_existing']);
    const [[mailCount]]=await pool.query("SELECT COUNT(*) n FROM commerce_emails WHERE order_id=?",[result.orderId]);assert.equal(mailCount.n,1);
    assert.equal((await service.viewOrder(result.orderId,q.access)).paid,true);
  });
  await t.test('account, mode and amount mismatches cannot fulfill or change a paid order',async()=>{
    await assert.rejects(service.stripeWebhook({...event,id:'evt_wrong_mode',livemode:true}),/mode/);
    await assert.rejects(service.stripeWebhook({...event,id:'evt_wrong_account',account:'acct_other'}),/account/);
    const session=sessions.get(event.data.object.id);session.amount_total++;
    await assert.rejects(service.stripeWebhook({...event,id:'evt_wrong_amount'}),/attribution/);session.amount_total--;
  });
  await t.test('Stripe test payments never submit real Printify orders even if all flags are enabled',async()=>{
    provider.supportsTestOrders=false;const f=await fulfillment(first.result.orderId),before=supplierCalls;
    await service.processFulfillment(f.id);assert.equal((await fulfillment(first.result.orderId)).status,'held_test_mode');assert.equal(supplierCalls,before);
    provider.supportsTestOrders=true;
  });
  await t.test('lost supplier response is reconciled by original external ID without duplicate POST',async()=>{
    const f=await fulfillment(first.result.orderId);loseSupplier=true;const before=supplierCalls;
    await assert.rejects(service.processFulfillment(f.id),/reconciliation/);
    hideSupplier=true;await assert.rejects(service.processFulfillment(f.id),/No replacement/);assert.equal(supplierCalls,before+1);
    hideSupplier=false;await service.processFulfillment(f.id);assert.equal(supplierCalls,before+1);assert.equal((await fulfillment(first.result.orderId)).status,'on-hold');
  });
  await t.test('tracking reads current provider state, deduplicates events and ignores foreign Wix orders',async()=>{
    const f=await fulfillment(first.result.orderId);const remote=remoteOrders.get(f.remoteId);remote.status='fulfilled';remote.shipments=[{carrier:'USPS',number:'123',url:'https://tools.usps.com/track',delivered_at:null}];
    const e={id:'pfy_event_1',type:'order:shipment:created',resource:{id:f.remoteId,data:{shop_id:1}}};
    await service.printifyWebhook(e);assert.equal((await service.printifyWebhook(e)).duplicate,true);
    assert.equal((await fulfillment(first.result.orderId)).tracking[0].number,'123');
    assert.equal((await service.printifyWebhook({id:'foreign',type:'order:updated',resource:{id:'foreign-order',data:{shop_id:2}}})).ignored,true);
    remote.status='on-hold';remote.shipments=[];await service.processFulfillment(f.id);
  });
  await t.test('refund retry reconciles one receipt and never cancels supplier production',async()=>{
    const reviewed=await service.reviewOperation(first.result.orderId,'refund',1),before=refundCalls;loseRefund=true;
    await assert.rejects(service.confirmOperation(first.result.orderId,reviewed.id,1),/outcome unknown/);
    assert.equal((await service.confirmOperation(first.result.orderId,reviewed.id,1)).status,'applied');
    await service.confirmOperation(first.result.orderId,reviewed.id,1);assert.equal(refundCalls,before+1);assert.equal(cancelCalls,0);
    assert.equal((await service.viewOrder(first.result.orderId,first.access)).refundedCents,2500);assert.equal((await fulfillment(first.result.orderId)).status,'on-hold');
    const refund=[...refunds.values()][0];await sharedEvent({id:'evt_refund_received',livemode:false,type:'refund.updated',data:{object:refund}});
    assert.equal((await service.viewOrder(first.result.orderId,first.access)).refundedCents,2500);
  });
  await t.test('supplier cancellation has a distinct review, lost responses never repeat cancellation',async()=>{
    const review=await service.reviewOperation(first.result.orderId,'cancel',1);loseCancel=true;const before=cancelCalls;
    await assert.rejects(service.confirmOperation(first.result.orderId,review.id,1),/outcome unknown/);
    assert.equal((await service.confirmOperation(first.result.orderId,review.id,1)).status,'applied');assert.equal(cancelCalls,before+1);assert.equal(productionCalls,0);
  });
  await t.test('fees and reporting distinguish test sales, supplier costs and refunds; email failures retry',async()=>{
    await service.refreshFees(first.result.orderId);
    assert.equal((await service.viewOrder(first.result.orderId,null,true)).stripeFeeCents,103);
    const report=await service.report();assert.equal(report.find(r=>r.mode==='live').paidOrders,0);assert.equal(report.find(r=>r.mode==='test').refundsCents,2500);
    mailFail=true;await service.deliverEmails();assert.equal(mail.length,0);clock+=61000;mailFail=false;await service.deliverEmails();assert(mail.length>=1);
  });
  await t.test('an uncertain Stripe session older than its idempotency window is held',async()=>{
    const q=await makeQuote();loseCheckout=true;await assert.rejects(service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177'));
    const before=checkoutCalls;clock+=24*3600000;
    await assert.rejects(service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177'),/held for reconciliation/);assert.equal(checkoutCalls,before);
    const original=[...sessions.values()].find(s=>s.metadata.commerce_order_id===[...sessionKeys.values()].at(-1).metadata.commerce_order_id);
    const recovered=await service.recoverCheckout(original.metadata.commerce_order_id,original.id);
    assert.equal(recovered.paidWebhookStillRequired,true);
    assert.equal((await service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177')).orderId,original.metadata.commerce_order_id);
    assert.equal(checkoutCalls,before);
  });
  await t.test('external refunds are recorded and hold new supplier orders without canceling existing fulfillment',async()=>{
    const order=await checkout();await pay(order.result);const before=supplierCalls;
    const [[o]]=await pool.query('SELECT * FROM commerce_orders WHERE id=?',[order.result.orderId]);
    refunds.set('re_external',{id:'re_external',payment_intent:o.stripe_payment_id,amount:500,currency:'usd',status:'succeeded',metadata:{}});
    await assert.rejects(service.processFulfillment((await fulfillment(o.id)).id),/refunds hold/);
    assert.equal(supplierCalls,before);
    assert.equal((await service.viewOrder(o.id,order.access)).refundedCents,500);
    const acknowledged=await service.reconcileFinances(o.id,true);assert.equal(acknowledged.externalRefunds,true);assert.equal(acknowledged.financialHold,false);
    // A remaining refund requires a separately reviewed operation and never alters supplier orders.
    const review=await service.reviewOperation(o.id,'refund',1);
    assert.equal(review.amountCents,2000);
    await service.confirmOperation(o.id,review.id,1);
    assert.equal((await service.viewOrder(o.id,order.access)).refundedCents,2500);
  });
  await t.test('manual production approval checks its separate gate and reconciles a lost response once',async()=>{
    const order=await checkout();await pay(order.result);const f=await fulfillment(order.result.orderId);await service.processFulfillment(f.id);
    const review=await service.reviewOperation(order.result.orderId,'production',1),before=productionCalls;
    config.productionEnabled=false;await assert.rejects(service.confirmOperation(order.result.orderId,review.id,1),/disabled/);assert.equal(productionCalls,before);
    config.productionEnabled=true;loseProduction=true;await assert.rejects(service.confirmOperation(order.result.orderId,review.id,1),/outcome unknown/);
    assert.equal((await service.confirmOperation(order.result.orderId,review.id,1)).status,'applied');assert.equal(productionCalls,before+1);
    await assert.rejects(service.reviewOperation(order.result.orderId,'cancel',1),/cannot currently be canceled/);
  });
  await t.test('expired and observed-paid sessions recover through read-only maintenance without releasing production',async()=>{
    const expired=await checkout(),pending=await checkout();
    const [[a]]=await pool.query('SELECT stripe_session_id FROM commerce_orders WHERE id=?',[expired.result.orderId]);
    sessions.get(a.stripe_session_id).status='expired';
    const [[b]]=await pool.query('SELECT stripe_session_id FROM commerce_orders WHERE id=?',[pending.result.orderId]);
    Object.assign(sessions.get(b.stripe_session_id),{status:'complete',payment_status:'paid'});
    const before=supplierCalls;await service.maintenance();
    assert.equal((await service.viewOrder(expired.result.orderId,expired.access)).status,'expired');
    const seen=await service.viewOrder(pending.result.orderId,pending.access);assert.equal(seen.status,'awaiting_webhook');assert.equal(seen.paid,false);assert.equal(supplierCalls,before);
    await service.stripeWebhook({id:'evt_expired',type:'checkout.session.expired',livemode:false,data:{object:sessions.get(a.stripe_session_id)}});
    assert.equal((await fulfillment(expired.result.orderId)).status,'expired');
  });
  await t.test('live checkout uses the shared live webhook, restricts shipping and holds supplier submission',async()=>{
    const liveConfig={...config,mode:'live',liveEnabled:false,ordersEnabled:false,productionEnabled:false,
      manualApprovalVerified:false,taxRules:{'US:OR':{exempt:true}}};
    const live=createMerchandiseService({pool,stripeClients:{test:stripe,live:makeStripe('live')},provider,config:liveConfig,now:()=>clock});
    const access=token(),body={token:access,items:[{variantId:localVariant,quantity:1,expectedPriceCents:2000}],customer};
    await assert.rejects(live.quote(body),/Live merchandise checkout is disabled/);
    liveConfig.liveEnabled=true;
    assert.deepEqual((await live.catalog()).shippingRegions,['US:OR']);
    await assert.rejects(live.quote({...body,customer:{...customer,state:'WA'}}),/Tax configuration/);
    await pool.query('UPDATE merch_variants SET proposed_retail_cents=1900 WHERE id=?',[localVariant]);
    const [variant] = (await live.catalog(true)).products[0].variants;
    assert.equal(variant.proposedRetailCents,1500);
    assert.equal(variant.retailCents,2000);
    liveConfig.usDefaultTax='not_collecting';
    liveConfig.taxRules['US:WA']={rateId:'txr_reviewed',shippingTaxable:true};
    const catalog=await live.catalog();
    assert.equal(catalog.shipsNationwide,true);
    assert.equal(catalog.shippingRegions.length,51);
    for (const state of ['AK','DC','HI','NY']) assert.ok(catalog.shippingRegions.includes(`US:${state}`));
    await assert.rejects(live.quote({...body,customer:{...customer,state:'ZZ'}}),/Tax configuration/);
    assert.equal((await live.quote({...body,customer:{...customer,state:'WA'}})).tax.cents,250);
    const quote=await live.quote({...body,customer:{...customer,state:'NY',city:'New York',postalCode:'10001'}});
    assert.equal(quote.tax.basis,'configured_no_collection');
    assert.equal(quote.totalCents,quote.subtotalCents+quote.shippingCents);
    const result=await live.checkout({quoteId:quote.quoteId,token:access},'http://localhost:5177');
    const [[order]]=await pool.query('SELECT * FROM commerce_orders WHERE id=?',[result.orderId]);
    assert.equal(order.stripe_mode,'live');assert.match(order.stripe_session_id,/^cs_live_/);
    assert.equal((await live.viewOrder(result.orderId,access)).paid,false);
    const before=supplierCalls;
    webhookService=live;
    try {const paid=await pay(result);await sharedEvent(paid);} finally {webhookService=service;}
    assert.equal((await live.viewOrder(result.orderId,access)).paid,true);
    const f=(await live.viewOrder(result.orderId,null,true)).fulfillments[0];
    await live.processFulfillment(f.id);
    assert.equal((await live.viewOrder(result.orderId,null,true)).fulfillments[0].status,'held_disabled');
    assert.equal(supplierCalls,before);
    const report=await live.report();assert.equal(report.find(r=>r.mode==='live').paidOrders,1);
  });
  await t.test('a blank modified price lists and charges the default price',async()=>{
    let p=(await service.catalog(true)).products[0];
    const editable={active:true,artworkReviewed:true,currency:'USD'};
    assert.equal(p.variants.find(v=>v.id===localVariant).canSell,true);
    assert.equal(p.variants.find(v=>v.id!==localVariant).canSell,false);
    p=await service.saveProduct(p.id,{...editable,version:p.version,variants:[{id:localVariant,enabled:true,retailCents:null}]},1);
    assert.equal(p.variants.find(v=>v.id===localVariant).retailCents,null);
    assert.equal((await service.catalog()).products[0].variants[0].retailCents,1500);

    const items=[{variantId:localVariant,quantity:1,expectedPriceCents:1500}];
    const q=await makeQuote(token(),{items});
    assert.equal(q.quote.totalCents,2000);
    const result=await service.checkout({quoteId:q.quote.quoteId,token:q.access},'http://localhost:5177');
    const stale=await makeQuote(token(),{items});
    await service.saveProduct(p.id,{...editable,version:p.version,variants:[{id:localVariant,enabled:true,retailCents:1800}]},1);
    assert.equal((await service.catalog()).products[0].variants[0].retailCents,1800);
    await assert.rejects(service.checkout({quoteId:stale.quote.quoteId,token:stale.access},'http://localhost:5177'),/retail price changed/);
    assert.equal((await service.viewOrder(result.orderId,q.access)).items[0].retailCents,1500);
  });
});
