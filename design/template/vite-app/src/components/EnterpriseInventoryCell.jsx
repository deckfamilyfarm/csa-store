import React, {useEffect, useRef, useState} from 'react';
import {adminPost} from '../adminApi.js';
import {canPublishInventory} from '../../../../../apps/api/lib/adminRoles.js';

export function EnterpriseInventoryCell({row,token,roles,localOnly,onSaved}) {
  const [value,setValue]=useState(row.ffInventory==null?'':String(row.ffInventory));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [conflict,setConflict]=useState(null);
  const pending=useRef(false), baseline=useRef(row.ffInventory), dirty=useRef(false), failed=useRef(false);
  useEffect(()=>{
    if(dirty.current && baseline.current!==row.ffInventory){setConflict({inventory:row.ffInventory,trackInventory:row.ffTrackInventory});return;}
    baseline.current=row.ffInventory;if(!dirty.current)setValue(row.ffInventory==null?'':String(row.ffInventory));
  },[row.ffInventory,row.ffTrackInventory]);
  const enabled=canPublishInventory(roles)&&!localOnly&&row.ffTrackInventory&&Boolean(row.ffInventoryCheckedAt)&&!row.ffInventoryError&&!conflict;
  async function save(raw) {
    if(pending.current||!enabled)return;
    if(String(raw).trim()===''||!/^\d+$/.test(String(raw))||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647){setError('Enter a whole number of 0 or more.');return;}
    const quantity=Number(raw);
    if(quantity===baseline.current){dirty.current=false;setValue(String(quantity));setError('');return;}
    pending.current=true;failed.current=false;setBusy(true);setError('');
    try {
      const result=await adminPost(`products/${row.id}/inventory`,token,{changes:{inventory:quantity},expectedInventory:{inventory:baseline.current,trackInventory:row.ffTrackInventory}});
      if(!result?.ok||!result?.localLineUpdate)throw new Error('Inventory was not confirmed. Check Local Line before retrying.');
      baseline.current=quantity;dirty.current=false;setValue(String(quantity));onSaved(quantity);
    }catch(e){failed.current=true;if(e.inventoryConflict)setConflict(e.inventoryConflict);setError(e.message);}finally{pending.current=false;setBusy(false);}
  }
  if(!row.ffTrackInventory&&!conflict)return <span className="enterprise-inventory-untracked">Not tracked</span>;
  const decrementDisabled=!enabled||busy||baseline.current==null||baseline.current<=0;
  return <div className="enterprise-inventory-cell">
    <div className="enterprise-inventory-stepper" role="group" aria-label={`FF inventory for ${row.name}`}>
      <button type="button" disabled={decrementDisabled} aria-label={`Decrease FF inventory for ${row.name}`} onMouseDown={e=>e.preventDefault()} onClick={()=>save(String(Math.max(0,Number(value)-1)))}>−</button>
      <input className="input" type="number" min="0" max="2147483647" step="1" inputMode="numeric" value={value} disabled={!enabled} readOnly={busy} aria-busy={busy}
        aria-label={`FF inventory quantity for ${row.name}`} aria-invalid={Boolean(error)}
        title="Updates Full Farm inventory in Local Line immediately."
        onChange={e=>{dirty.current=true;failed.current=false;setValue(e.target.value);setError('');}}
        onBlur={()=>{if(dirty.current&&!failed.current)save(value);}}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();save(value);}if(e.key==='Escape'){dirty.current=false;setValue(baseline.current==null?'':String(baseline.current));setError('');e.currentTarget.blur();}}}/>
      <button type="button" disabled={!enabled||busy||baseline.current==null||Number(value)>=2147483647} aria-label={`Increase FF inventory for ${row.name}`} onMouseDown={e=>e.preventDefault()} onClick={()=>save(String(Number(value)+1))}>+</button>
    </div>
    {conflict&&<div role="alert"><small>Local Line now has {conflict.inventory ?? 'unknown'}{conflict.trackInventory?'':' (tracking off)'}. Your edit was not sent.</small><button type="button" onClick={()=>{
      dirty.current=false;failed.current=false;baseline.current=conflict.inventory;setValue(conflict.inventory==null?'':String(conflict.inventory));setError('');setConflict(null);onSaved(conflict.inventory,conflict);
    }}>Use current stock</button></div>}
    {row.ffInventoryError&&<small role="alert">{row.ffInventoryError}</small>}
    {!row.ffInventoryCheckedAt&&!localOnly&&!row.ffInventoryError&&<small role="status">Checking current stock…</small>}
    {busy&&<small role="status">Confirming with Local Line…</small>}
    {error&&<small role="alert">{error}</small>}
  </div>;
}
