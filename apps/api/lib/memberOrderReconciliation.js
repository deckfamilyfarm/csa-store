import { getPool } from '../db.js';
import { withMemberLock, postMemberEvent, hash, json, cents } from './memberFinancialOperations.js';
import { requireVerifiedLocalLineLink } from './memberExternalLinks.js';
import { financialError } from './memberFinancialSchema.js';

export function orderCreditFacts(order, previous = null, refundEvidence = null) {
  refundEvidence ||= previous?.refundEvidence || null;
  const raw = typeof order.rawJson === 'string' ? json(order.rawJson) : order.raw_json ? json(order.raw_json) : order;
  const paymentStatus = String(raw.payment?.status || order.paymentStatus || order.payment_status || '').toUpperCase();
  const status = String(raw.status || order.status || '').toUpperCase();
  const value = raw.payment?.store_credit_amount ?? order.paymentStoreCreditAmount ?? order.payment_store_credit_amount;
  if (value == null || value === '' || !Number.isFinite(Number(value))) throw financialError('Order has no explicit store-credit amount; total is never treated as credit spent.');
  const spentCents = cents(Math.round(Number(value)*100));
  if (spentCents < 0) throw financialError('Invalid store-credit amount.');
  const canceled = /CANCEL|REFUND/.test(status) || /REFUND|CANCEL/.test(paymentStatus);
  if (paymentStatus !== 'PAID' && !canceled) throw financialError('Only confirmed paid credit usage can be reconciled.');
  if ((canceled || (previous && spentCents < previous.debitCents)) && !refundEvidence) throw financialError('A reduced or canceled order needs actual Local Line store-credit refund evidence. Cancellation alone does not restore money.');
  if (refundEvidence) {
    if (!Array.isArray(refundEvidence.transactionIds) || !refundEvidence.transactionIds.length || !Number.isSafeInteger(refundEvidence.cumulativeRefundCents) || refundEvidence.cumulativeRefundCents < 0) throw financialError('Verified refund transactions are required.');
    const original = previous?.grossSpentCents ?? previous?.debitCents ?? spentCents;
    if (refundEvidence.cumulativeRefundCents > original) throw financialError('Refund exceeds the recorded credit purchase.');
    if(refundEvidence.cumulativeRefundCents < Number(previous?.refundEvidence?.cumulativeRefundCents || 0))throw financialError('Include the complete cumulative refund evidence; a prior refund cannot be silently reversed.');
    return {debitCents:original-refundEvidence.cumulativeRefundCents,grossSpentCents:original,refundEvidence};
  }
  return {debitCents:spentCents,grossSpentCents:spentCents};
}

export async function reconcileMemberOrder({link,order,dividendRateBp,dryRun=false,refundEvidence=null},pool=getPool()) {
  const userId=Number(link.userId ?? link.user_id),orderId=Number(order.localLineOrderId ?? order.local_line_order_id ?? order.id);
  return withMemberLock(userId,async db=>{
    await requireVerifiedLocalLineLink(link,userId,db);
    await db.beginTransaction();
    try {
      const [[saved]]=await db.query('SELECT * FROM member_order_reconciliations WHERE local_line_order_id=? FOR UPDATE',[orderId]);
      if(saved && Number(saved.user_id)!==userId) throw financialError('Order financial ownership changed; review its original owner.');
      let previous=saved?{...json(saved.facts_json),debitCents:saved.debit_cents,dividendCents:saved.dividend_cents}:null;
      if (!previous) {
        const [old]=await db.query("SELECT amount_cents,reference_id FROM member_ledger_entries WHERE user_id=? AND reference_type='localline_order' AND reference_id IN (?,?)",[userId,`order:${orderId}`,`order:${orderId}:dividend`]);
        if(old.length) {
          const debit=-Number(old.find(row=>row.reference_id===`order:${orderId}`)?.amount_cents || 0),dividend=Number(old.find(row=>row.reference_id.endsWith(':dividend'))?.amount_cents || 0);
          previous={debitCents:debit,grossSpentCents:debit,dividendCents:dividend,dividendBasis:{numerator:dividend,denominator:debit || 1}};
        }
      }
      const facts=orderCreditFacts(order,previous,refundEvidence);
      const basis=previous?.dividendBasis || {numerator:cents(dividendRateBp,'Dividend rate'),denominator:10000};
      const dividendCents=Number((BigInt(facts.debitCents)*BigInt(basis.numerator)+BigInt(Math.floor(basis.denominator/2)))/BigInt(basis.denominator));
      const delta=facts.debitCents-(previous?.debitCents || 0),dividendDelta=dividendCents-(previous?.dividendCents || 0);
      const frozen={...facts,dividendBasis:basis};
      if (dryRun) {await db.rollback();return {orderId,deltaCents:delta,dividendDeltaCents:dividendDelta,dryRun};}
      const postings=[];
      if(delta)postings.push({key:'wallet',account:'wallet',entryType:delta>0?'purchase_debit':'purchase_refund',amountCents:-delta});
      if(dividendDelta)postings.push({key:'dividend',account:'dividend_reserve',entryType:'dividend_accrual',amountCents:dividendDelta});
      if(postings.length) await postMemberEvent(db,{source:'localline_order_revision',sourceId:`${orderId}:${hash({previous,frozen})}`,userId,kind:'order_credit_adjustment',facts:{orderId,...frozen},postings});
      await db.query(`INSERT INTO member_order_reconciliations (local_line_order_id,user_id,facts_json,debit_cents,dividend_cents,status,updated_at)
        VALUES (?,?,?,?,?,'reconciled',UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE facts_json=VALUES(facts_json),debit_cents=VALUES(debit_cents),dividend_cents=VALUES(dividend_cents),status='reconciled',updated_at=UTC_TIMESTAMP(3)`,[orderId,userId,JSON.stringify(frozen),facts.debitCents,dividendCents]);
      await db.commit();return {orderId,deltaCents:delta,dividendDeltaCents:dividendDelta,changed:Boolean(postings.length)};
    }catch(error){await db.rollback();throw error;}
  },pool);
}
