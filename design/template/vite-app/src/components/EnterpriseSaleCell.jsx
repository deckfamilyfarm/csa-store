import React, { useRef, useState } from 'react';
import { adminPost } from '../adminApi.js';
export function SalePrice({regular, sale}) {
  const money=n=>n==null?'—':`$${(n/100).toFixed(2)}`;
  return sale!=null&&sale<regular ? <span className="enterprise-sale-price"><s>{money(regular)}</s> <strong>{money(sale)}</strong></span> : money(regular);
}
export function EnterpriseSaleCell({row,token,canEdit,onSaved,onReview}) {
  const [editing,setEditing]=useState(false),[value,setValue]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const busy=useRef(false),cancelled=useRef(false);
  async function save(e) {
    e?.preventDefault(); if(busy.current||cancelled.current)return;
    const percent=value.trim()===''?0:Number(value);
    if(!Number.isFinite(percent)||percent<0||percent>=100||Math.abs(percent*100-Math.round(percent*100))>0.000001){setError('Enter 0–99.99%.');return;}
    if(Math.round(percent*100)===Number(row.sale?.discountBp||0)){cancelled.current=true;setEditing(false);return;}
    busy.current=true;setSaving(true);setError('');
    try{await adminPost(`enterprise-pricing/products/${row.id}/sale`,token,{discountBp:Math.round(percent*100),expectedRevision:row.sale?.revision||0,expectedPricingRevision:row.activeRevisionId});cancelled.current=true;setEditing(false);onSaved();}
    catch(e){setError(e.message);}finally{busy.current=false;setSaving(false);}
  }
  if(!editing)return row.sale?.complex ? <button type="button" className="enterprise-pricing-edit-value" onClick={onReview}>Review sale</button> :
    canEdit&&row.output&&!row.fixedDeposit ? <button type="button" className="enterprise-pricing-edit-value" onClick={()=>{cancelled.current=false;setValue(row.sale?.active?String(row.sale.discountBp/100):'');setError('');setEditing(true);}}>{row.sale?.active?`${row.sale.discountBp/100}% off`:'set'}</button> : <span>{row.sale?.active?`${row.sale.discountBp/100}% off`:'—'}</span>;
  return <form className="enterprise-sale-inline" onSubmit={save} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))save();}}>
    <input className="input" autoFocus type="number" min="0" max="99.99" step="0.01" aria-label={`Sale percentage for ${row.name}`} value={value} disabled={saving} onChange={e=>setValue(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){cancelled.current=true;setEditing(false);} }} />%
    {saving&&<small role="status">Saving locally…</small>}{error&&<small role="alert">{error}</small>}
  </form>;
}
