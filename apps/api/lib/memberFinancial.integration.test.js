import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {migrateMemberFinancialSchema,assertFinancialSchema} from './memberFinancialSchema.js';
import {migrateLegacySubscriptionPortalSchema} from '../db.js';
import {saveVerifiedLocalLineLink,requireVerifiedLocalLineLink,approveLocalLineCreditStartingPoint} from './memberExternalLinks.js';
import {runMemberBilling} from './memberBilling.js';
import {processMemberStripeEvent} from './memberStripeEvents.js';
import {postMemberEvent,getMemberOperation,runMemberOperation} from './memberFinancialOperations.js';
import {processLocalLineEventTransfers} from './memberCreditTransfers.js';
import {reconcileMemberOrder} from './memberOrderReconciliation.js';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';

const socket=process.env.PRODUCT_SYNC_TEST_SOCKET;
if(process.env.REQUIRE_STABILIZATION_INTEGRATION==='true'&&!socket)throw new Error('Required financial integration suite has no disposable socket.');
test('member ownership, durable billing, atomic postings, refunds and event transfers use real MySQL transactions', {skip:!socket},async t=>{
 assert.match(socket,/^\/(private\/)?tmp\/csa-product-sync-/);
 t.mock.method(globalThis,'fetch',()=>assert.fail('All provider requests must be mocked.'));
 const root=await mysql.createConnection({socketPath:socket,user:'root'}),database=`csa_financial_test_${process.pid}`;
 await root.query(`CREATE DATABASE \`${database}\``);
 const pool=mysql.createPool({socketPath:socket,user:'root',database,connectionLimit:8,timezone:'Z'});
 t.after(async()=>{await pool.end();await root.query(`DROP DATABASE \`${database}\``);await root.end();});
 await pool.query('CREATE TABLE users(id INT PRIMARY KEY,email VARCHAR(255),active INT DEFAULT 1)');
 await pool.query("INSERT INTO users VALUES (1,'one@example.test',1),(2,'two@example.test',1),(3,'three@example.test',1)");
 await assert.rejects(assertFinancialSchema(pool),{status:503});
 const migrate=async()=>{const db=await pool.getConnection();try{return await migrateMemberFinancialSchema(db,migrateLegacySubscriptionPortalSchema);}finally{db.release();}};
 await migrate();await migrate();await assertFinancialSchema(pool);
 // Runtime readiness never repairs/deletes duplicates or recreates constraints.
 await pool.query('DROP INDEX ux_member_ledger_entries_user_reference ON member_ledger_entries');
 await pool.query("INSERT INTO member_ledger_entries(account_id,user_id,entry_type,amount_cents,effective_date,reference_type,reference_id) VALUES(1,1,'fixture',50,NOW(),'localline_credit_transaction','duplicate'),(1,1,'fixture',60,NOW(),'localline_credit_transaction','duplicate')");
 await assert.rejects(migrate(),e=>e.issues?.[0]?.table==='member_ledger_entries');
 assert.equal((await pool.query('SELECT COUNT(*) n FROM member_ledger_entries'))[0][0].n,2);
 // Explicit test-fixture cleanup, not application deduplication.
 await pool.query("DELETE FROM member_ledger_entries WHERE entry_type='fixture'");await migrate();
 for(const id of [1,2,3]){
  await pool.query("INSERT INTO member_profiles(user_id,first_name,last_name) VALUES (?,?,'Member')",[id,`Test ${id}`]);
  await pool.query("INSERT INTO member_subscriptions(user_id,plan_key,plan_amount_cents,billing_day_of_month,status) VALUES (?,'forager',20000,1,'pending_payment_method')",[id]);
  await pool.query("INSERT INTO member_herdshare_statuses(user_id,monthly_fee_cents,status) VALUES (?,500,'active')",[id]);
 }
 const verified=await saveVerifiedLocalLineLink({userId:1,externalCustomerId:'100',method:'storefront_login',actorUserId:1,evidence:{endpoint:'customers/current',customerId:'100'}},pool);
 const link={id:verified.linkId,userId:1,externalCustomerId:'100'};
 await requireVerifiedLocalLineLink(link,1,pool);
 await assert.rejects(requireVerifiedLocalLineLink(link,2,pool),{status:403});
 await assert.rejects(saveVerifiedLocalLineLink({userId:2,externalCustomerId:'100',method:'storefront_login',actorUserId:2,evidence:{customerId:'100'}},pool),/already linked/);
 await assert.rejects(requireVerifiedLocalLineLink(link,1,pool,{creditReady:true}),/starting Local Line balance/);
 await approveLocalLineCreditStartingPoint({userId:1,actorUserId:3,evidence:'Reviewed opening transactions and balance'},pool);

 const requests=[],receipts=new Map();let lostCustomer=true,lostPausedFee=true;
 const send=(kind,body,options,receipt)=>{
  assert.ok(options.idempotencyKey);requests.push({kind,body:structuredClone(body),key:options.idempotencyKey});
  if(!receipts.has(options.idempotencyKey))receipts.set(options.idempotencyKey,receipt);
  if(kind==='customer'&&lostCustomer){lostCustomer=false;throw new Error('lost customer response');}
  if(kind==='paused_fee'&&lostPausedFee){lostPausedFee=false;throw new Error('lost fee response');}
  return structuredClone(receipts.get(options.idempotencyKey));
 };
 let currentSubscription={id:'sub_1',status:'active',customer:'cus_1',items:{data:[{id:'si_1'}]},current_period_start:1700000000,current_period_end:1800000000};
 const stripe={
  customers:{create:async(body,options)=>send('customer',body,options,{id:'cus_1'}),retrieve:async()=>({id:'cus_1',invoice_settings:{default_payment_method:'pm_1'}})},
  setupIntents:{create:async(body,options)=>send('setup',body,options,{id:'seti_1',client_secret:'test-only'})},
  subscriptions:{retrieve:async()=>structuredClone(currentSubscription),update:async(id,body,options)=>send('subscription_update',{id,body},options,currentSubscription),
   create:async(body,options)=>send('subscription_create',body,options,{...currentSubscription,id:`sub_new${body.metadata.userId}`}),cancel:async(id,body,options)=>send('cancel',{id,body},options,{...currentSubscription,status:'canceled'})},
  invoiceItems:{create:async(body,options)=>send('initial_item',body,options,{id:'ii_1'})},
  invoices:{finalizeInvoice:async(id,body,options)=>send('initial_finalize',{id,body},options,{id,status:'open'}),create:async(body,options)=>send('initial_invoice',body,options,{id:'in_initial'}),pay:async(id,body,options)=>send('initial_pay',{id,body},options,{id,status:'paid'})},
  charges:{retrieve:async()=>({id:'ch_1',invoice:'in_cycle',amount:19000,currency:'usd',amount_refunded:9500})}
  ,paymentIntents:{create:async(body,options)=>send('paused_fee',body,options,{id:'pi_fee',status:'succeeded'})}
 };
 process.env.MEMBER_BILLING_ENABLED='true';
 const setup={userId:1,kind:'setup',requestKey:'setup-request-1',stripe,mode:'test'};
 await assert.rejects(runMemberBilling(setup,pool),/lost customer response/);
 const [first,retry]=await Promise.all([runMemberBilling(setup,pool),runMemberBilling(setup,pool)]);
 assert.equal(first.operationId,retry.operationId);
 assert.equal(new Set(requests.filter(row=>row.kind==='customer').map(row=>row.key)).size,1);
 assert.equal(requests.filter(row=>row.kind==='setup').length,1);
 await assert.rejects(runMemberBilling({...setup,input:{changed:true}},pool),/different inputs/);
 await assert.rejects(runMemberBilling({...setup,mode:'live'},pool),/mode changed/);
 await assert.rejects(getMemberOperation(first.operationId,2,pool),{status:404});
 // Existing subscriptions update in place. A timeout/rejected cancellation is never ignored to create a replacement.
 await pool.query("UPDATE member_subscriptions SET stripe_subscription_id='sub_1' WHERE user_id=1");
 const billing={userId:1,kind:'subscription',requestKey:'plan-update-1',input:{planKey:'forager',billingDayOfMonth:1},stripe,mode:'test',plan:{key:'forager',label:'Forager',amountCents:20000},priceId:'price_member',anchor:1800000000};
 await runMemberBilling(billing,pool);
 assert.equal(requests.filter(row=>row.kind==='subscription_create').length,0);
 assert.equal(requests.filter(row=>row.kind==='subscription_update').length,1);

 await t.test('initial funding isolates pending invoice items and finalizes before paying',async()=>{
  await pool.query("UPDATE member_subscriptions SET stripe_customer_id='cus_1' WHERE user_id=2");
  const result=await runMemberBilling({...billing,userId:2,requestKey:'initial-funding-1'},pool);
  const kinds=requests.map(row=>row.kind);
  assert.ok(kinds.indexOf('initial_invoice')<kinds.indexOf('initial_item'));
  assert.ok(kinds.indexOf('initial_item')<kinds.indexOf('initial_finalize'));
  assert.ok(kinds.indexOf('initial_finalize')<kinds.indexOf('initial_pay'));
  assert.equal(requests.find(row=>row.kind==='initial_invoice').body.pending_invoice_items_behavior,'exclude');
  assert.equal(requests.find(row=>row.kind==='initial_invoice').body.auto_advance,false);
  assert.equal(result.status,'completed');
 });
 await t.test('paused fee lost responses reuse one charge and one period posting',async()=>{
  await pool.query("UPDATE member_subscriptions SET stripe_customer_id='cus_3',status='paused' WHERE user_id=3");
  await pool.query("UPDATE member_herdshare_statuses SET next_billing_date='2026-11-01',monthly_fee_cents=500 WHERE user_id=3");
  const command={userId:3,kind:'paused_fee',requestKey:'paused-fee:2026-11-01',input:{period:'2026-11-01'},stripe,mode:'test'};
  await assert.rejects(runMemberBilling(command,pool),/lost fee response/);
  await runMemberBilling(command,pool);await runMemberBilling(command,pool);
  assert.equal(new Set(requests.filter(row=>row.kind==='paused_fee').map(row=>row.key)).size,1);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM member_financial_events WHERE user_id=3 AND source='stripe_paused_fee'"))[0][0].n,1);
  assert.equal(Number((await pool.query('SELECT SUM(amount_cents) total FROM member_ledger_entries WHERE user_id=3'))[0][0].total),0,'Cash-paid fee does not also consume wallet credit');
  await assert.rejects(runMemberBilling({...command,requestKey:'different-key-same-period'},pool),/period changed|No paused membership fee/);
 });
 // Remove synthetic non-user-1 postings from the totals asserted below.
 const ledgerTotal=async()=>Number((await pool.query('SELECT COALESCE(SUM(amount_cents),0) total FROM member_ledger_entries WHERE user_id=1'))[0][0].total);
 const ledgerCount=async()=>Number((await pool.query('SELECT COUNT(*) n FROM member_ledger_entries WHERE user_id=1'))[0][0].n);
 process.env.MEMBER_BILLING_ENABLED='false';
 await assert.rejects(runMemberBilling({...setup,requestKey:'new-request-disabled'},pool),{status:503});

 // Freeze a reviewed historical policy; today's plan is deliberately different.
 await pool.query("INSERT INTO member_subscription_policies VALUES ('sub_1',1600000000,1,'test',?,NULL)",[JSON.stringify({creditCents:20000,feeCents:500,priceId:'price_member'})]);
 await pool.query('UPDATE member_subscriptions SET plan_amount_cents=50000 WHERE user_id=1');
 const invoice={id:'in_cycle',subscription:'sub_1',customer:'cus_1',billing_reason:'subscription_cycle',period_start:1700000000,status:'paid',currency:'usd',amount_paid:19000,lines:{data:[{amount:20000,price:{id:'price_member'}}]}};
 const event=(id,type,object)=>({id,type,livemode:false,data:{object}});
 await pool.query("CREATE TRIGGER fail_member_fee BEFORE INSERT ON member_ledger_entries FOR EACH ROW BEGIN IF NEW.entry_type='herdshare_charge' AND NEW.amount_cents<0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fee write failed'; END IF; END");
 await assert.rejects(processMemberStripeEvent(event('evt_invoice','invoice.paid',invoice),{stripe,mode:'test',pool}),/fee write failed/);
 assert.equal((await pool.query('SELECT COUNT(*) n FROM member_financial_events WHERE user_id=1'))[0][0].n,0);
 assert.equal(await ledgerCount(),0);
 await pool.query('DROP TRIGGER fail_member_fee');
 await processMemberStripeEvent(event('evt_invoice','invoice.paid',invoice),{stripe,mode:'test',pool});
 await processMemberStripeEvent(event('evt_invoice_duplicate','invoice.paid',invoice),{stripe,mode:'test',pool});
 assert.equal(await ledgerTotal(),19500);
 assert.equal(await ledgerCount(),2);
 assert.equal((await pool.query('SELECT last_known_balance_cents FROM member_credit_mirrors'))[0].length,0,'No speculative credit mirror is created');
 const unrelated=await processMemberStripeEvent(event('evt_other','invoice.paid',{...invoice,id:'in_other',subscription:null}),{stripe,mode:'test',pool});
 assert.equal(unrelated.ignored,true);
 const unknown=await processMemberStripeEvent(event('evt_unknown','invoice.paid',{...invoice,id:'in_unknown',subscription:'sub_unknown'}),{stripe,mode:'test',pool});
 assert.equal(unknown.held,true);
 await processMemberStripeEvent(event('evt_refund','charge.refunded',{id:'ch_1'}),{stripe,mode:'test',pool});
 await processMemberStripeEvent(event('evt_refund_duplicate','charge.refunded',{id:'ch_1'}),{stripe,mode:'test',pool});
 assert.equal(await ledgerTotal(),9750);
 currentSubscription.status='canceled';
 await processMemberStripeEvent(event('evt_late','customer.subscription.updated',{id:'sub_1',status:'active'}),{stripe,mode:'test',pool});
 assert.equal((await pool.query('SELECT status FROM member_subscriptions WHERE user_id=1'))[0][0].status,'canceled');

 const order={localLineOrderId:10,payment:{status:'PAID',store_credit_amount:20},status:'OPEN'};
 await reconcileMemberOrder({link,order,dividendRateBp:300},pool);
 await reconcileMemberOrder({link,order,dividendRateBp:999},pool);
 const updated=await reconcileMemberOrder({link,order:{...order,payment:{status:'PAID',store_credit_amount:30}},dividendRateBp:999},pool);
 assert.equal(updated.deltaCents,1000);assert.equal(updated.dividendDeltaCents,30,'Original dividend policy is preserved');
 await assert.rejects(reconcileMemberOrder({link,order:{...order,status:'CANCELLED'},dividendRateBp:300},pool),/refund evidence/);
 const partial=await reconcileMemberOrder({link,order:{...order,status:'CANCELLED'},dividendRateBp:300,refundEvidence:{transactionIds:['remote-refund'],cumulativeRefundCents:1500}},pool);
 assert.equal(partial.deltaCents,-1500);assert.equal(partial.dividendDeltaCents,-45);

 // No inferred opening-balance transfer: a remote purchase does not trigger a top-up.
 const history=[{id:1,transaction_type:'ORDER_DEBIT',amount:-20,store_credit_balance:80}],posts=[];
 const options={userId:1,fetchTransactions:async()=>structuredClone(history),postTransaction:async body=>{posts.push(body);history.unshift({id:2,transaction_type:body.transactionType,amount:Math.abs(body.amountCents)/100,note:body.note,store_credit_balance:90});throw new Error('lost transfer response');}};
 await processLocalLineEventTransfers({...options,dryRun:false},pool);
 assert.equal(posts.length,0,'Test-mode funding cannot touch live Local Line');
 process.env.MEMBER_CREDIT_TRANSFERS_ENABLED='true';
 const db=await pool.getConnection();await db.beginTransaction();
 await postMemberEvent(db,{source:'approved_fixture',sourceId:'funding-1',userId:1,kind:'funding',facts:{approved:true},postings:[{account:'wallet',key:'funding',amountCents:1000}],transfer:{amountCents:1000,providerMode:'live'}});
 await db.commit();db.release();
 await processLocalLineEventTransfers(options,pool);
 assert.equal(posts.length,1);
 await processLocalLineEventTransfers(options,pool);
 assert.equal(posts.length,1,'An uncertain transfer is confirmed from history, never resent');
 assert.equal((await pool.query("SELECT COUNT(*) n FROM member_financial_operations WHERE provider='localline' AND provider_mode='live' AND status='completed'"))[0][0].n,1);

 await t.test('old uncertain provider steps hold before the idempotency retention window can expire',async()=>{
  let attempts=0;
  const command={userId:3,mode:'test',kind:'retention_fixture',requestKey:'retention-request-1',input:{amount:500},prepare:async()=>({}),execute:({step})=>step('charge',{amount:500},async()=>{attempts++;throw new Error('unknown provider outcome');})};
  await assert.rejects(runMemberOperation(command,pool),/unknown provider outcome/);
  await pool.query("UPDATE member_financial_steps s JOIN member_financial_operations o ON o.id=s.operation_id SET s.attempted_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR) WHERE o.kind='retention_fixture'");
  await assert.rejects(runMemberOperation(command,pool),/uncertain outcome/);
  assert.equal(attempts,1,'An expired provider idempotency key is never automatically resent');
 });

 await t.test('authenticated HTTP routes reject arbitrary linking and cross-member financial reads',async()=>{
  Object.assign(process.env,{STORE_DB_HOST:'127.0.0.1',STORE_DB_PORT:'1',STORE_DB_DATABASE:database,STORE_DB_USER:'root',STORE_DB_PASSWORD:'',JWT_SECRET:'synthetic-test-secret',LL_USERNAME:'test',LL_PASSWORD:'test'});
  const {getPool}=await import('../db.js'),appPool=getPool();appPool.pool.config.connectionConfig.socketPath=socket;
  t.after(()=>appPool.end());
  await pool.query("INSERT INTO member_external_account_links(user_id,provider,external_customer_id,metadata_json) VALUES(2,'localline','200','{\"linkedBy\":\"storefront_login\"}')");
  const {default:router}=await import('../routes/member.js');
  const app=express();app.use(express.json());app.use('/api/member',router);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=(path,{method='GET',userId=2,body=null}={})=>new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:`/api/member/${path}`,method,headers:{'Content-Type':'application/json',...(userId?{Authorization:`Bearer ${jwt.sign({userId},process.env.JWT_SECRET)}`}:{})}},res=>{
    let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
   });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try {
   assert.equal((await request('localline-link',{method:'POST',body:{externalCustomerId:'100'}})).status,410);
   assert.equal((await request('localline-link',{method:'POST',userId:null,body:{externalCustomerId:'100'}})).status,401);
   assert.match((await request('localline/customer')).body.error,/Unable to load|verification/);
   assert.notEqual((await request('localline/customer')).status,200);
   assert.equal((await request(`operations/${first.operationId}`)).status,404);
   assert.equal((await request(`operations/${first.operationId}`,{userId:1})).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
});
