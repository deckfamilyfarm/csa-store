import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invoiceFundingFacts,cumulativeRefund} from './memberStripeEvents.js';
import {orderCreditFacts} from './memberOrderReconciliation.js';
import {matchTransferReceipt} from './memberCreditTransfers.js';
import {requireVerifiedLocalLineLink} from './memberExternalLinks.js';
import {cents,hash} from './memberFinancialOperations.js';

test('invoice credit uses frozen policy and preserves an actual zero cash payment',()=>{
 const facts=invoiceFundingFacts({id:'in_1',status:'paid',currency:'usd',amount_paid:0},{creditCents:20000,feeCents:500});
 assert.equal(facts.cashReceivedCents,0);assert.equal(facts.bonusCents,20000);
 assert.throws(()=>invoiceFundingFacts({status:'paid',currency:'usd'},{creditCents:20000,feeCents:500}),/missing/);
 assert.throws(()=>cents(1.5),/integer cents/);
});
test('partial and full funding refunds reverse the original credit and fee proportionately',()=>{
 const facts={cashReceivedCents:19000,creditCents:20000,feeCents:500};
 assert.deepEqual(cumulativeRefund(facts,9500),{creditCents:10000,feeCents:250});
 assert.deepEqual(cumulativeRefund(facts,19000),{creditCents:20000,feeCents:500});
 assert.throws(()=>cumulativeRefund(facts,19001));
});
test('paid cash-only orders do not debit credit; absent credit and unproven refunds hold',()=>{
 assert.equal(orderCreditFacts({payment:{status:'PAID',store_credit_amount:0},total:200}).debitCents,0);
 assert.throws(()=>orderCreditFacts({payment:{status:'PAID'},total:200}),/explicit store-credit/);
 assert.throws(()=>orderCreditFacts({status:'CANCELLED',payment:{status:'PAID',store_credit_amount:20}},{debitCents:2000}),/refund evidence/);
 assert.throws(()=>orderCreditFacts({payment:{status:'PAID',store_credit_amount:10}},{debitCents:2000}),/refund evidence/);
 assert.equal(orderCreditFacts({status:'CANCELLED',payment:{status:'REFUNDED',store_credit_amount:20}},{debitCents:2000},{transactionIds:['refund-1'],cumulativeRefundCents:750}).debitCents,1250);
});
test('a transfer receipt requires exactly one matching operation, amount and type',()=>{
 const tx={id:1,note:'CSA Store event transfer op-1',amount:10,transaction_type:'MANUAL_CREDIT'};
 assert.equal(matchTransferReceipt([tx],'op-1',1000).id,1);
 assert.equal(matchTransferReceipt([tx],'op-2',1000),null);
 assert.throws(()=>matchTransferReceipt([tx,{...tx,id:2}],'op-1',1000),/Multiple/);
 assert.throws(()=>matchTransferReceipt([{...tx,amount:9}],'op-1',1000),/different/);
 assert.throws(()=>matchTransferReceipt([tx],'op-1',-1000),/different/);
});
test('external customer metadata alone never verifies ownership',async()=>{
 const db={query:async()=>[[]]};
 await assert.rejects(requireVerifiedLocalLineLink({id:1,userId:2,metadataJson:'{"linkedBy":"storefront_login"}'},2,db),{status:403});
 await assert.rejects(requireVerifiedLocalLineLink({id:1,userId:3},2,{query(){assert.fail('wrong owner must fail before SQL');}}),{status:403});
 assert.equal(hash({a:1,b:2}),hash({b:2,a:1}));
});
