import { getPool } from '../db.js';
import { withMemberLock, json, cents } from './memberFinancialOperations.js';
import { requireVerifiedLocalLineLink } from './memberExternalLinks.js';
import { financialError } from './memberFinancialSchema.js';

export function matchTransferReceipt(transactions, operationId, amountCents) {
  const note=`CSA Store event transfer ${operationId}`;
  const matches=transactions.filter(row=>String(row.note || row.description || '')===note);
  if (matches.length>1) throw financialError('Multiple Local Line transactions match this operation. Review them before continuing.');
  if (!matches.length) return null;
  const row=matches[0],type=amountCents>0?'MANUAL_CREDIT':'MANUAL_DEBIT';
  if (!row.id || String(row.transaction_type || row.transactionType)!==type || Math.round(Math.abs(Number(row.amount))*100)!==Math.abs(amountCents)) throw financialError('The matching Local Line transaction has different financial facts.');
  return row;
}

export async function listLocalLineEventTransfers({userId=null}={},db=getPool()) {
  const [rows]=await db.query(`SELECT id,user_id,status,request_json,error_message,updated_at FROM member_financial_operations
    WHERE provider='localline' AND kind='event_transfer' ${userId?'AND user_id=?':''} ORDER BY created_at,id LIMIT 500`,userId?[userId]:[]);
  return rows.map(row=>({operationId:row.id,userId:row.user_id,status:row.status,amountCents:json(row.request_json).amountCents,error:row.error_message,updatedAt:row.updated_at}));
}

export async function processLocalLineEventTransfers({userId=null,dryRun=false,fetchTransactions,postTransaction},pool=getPool()) {
  const queue=await listLocalLineEventTransfers({userId},pool),results=[];
  for(const item of queue.filter(row=>row.status!=='completed')) {
    try {
      const result=await withMemberLock(item.userId,async db=>{
        const [[op]]=await db.query('SELECT * FROM member_financial_operations WHERE id=?',[item.operationId]);
        if(op.status==='completed')return {operationId:op.id,status:'completed'};
        if(op.provider_mode!=='live')throw financialError('Test-mode funding never transfers credit to live Local Line.');
        const request=json(op.request_json),amount=cents(request.amountCents);
        const [[source]]=await db.query('SELECT * FROM member_financial_events WHERE id=? AND user_id=? AND status=\'posted\'',[request.eventId,item.userId]);
        if(!source)throw financialError('The source financial event is missing.');
        const originalEventId=json(source.facts_json).originalEventId;
        if(originalEventId){
          const [[funding]]=await db.query("SELECT status FROM member_financial_operations WHERE user_id=? AND provider='localline' AND request_key=?",[item.userId,`event:${originalEventId}`]);
          if(funding?.status!=='completed')throw financialError('Confirm the original funding transfer before sending its refund. No debit was sent.');
        }
        const [[link]]=await db.query("SELECT * FROM member_external_account_links WHERE user_id=? AND provider='localline'",[item.userId]);
        await requireVerifiedLocalLineLink(link,item.userId,db,{creditReady:true});
        if(request.externalCustomerId && request.externalCustomerId!==link.external_customer_id)throw financialError('The Local Line owner changed after this transfer was frozen.');
        const frozen={...request,externalCustomerId:link.external_customer_id};
        let history=await fetchTransactions(frozen.externalCustomerId,{fullHistory:true}); // Failure cannot authorize a write.
        let receipt=matchTransferReceipt(history,op.id,amount);
        const [[attempt]]=await db.query("SELECT * FROM member_financial_steps WHERE operation_id=? AND step_key='transfer'",[op.id]);
        if(dryRun)return {...item,status:receipt?'ready_to_confirm':attempt?'needs_reconciliation':'ready',dryRun};
        if(!receipt && attempt)throw financialError('Transfer outcome is uncertain. No duplicate will be sent; reconcile the original Local Line transaction.');
        if(!receipt) {
          if(process.env.MEMBER_CREDIT_TRANSFERS_ENABLED!=='true')throw financialError('New Local Line credit transfers are paused pending starting-balance reconciliation.',503);
          const body={externalCustomerId:frozen.externalCustomerId,amountCents:amount,transactionType:amount>0?'MANUAL_CREDIT':'MANUAL_DEBIT',note:`CSA Store event transfer ${op.id}`};
          // Freeze the target and journal the attempt before the irreversible POST.
          await db.beginTransaction();
          try {
            await db.query('UPDATE member_financial_operations SET request_json=?,status=\'running\',updated_at=UTC_TIMESTAMP(3) WHERE id=?',[JSON.stringify(frozen),op.id]);
            await db.query(`INSERT INTO member_financial_steps (operation_id,step_key,request_json,idempotency_key,status,attempted_at,updated_at)
              VALUES (?,'transfer',?,?,'attempted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[op.id,JSON.stringify(body),op.id]);
            await db.commit();
          }catch(e){await db.rollback();throw e;}
          const response=await postTransaction(body);
          await db.query("UPDATE member_financial_steps SET receipt_json=?,updated_at=UTC_TIMESTAMP(3) WHERE operation_id=? AND step_key='transfer'",[JSON.stringify(response),op.id]);
          history=await fetchTransactions(frozen.externalCustomerId,{fullHistory:true});
          receipt=matchTransferReceipt(history,op.id,amount);
          if(!receipt)throw financialError('Local Line has not confirmed the transfer yet. It will be reconciled without resending.');
        }
        await db.beginTransaction();
        try {
          await db.query("UPDATE member_financial_operations SET status='completed',result_json=?,error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[JSON.stringify({remoteTransactionId:String(receipt.id)}),op.id]);
          await db.query("UPDATE member_financial_steps SET status='confirmed',receipt_json=?,updated_at=UTC_TIMESTAMP(3) WHERE operation_id=? AND step_key='transfer'",[JSON.stringify(receipt),op.id]);
          // Mirrors are observations, never a speculative wallet total.
          const balance=history[0]?.store_credit_balance ?? history[0]?.storeCreditBalance;
          if(balance!==null && balance!==undefined && Number.isFinite(Number(balance)))await db.query(`UPDATE member_credit_mirrors SET last_known_balance_cents=?,last_mirrored_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE external_link_id=?`,[Math.round(Number(balance)*100),link.id]);
          await db.commit();
        }catch(e){await db.rollback();throw e;}
        return {operationId:op.id,status:'completed',remoteTransactionId:String(receipt.id)};
      },pool);
      results.push(result);
    }catch(error){
      if(!dryRun)await pool.query("UPDATE member_financial_operations SET status='held',error_message=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND status<>'completed'",[error.message,item.operationId]);
      results.push({...item,held:true,error:error.message});
    }
  }
  return {ok:!results.some(row=>row.held),dryRun,count:results.length,results};
}
