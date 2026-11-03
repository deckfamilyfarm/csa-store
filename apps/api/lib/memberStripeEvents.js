import { getPool } from '../db.js';
import { assertFinancialSchema, financialError } from './memberFinancialSchema.js';
import { withMemberLock, postMemberEvent, json, cents, stripeMode } from './memberFinancialOperations.js';

const idOf = value => typeof value === 'string' ? value : value?.id;
export const invoiceSubscriptionId = invoice => idOf(invoice.subscription) || idOf(invoice.parent?.subscription_details?.subscription);
function hold(message) { return Object.assign(financialError(message), { hold: true }); }
function money(value, name) { if (value === null || value === undefined) throw hold(`${name} is missing.`); return cents(Number(value), name); }

export function invoiceFundingFacts(invoice, policy) {
  if (invoice.status !== 'paid' || invoice.currency !== 'usd') throw hold('Only confirmed paid USD funding invoices can post member credit.');
  const cashReceivedCents = money(invoice.amount_paid, 'Invoice amount paid');
  const creditCents = money(policy.creditCents, 'Frozen credit policy');
  const feeCents = money(policy.feeCents, 'Frozen membership fee');
  if (cashReceivedCents < 0 || creditCents <= 0 || feeCents < 0 || feeCents > creditCents) throw hold('Invalid funding policy.');
  return { invoiceId: invoice.id, cashReceivedCents, creditCents, feeCents, bonusCents: Math.max(0, creditCents-cashReceivedCents), policy };
}
export function cumulativeRefund(facts, refundedCents) {
  const cash = money(facts.cashReceivedCents, 'Original cash paid');
  money(refundedCents, 'Cumulative refund');
  if (cash <= 0 || refundedCents < 0 || refundedCents > cash) throw hold('Refund cannot be attributed to the original paid funding amount.');
  const proportion = amount => Number((BigInt(amount)*BigInt(refundedCents)+BigInt(Math.floor(cash/2)))/BigInt(cash));
  return { creditCents: proportion(facts.creditCents), feeCents: proportion(facts.feeCents) };
}

async function findInvoiceOwner(db, invoice, mode) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId) {
    // The period, not today's member plan, determines credit and fees.
    const effective = Number(invoice.period_start);
    if (!Number.isSafeInteger(effective)) throw hold('The invoice billing period is missing.');
    const [[row]] = await db.query(`SELECT * FROM member_subscription_policies WHERE stripe_subscription_id=? AND provider_mode=? AND effective_at<=? ORDER BY effective_at DESC LIMIT 1`, [subscriptionId,mode,effective]);
    if (!row) throw hold('No reviewed historical funding policy exists for this subscription period.');
    // New subscriptions use a dedicated initial funding invoice. Stripe may
    // also emit an empty anchor invoice; it must not grant a second plan credit.
    if(invoice.billing_reason==='subscription_create' && Number(invoice.amount_paid)===0)return null;
    if (invoice.billing_reason !== 'subscription_cycle') throw hold('This is not a normal subscription funding cycle. Review its invoice attribution.');
    const policy = json(row.policy_json);
    const lines = invoice.lines?.data || [];
    if (!lines.some(line => (idOf(line.price) || idOf(line.pricing?.price_details?.price)) === policy.priceId && !line.proration && Number(line.amount) > 0)) throw hold('Invoice has no matching membership funding line.');
    return { userId:row.user_id, policy };
  }
  const operationId = invoice.metadata?.operationId;
  if (!operationId || invoice.metadata?.billingKind !== 'initial_subscription_charge') return null;
  const [[op]] = await db.query("SELECT * FROM member_financial_operations WHERE id=? AND provider='stripe' AND provider_mode=? AND kind='subscription'", [operationId,mode]);
  const [[step]] = await db.query("SELECT receipt_json FROM member_financial_steps WHERE operation_id=? AND step_key='initial_invoice' AND status='confirmed'", [operationId]);
  if (!op || !step || json(step.receipt_json).id !== invoice.id) throw hold('Initial invoice operation receipt has not been confirmed.');
  const request = json(op.request_json);
  let customerId=request.subscription.stripe_customer_id;
  if(!customerId){
    const [[customerStep]]=await db.query("SELECT receipt_json FROM member_financial_steps WHERE operation_id=? AND step_key='customer' AND status='confirmed'",[operationId]);
    customerId=customerStep ? json(customerStep.receipt_json).id : null;
  }
  if (!customerId || idOf(invoice.customer) !== customerId) throw hold('Funding invoice customer differs from the operation.');
  return { userId:op.user_id, policy:request.policy };
}

