import { getPool } from '../db.js';
import { getStripeClient } from './memberPortal.js';
import { assertFinancialSchema } from './memberFinancialSchema.js';
import { stripeMode, json } from './memberFinancialOperations.js';
import { runMemberBilling } from './memberBilling.js';
import { processMemberStripeEvent } from './memberStripeEvents.js';

export async function runMemberFinancialMaintenance({pool=getPool(),stripe=getStripeClient(),mode=null}={}) {
  await assertFinancialSchema(pool);
  if(!stripe)return {ok:false,reason:'Stripe is not configured; financial work remains queued.'};
  mode ||= stripeMode();
  const results=[];
  const [operations]=await pool.query("SELECT * FROM member_financial_operations WHERE provider='stripe' AND provider_mode=? AND status IN ('running','uncertain') ORDER BY created_at LIMIT 100",[mode]);
  for(const op of operations){
    try {results.push(await runMemberBilling({userId:op.user_id,kind:op.kind,requestKey:op.request_key,input:json(op.request_json).input || {},stripe,mode,recovery:true},pool));}
    catch(e){results.push({operationId:op.id,held:true,error:e.message});}
  }
  const [events]=await pool.query("SELECT payload_json FROM member_stripe_inbox WHERE provider_mode=? AND status<>'completed' ORDER BY created_at LIMIT 200",[mode]);
  for(const row of events){
    try {results.push(await processMemberStripeEvent(json(row.payload_json),{stripe,mode,pool}));}
    catch(e){results.push({held:true,error:e.message});}
  }
  return {ok:!results.some(row=>row.held),results};
}
