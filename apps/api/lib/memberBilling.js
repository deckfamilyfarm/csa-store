import { getPool } from '../db.js';
import { financialError } from './memberFinancialSchema.js';
import { runMemberOperation, stripeMode, cents } from './memberFinancialOperations.js';

// Stripe methods are injected for tests. No client-supplied prices or provider bodies.
export async function runMemberBilling({ userId, kind, requestKey, input = {}, stripe, mode = stripeMode(), plan = null, priceId = null, anchor = null, recovery = false }, pool = getPool()) {

  if (!['customer', 'setup', 'subscription', 'pause', 'resume', 'cancel', 'paused_fee'].includes(kind)) throw financialError('Unsupported billing command.', 400);
  return runMemberOperation({ userId, kind, requestKey, input, mode, requireExisting: recovery || process.env.MEMBER_BILLING_ENABLED !== 'true',
    prepare: async db => {
      const [[subscription]] = await db.query('SELECT * FROM member_subscriptions WHERE user_id=?', [userId]);
      const [[profile]] = await db.query('SELECT p.*,u.email FROM member_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=?', [userId]);
      const [[settings]] = await db.query('SELECT * FROM subscription_settings ORDER BY id LIMIT 1');
      if (!subscription || !profile) throw financialError('Complete your member profile first.', 400);
      if (kind === 'subscription' && (!plan || !priceId || !anchor)) throw financialError('A configured plan and billing date are required.', 400);
      const [[lastPolicy]]=await db.query('SELECT MAX(effective_at) AS effectiveAt FROM member_subscription_policies WHERE stripe_subscription_id=?',[subscription.stripe_subscription_id || '']);
      const request = { subscription, profile: { email: profile.email, name: `${profile.first_name} ${profile.last_name}`, phone: profile.phone },
        plan, priceId, anchor, input, policy: { planKey: plan?.key, creditCents: plan?.amountCents, feeCents: Number(settings?.herdshare_monthly_fee_cents ?? 500), priceId }, effectiveAt: Math.max(Math.floor(Date.now()/1000),Number(lastPolicy.effectiveAt || 0)+1) };
      if (kind === 'paused_fee') {
        const [[herdshare]] = await db.query('SELECT * FROM member_herdshare_statuses WHERE user_id=?', [userId]);
        if (subscription.status !== 'paused' || herdshare?.status !== 'active' || !herdshare.next_billing_date ||
            new Date(herdshare.next_billing_date).getTime() > Date.now()) throw financialError('No paused membership fee is due.');
        const period = new Date(herdshare.next_billing_date).toISOString().slice(0,10);
        if (input.period !== period) throw financialError('The billing period changed. Refresh before billing.');
        const [[legacy]]=await db.query("SELECT id FROM member_ledger_entries WHERE user_id=? AND reference_type='stripe_payment' AND reference_id=? LIMIT 1",[userId,`paused-herdshare:${userId}:${period}`]);
        if(legacy)throw financialError('This fee period has a legacy payment record. Reconcile it before billing again.');
        request.herdshare = herdshare;
        request.feeCents = cents(Number(herdshare.monthly_fee_cents ?? 500));
      }
      return request;
    },
    execute: async ({ db, request: r, operation, step }) => {
      let customerId = r.subscription.stripe_customer_id;
      if (!customerId) {
        const customer = await step('customer', { ...r.profile, metadata: { userId: String(userId), source: 'csa-store', operationId: operation.id } }, (body, options) => stripe.customers.create(body, options));
        customerId = customer.id;
        await db.query('UPDATE member_subscriptions SET stripe_customer_id=?,updated_at=UTC_TIMESTAMP() WHERE user_id=?', [customerId,userId]);
      }
      if (kind === 'customer') return { stripeCustomerId: customerId };
      if (kind === 'setup') {
        const intent = await step('setup', { customer: customerId, usage: 'off_session', payment_method_types: ['card'] }, (body, options) => stripe.setupIntents.create(body, options));
        return { clientSecret: intent.client_secret, stripeCustomerId: customerId };
      }
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.deleted) throw Object.assign(financialError('The Stripe customer was deleted.'), {hold:true});
      const method = customer.invoice_settings?.default_payment_method;
      let subscriptionId = r.subscription.stripe_subscription_id;
      if (kind === 'subscription') {
        if (!method) throw financialError('Add a default payment method before activating your subscription.',400);
        const metadata = { userId:String(userId),planKey:r.plan.key,operationId:operation.id };
        let live = null;
        if (subscriptionId) live = await stripe.subscriptions.retrieve(subscriptionId); // Failure never authorizes replacement.
        if (live && ['canceled','incomplete_expired'].includes(live.status)) live = null;
        let subscription;
        if (live) {
          if (live.items?.data?.length !== 1) throw Object.assign(financialError('Review the existing subscription items before changing its plan.'),{hold:true});
          subscription = await step('subscription_update', { id:subscriptionId, body:{ items:[{id:live.items.data[0].id,price:r.priceId}], default_payment_method:method,
            proration_behavior:'none',...(Number(r.subscription.billing_day_of_month)!==Number(r.input.billingDayOfMonth)?{trial_end:r.anchor}:{}),metadata } }, ({id,body},options) => stripe.subscriptions.update(id,body,options));
        } else {
          subscription = await step('subscription_create', { customer:customerId,items:[{price:r.priceId}],default_payment_method:method,
            billing_cycle_anchor:r.anchor,proration_behavior:'none',collection_method:'charge_automatically',payment_behavior:'allow_incomplete',metadata }, (body,options)=>stripe.subscriptions.create(body,options));
        }
        subscriptionId = subscription.id;
        await db.beginTransaction();
        try {
          await db.query(`INSERT INTO member_subscription_policies (stripe_subscription_id,effective_at,user_id,provider_mode,policy_json,operation_id)
            VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE stripe_subscription_id=VALUES(stripe_subscription_id)`, [subscriptionId,r.effectiveAt,userId,mode,JSON.stringify(r.policy),operation.id]);
          await db.query(`UPDATE member_subscriptions SET stripe_subscription_id=?,stripe_customer_id=?,plan_key=?,plan_amount_cents=?,billing_day_of_month=?,
            status=?,next_billing_date=?,current_period_start=?,current_period_end=?,paused_at=NULL,canceled_at=NULL,updated_at=UTC_TIMESTAMP() WHERE user_id=?`,
            [subscriptionId,customerId,r.plan.key,r.plan.amountCents,r.input.billingDayOfMonth,subscription.pause_collection?'paused':subscription.status,
              new Date((subscription.current_period_end || r.anchor)*1000),new Date((subscription.current_period_start || r.effectiveAt)*1000),new Date((subscription.current_period_end || r.anchor)*1000),userId]);
          await db.query("UPDATE member_herdshare_statuses SET monthly_fee_cents=?,status='active',next_billing_date=?,updated_at=UTC_TIMESTAMP() WHERE user_id=?", [r.policy.feeCents,new Date(r.anchor*1000),userId]);
          await db.commit();
        } catch(e) { await db.rollback(); throw e; }
        if (!live) {
          // A dedicated invoice cannot consume unrelated pending invoice items.
          const invoice = await step('initial_invoice', {customer:customerId,auto_advance:false,pending_invoice_items_behavior:'exclude',collection_method:'charge_automatically',
            metadata:{...metadata,billingKind:'initial_subscription_charge'}}, (body,options)=>stripe.invoices.create(body,options));
          await step('initial_item', {customer:customerId,invoice:invoice.id,amount:r.plan.amountCents,currency:'usd',description:`Initial ${r.plan.label} subscription charge`,metadata}, (body,options)=>stripe.invoiceItems.create(body,options));
          await step('initial_finalize', {id:invoice.id,body:{auto_advance:false}}, ({id,body},options)=>stripe.invoices.finalizeInvoice(id,body,options));
          let paid = await step('initial_pay', {id:invoice.id,body:{}}, ({id,body},options)=>stripe.invoices.pay(id,body,options));
          if(paid.status!=='paid')paid=await stripe.invoices.retrieve(invoice.id);
          if (paid.status !== 'paid') throw financialError('The initial invoice is not paid. Keep this operation for recovery.');
        }
        return { stripeSubscriptionId:subscriptionId };
      }
      if (kind === 'paused_fee') {
        if (!method) throw financialError('No default payment method is available.',400);
        let intent = await step('paused_fee', {amount:r.feeCents,currency:'usd',customer:customerId,payment_method:method,off_session:true,confirm:true,
          metadata:{userId:String(userId),operationId:operation.id,billingType:'paused_herdshare'},description:'Paused subscription herdshare charge'}, (body,options)=>stripe.paymentIntents.create(body,options));
        if(intent.status!=='succeeded')intent=await stripe.paymentIntents.retrieve(intent.id);
        if((intent.customer!==undefined && (typeof intent.customer==='string'?intent.customer:intent.customer?.id)!==customerId) ||
          (intent.amount!==undefined && Number(intent.amount)!==r.feeCents) || (intent.currency!==undefined && intent.currency!=='usd'))throw Object.assign(financialError('The paused fee receipt does not match its frozen customer, amount and currency.'),{hold:true});
        if (intent.status !== 'succeeded') throw financialError('The paused membership fee has not succeeded.');
        const { postMemberEvent } = await import('./memberFinancialOperations.js');
        await db.beginTransaction();
        try {
          // Paid in cash: record fee expense and equal cash funding, never debit the wallet twice.
          await postMemberEvent(db,{source:'stripe_paused_fee',sourceId:`${mode}:${intent.id}`,userId,kind:'paused_herdshare',facts:{operationId:operation.id,feeCents:r.feeCents,paymentIntentId:intent.id},
            postings:[{account:'wallet',key:'cash',amountCents:r.feeCents},{account:'wallet',key:'fee',amountCents:-r.feeCents}]});
          const next = new Date(r.herdshare.next_billing_date); next.setUTCMonth(next.getUTCMonth()+1);
          await db.query('UPDATE member_herdshare_statuses SET next_billing_date=?,updated_at=UTC_TIMESTAMP() WHERE user_id=? AND next_billing_date=?', [next,userId,new Date(r.herdshare.next_billing_date)]);
          await db.commit();
        } catch(e) {await db.rollback();throw e;}
        return {paymentIntentId:intent.id,chargedCents:r.feeCents};
      }
      if (!subscriptionId) throw financialError('Subscription not found.',404);
      const live = await stripe.subscriptions.retrieve(subscriptionId);
      if (kind !== 'cancel' && live.status === 'canceled') throw Object.assign(financialError('The subscription is canceled. It cannot be resumed.'),{hold:true});
      const remote = kind === 'cancel'
        ? live.status === 'canceled' ? live : await step('cancel',{id:subscriptionId,body:{invoice_now:false,prorate:false}},({id,body},options)=>stripe.subscriptions.cancel(id,body,options))
        : await step(kind,{id:subscriptionId,body:{pause_collection:kind==='pause'?{behavior:'mark_uncollectible'}:''}},({id,body},options)=>stripe.subscriptions.update(id,body,options));
      const status = remote.status === 'canceled' ? 'canceled' : remote.pause_collection ? 'paused' : remote.status;
      await db.query('UPDATE member_subscriptions SET status=?,paused_at=?,canceled_at=?,updated_at=UTC_TIMESTAMP() WHERE user_id=?', [status,status==='paused'?new Date():null,status==='canceled'?new Date():null,userId]);
      return {stripeSubscriptionId:subscriptionId,subscriptionStatus:status};
    }
  }, pool);
}