async function postInvoice(invoice, mode, pool) {
  const owner = await findInvoiceOwner(pool,invoice,mode);
  if (!owner) return { ignored:true, reason:'Unrelated invoice; no funding operation or subscription mapping.' };
  return withMemberLock(owner.userId, async db => {
    await db.beginTransaction();
    try {
      const facts = invoiceFundingFacts(invoice,owner.policy);
      const [[legacy]] = await db.query("SELECT id FROM member_ledger_entries WHERE user_id=? AND reference_type='stripe_invoice' AND reference_id IN (?,?) LIMIT 1", [owner.userId,invoice.id,`${invoice.id}:herdshare`]);
      if (legacy) throw hold('This invoice has legacy postings. Reconcile them before adopting the financial event.');
      const result = await postMemberEvent(db,{source:'stripe_invoice',sourceId:`${mode}:${invoice.id}`,userId:owner.userId,kind:'subscription_funding',facts,
        postings:[{account:'wallet',key:'credit',entryType:'subscription_deposit',amountCents:facts.creditCents},{account:'wallet',key:'fee',entryType:'herdshare_charge',amountCents:-facts.feeCents}],
        transfer:{providerMode:mode,amountCents:facts.creditCents-facts.feeCents,reason:`Funding invoice ${invoice.id}`}});
      // Payment does not reactivate a canceled or paused subscription.
      await db.query('UPDATE member_subscriptions SET last_deposit_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE user_id=?', [owner.userId]);
      await db.commit(); return result;
    } catch(e) {await db.rollback();throw e;}
  },pool);
}

async function postRefund(charge, mode, pool) {
  const invoiceId = idOf(charge.invoice);
  if (!invoiceId) return { ignored:true,reason:'Charge is not attributed to a membership funding invoice.' };
  const [[original]] = await pool.query("SELECT * FROM member_financial_events WHERE source='stripe_invoice' AND source_id=?", [`${mode}:${invoiceId}`]);
  if (!original) throw hold('Funding invoice must be reconciled before its refund.');
  const facts = json(original.facts_json);
  if(charge.currency!=='usd' || Number(charge.amount)!==Number(facts.cashReceivedCents)) throw hold('This charge is not the single original funding payment. Review split-payment refunds.');
  const cumulative = money(charge.amount_refunded,'Refunded amount');
  const target = cumulativeRefund(facts,cumulative);
  return withMemberLock(original.user_id,async db=>{
    await db.beginTransaction();
    try {
      const [prior] = await db.query("SELECT facts_json FROM member_financial_events WHERE source='stripe_funding_refund' AND user_id=? AND JSON_UNQUOTE(JSON_EXTRACT(facts_json,'$.invoiceId'))=?", [original.user_id,invoiceId]);
      const previous = prior.reduce((best,row)=>Math.max(best,Number(json(row.facts_json).cumulativeRefundCents||0)),0);
      if (cumulative <= previous) {await db.commit();return {duplicate:true};}
      const before = previous ? cumulativeRefund(facts,previous) : {creditCents:0,feeCents:0};
      const credit = target.creditCents-before.creditCents, fee=target.feeCents-before.feeCents;
      const result = await postMemberEvent(db,{source:'stripe_funding_refund',sourceId:`${mode}:${invoiceId}:${cumulative}`,userId:original.user_id,kind:'funding_refund',
        facts:{invoiceId,cumulativeRefundCents:cumulative,originalEventId:original.id,creditCents:credit,feeCents:fee},
        postings:[{account:'wallet',key:'credit_reversal',entryType:'subscription_refund',amountCents:-credit},{account:'wallet',key:'fee_reversal',entryType:'herdshare_refund',amountCents:fee}],
        transfer:{providerMode:mode,amountCents:-credit+fee,reason:`Refund for funding invoice ${invoiceId}`}});
      await db.commit();return result;
    }catch(e){await db.rollback();throw e;}
  },pool);
}

