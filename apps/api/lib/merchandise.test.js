import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyPrintifySignature,proposedRetail,addressInput,cartInput} from './merchandiseCore.js';
import {createPrintify} from './printify.js';
import {merchandiseConfig,merchandiseStripeEvent} from './merchandiseRuntime.js';
import Stripe from 'stripe';
import {hasAdminPermission} from './adminRoles.js';
import {dispatchStorefrontStripeEvent} from './storefrontStripeDispatch.js';
test('merchandise administration requires its own grant or full admin',()=>{
  assert.equal(hasAdminPermission(['merchandise_admin'],'merchandise_admin'),true);
  assert.equal(hasAdminPermission(['admin'],'merchandise_admin'),true);
  assert.equal(hasAdminPermission(['inventory_admin','storefront_admin'],'merchandise_admin'),false);
});
test('merchandise defaults keep every live/supplier control off and select test mode',()=>{
  const config=merchandiseConfig({STRIPE_SECRET_KEY:'sk_live_existing',STOREFRONT_CHECKOUT_ENABLED:'true'});
  assert.equal(config.mode,'test');for(const key of ['catalogEnabled','checkoutEnabled','liveEnabled','ordersEnabled','productionEnabled','manualApprovalVerified','webhookReady'])assert.equal(config[key],false);
});
test('merchandise reuses existing storefront signing secrets only for the matching mode',()=>{
  const live={STRIPE_SECRET_KEY:'sk_live_existing',STOREFRONT_STRIPE_WEBHOOK_SECRET:'whsec_existing_live'};
  assert.equal(merchandiseConfig({...live,MERCH_STRIPE_MODE:'live'}).webhookReady,true);
  assert.equal(merchandiseConfig(live).webhookReady,false);
  assert.equal(merchandiseConfig({...live,STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET:'whsec_existing_test'}).webhookReady,true);
  assert.equal(merchandiseConfig({STRIPE_SECRET_KEY:'sk_test_existing',STOREFRONT_STRIPE_WEBHOOK_SECRET:'whsec_existing_test'}).webhookReady,true);
});
test('shared Stripe dispatch isolates order metadata and preserves turkey processing without merchandise setup',async()=>{
  const calls=[];
  const dependencies={pool:{query:async()=>{throw new Error('Unexpected database access');}},
    storefront:()=>({webhook:async e=>calls.push(['turkey',e.id])}),
    merchandise:()=>({stripeWebhook:async e=>calls.push(['merchandise',e.id])})};
  const event=metadata=>({id:'evt_shared',type:'checkout.session.completed',data:{object:{metadata}}});
  await dispatchStorefrontStripeEvent(event({storefront_order_id:'1'}),{...dependencies,merchandise:()=>{throw new Error('Merchandise is unconfigured');}});
  await dispatchStorefrontStripeEvent(event({commerce_order_id:'1',order_kind:'merchandise'}),{...dependencies,storefront:()=>{throw new Error('Turkey service must not handle merchandise');}});
  await dispatchStorefrontStripeEvent(event({}),dependencies);
  await assert.rejects(dispatchStorefrontStripeEvent(event({commerce_order_id:'1',storefront_order_id:'1'}),dependencies),/conflicting/);
  assert.deepEqual(calls,[['turkey','evt_shared'],['merchandise','evt_shared'],['turkey','evt_shared']]);
});
test('shared Stripe refunds resolve durable payment ownership and hold database failures for retry',async()=>{
  const calls=[],queries=[];
  let owner='turkey',missing=false,broken=false;
  const dependencies={pool:{query:async(sql,params)=>{
    queries.push([sql,params]);
    if(sql.includes('commerce_orders')&&missing)throw Object.assign(new Error('Not installed'),{code:'ER_NO_SUCH_TABLE'});
    if(broken)throw Object.assign(new Error('Database unavailable'),{code:'ECONNREFUSED'});
    return [[sql.includes(owner==='turkey'?'storefront_orders':'commerce_orders')&&owner!=='none'?{id:'same-id'}:null].filter(Boolean)];
  }},storefront:()=>({webhook:async()=>calls.push('turkey')}),merchandise:()=>({stripeWebhook:async()=>calls.push('merchandise')})};
  const event={id:'evt_refund',type:'refund.updated',data:{object:{payment_intent:'pi_original'}}};
  await dispatchStorefrontStripeEvent(event,dependencies);
  assert.equal(queries.length,1); // A turkey refund never needs merchandise tables.
  owner='merchandise';await dispatchStorefrontStripeEvent(event,dependencies);
  await dispatchStorefrontStripeEvent({...event,type:'refund.failed',data:{object:{payment_intent:{id:'pi_original'}}}},dependencies);
  owner='none';missing=true;await dispatchStorefrontStripeEvent(event,dependencies);
  broken=true;await assert.rejects(dispatchStorefrontStripeEvent(event,dependencies),/Database unavailable/);
  assert.deepEqual(calls,['turkey','merchandise','merchandise','turkey']);
  assert.ok(queries.every(([,params])=>params[0]==='pi_original'));
});
test('Printify signatures bind exact raw bytes and reject unsigned or changed payloads',()=>{
  const raw=Buffer.from(JSON.stringify({id:'event-one',type:'order:updated',resource:{id:'order-one',data:{shop_id:1}}}));
  const signature='sha256='+crypto.createHmac('sha256','secret').update(raw).digest('hex');
  assert.equal(verifyPrintifySignature(raw,signature,'secret').id,'event-one');
  assert.throws(()=>verifyPrintifySignature(Buffer.concat([raw,Buffer.from(' ')]),signature,'secret'),/signature/);
  assert.throws(()=>verifyPrintifySignature(raw,undefined,'secret'),/signature/);
  assert.throws(()=>verifyPrintifySignature(raw,signature,''),/not configured/);
});
test('merchandise Stripe signatures use their own test/live signing secrets',()=>{
  const event={id:'evt_one',livemode:false,type:'checkout.session.completed',data:{object:{}}},body=JSON.stringify(event);
  const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret:'whsec_merch'});
  assert.equal(merchandiseStripeEvent(Buffer.from(body),signature,{STRIPE_SECRET_KEY:'sk_live_existing',STOREFRONT_STRIPE_TEST_SECRET_KEY:'sk_test_existing',MERCH_STRIPE_TEST_WEBHOOK_SECRET:'whsec_merch'}).id,event.id);
  assert.throws(()=>merchandiseStripeEvent(Buffer.from(body),signature,{STRIPE_SECRET_KEY:'sk_live_existing',STOREFRONT_STRIPE_WEBHOOK_SECRET:'whsec_merch'}),/not configured/);
});
test('supplier adapter allows shipping calculations but gates all real order/production writes',async()=>{
  const calls=[];const provider=createPrintify({token:'private-test-token',fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({standard:500})};}});
  assert.equal(provider.supportsTestOrders,false);
  await assert.rejects(async()=>provider.createOrder(1,{}),/disabled/);
  await assert.rejects(async()=>provider.cancelOrder(1,'remote'),/disabled/);
  await assert.rejects(async()=>provider.sendToProduction(1,'remote'),/disabled/);
  assert.equal(calls.length,0);
  await provider.quoteShipping(1,{line_items:[],address_to:{}});
  assert.equal(calls[0].url,'https://api.printify.com/v1/shops/1/orders/shipping.json');
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'error');
});
test('supplier API errors do not expose credential/body data and duplicate order receipts are preserved',async()=>{
  const provider=createPrintify({token:'secret',config:{ordersEnabled:true,manualApprovalVerified:true,approvedShopId:'1'},fetchImpl:async()=>({ok:false,status:409,json:async()=>({message:'secret private body',order:{id:'original'}})})});
  await assert.rejects(provider.createOrder(1,{}),error=>error.existingOrderId==='original'&&!error.message.includes('secret'));
  await assert.rejects(async()=>provider.createOrder(2,{}),/disabled/);
});
test('merchandise inputs reject mixed fulfillment, duplicate variants and invalid destinations',()=>{
  assert.throws(()=>cartInput([{variantId:1,quantity:1,expectedPriceCents:100,fulfillmentKind:'farm'}]),/Mixed/);
  assert.throws(()=>cartInput([{variantId:1,quantity:1,expectedPriceCents:100},{variantId:1,quantity:1,expectedPriceCents:100}]),/duplicate/);
  assert.throws(()=>addressInput({firstName:'A',lastName:'B',email:'a@b.com',phone:'5551234567',addressLine1:'1 Main',city:'City',state:'OR',postalCode:'97401',country:'CA'}),/US shipping/);
});
test('default retail applies a 40% markup with a $10 floor',()=>{
  assert.equal(proposedRetail(0),1000);
  assert.equal(proposedRetail(713),1000);
  assert.equal(proposedRetail(714),1000);
  assert.equal(proposedRetail(715),1001);
  assert.equal(proposedRetail(1001),1401);
  assert.equal(proposedRetail(null),null);
});