export async function processMemberStripeEvent(event, { stripe, mode = stripeMode(), pool = getPool() }) {
  await assertFinancialSchema(pool);
  if (typeof event.livemode !== 'boolean' || (event.livemode?'live':'test') !== mode) throw financialError('Webhook provider mode does not match this deployment.',400);
  await pool.query(`INSERT IGNORE INTO member_stripe_inbox (event_id,event_type,provider_mode,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,?,'pending',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [event.id,event.type,mode,JSON.stringify(event)]);
  const [[saved]] = await pool.query('SELECT * FROM member_stripe_inbox WHERE event_id=?',[event.id]);
  if (saved.status === 'completed') return {received:true,duplicate:true};
  const frozen = json(saved.payload_json), object=frozen.data.object;
  try {
    let result = {ignored:true};
    if (frozen.type === 'invoice.paid') result = await postInvoice(object,mode,pool);
    else if (frozen.type === 'charge.refunded') {
      const current = await stripe.charges.retrieve(object.id);
      result = await postRefund(current,mode,pool);
    } else if (frozen.type.startsWith('customer.subscription.')) {
      const [[policy]] = await pool.query('SELECT user_id FROM member_subscription_policies WHERE stripe_subscription_id=? AND provider_mode=? LIMIT 1',[object.id,mode]);
      if (policy) result = await withMemberLock(policy.user_id,async db=>{
        // Current provider state prevents delayed events undoing cancellation/pause.
        const current = await stripe.subscriptions.retrieve(object.id);
        const status = current.status === 'canceled' ? 'canceled' : current.pause_collection ? 'paused' : current.status;
        await db.query('UPDATE member_subscriptions SET status=?,paused_at=?,canceled_at=?,updated_at=UTC_TIMESTAMP() WHERE user_id=? AND stripe_subscription_id=?',
          [status,status==='paused'?new Date():null,status==='canceled'?new Date():null,policy.user_id,object.id]);
        return {subscriptionStatus:status};
      },pool);
    } else if (frozen.type === 'invoice.payment_failed') {
      const subId = invoiceSubscriptionId(object);
      if (subId) {
        const [[policy]] = await pool.query('SELECT user_id FROM member_subscription_policies WHERE stripe_subscription_id=? AND provider_mode=? LIMIT 1',[subId,mode]);
        if (policy) {
          result = await withMemberLock(policy.user_id,async db=>{
            const current = await stripe.subscriptions.retrieve(subId);
            await db.query('UPDATE member_subscriptions SET status=?,updated_at=UTC_TIMESTAMP() WHERE user_id=? AND stripe_subscription_id=?', [current.status==='canceled'?'canceled':current.pause_collection?'paused':current.status,policy.user_id,subId]);
            return {subscriptionStatus:current.status};
          },pool);
        }
      }
    }
    await pool.query("UPDATE member_stripe_inbox SET status='completed',error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE event_id=?",[event.id]);
    return {received:true,...result};
  } catch(error) {
    await pool.query('UPDATE member_stripe_inbox SET status=?,error_message=?,updated_at=UTC_TIMESTAMP(3) WHERE event_id=?',[error.hold?'held':'pending',error.message,event.id]);
    if (error.hold) return {received:true,held:true,reason:error.message};
    throw error;
  }
}
