import React, {useRef, useState} from 'react';
import {adminPost} from '../adminApi.js';
import {canPublishInventory} from '../../../../../apps/api/lib/adminRoles.js';

export function EnterpriseInventoryCell({row, token, roles = [], localOnly, onSaved}) {
  const [edit,setEdit]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  const snapshot=edit?.snapshot || row.ffInventorySnapshot;
  const tracked=Boolean(row.ffTrackInventory) && snapshot?.trackInventory !== false;
  async function start() {
    if(lock.current||!tracked)return;
    lock.current=true;setBusy(true);setError('');
    try {
      const result=await adminPost('products/inventory/refresh',token,{productIds:[row.id]});
      const current=result.rows.find(r=>Number(r.productId)===row.id);
      if(!current || current.error)throw new Error(current?.error || 'Unable to check current stock.');
      setEdit({snapshot:current, values:Object.fromEntries((current.inventoryType==='package'?current.packages:[{packageId:'product',inventory:current.inventory}]).map(p=>[p.packageId,p.inventory ?? '']))});
    }catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}
  }
  async function save() {
    if(lock.current||!tracked)return;
    const packages=edit.snapshot.inventoryType==='package';
    const targets=packages?edit.snapshot.packages.filter(p=>p.packageId && String(p.inventory)!==String(edit.values[p.packageId])):[{packageId:'product'}];
    if(targets.some(p=>edit.values[p.packageId]==='' || !Number.isSafeInteger(Number(edit.values[p.packageId])) || Number(edit.values[p.packageId])<0)){setError('Enter a nonnegative whole number.');return;}
    if(packages&&!targets.length){setEdit(null);return;}
    lock.current=true;setBusy(true);setError('');
    try {
      const changes=packages?{packageInventory:targets.map(p=>({packageId:p.packageId,inventory:Number(edit.values[p.packageId])}))}:{inventory:Number(edit.values.product)};
      const result=await adminPost(`products/${row.id}/inventory`,token,{changes,expectedInventory:edit.snapshot});
      if(!result?.ok||!result.localLineUpdate)throw new Error('Stock was not confirmed. Refresh and review before retrying.');
      onSaved(result.currentInventory.inventory,result.currentInventory);setEdit(null);
    }catch(e){setError(e.message);if(e.inventoryConflict)setEdit(current=>({...current,conflict:true}));}
    finally{lock.current=false;setBusy(false);}
  }
  const packages=snapshot?.inventoryType==='package'?snapshot.packages:[{packageId:'product',inventory:snapshot?.inventory}];
  if(!tracked)return null;
  return <div className="enterprise-inventory-cell">
    {!snapshot?<small role="status">{row.ffInventoryError || (localOnly?'Live stock checks disabled':'Checking current stock…')}</small>:
      !snapshot.trackInventory?null:packages.map((pkg,index)=><label key={pkg.remoteId || index}>
        {pkg.name && <small>{pkg.name} </small>}
        {edit?<input className="input" aria-label={`FF stock: ${row.name}${pkg.name?` — ${pkg.name}`:''}`} type="number" min="0" step="1" value={edit.values[pkg.packageId] ?? ''}
          disabled={busy||edit.conflict||!pkg.packageId} onChange={e=>setEdit({...edit,values:{...edit.values,[pkg.packageId]:e.target.value}})} />:<span>{pkg.inventory ?? '—'}</span>}
      </label>)}
    {!localOnly&&canPublishInventory(roles)&&<div>
      {!edit?<button type="button" disabled={busy} onClick={start}>{busy?'Checking…':'Edit stock'}</button>:<>
        <small>Checks Local Line before saving. A simultaneous remote sale or edit can still be overwritten.</small>
        {edit.conflict?<button type="button" disabled={busy} onClick={start}>Review latest stock</button>:<button type="button" disabled={busy||!snapshot.trackInventory} onClick={save}>{busy?'Saving…':'Save stock'}</button>}
        <button type="button" disabled={busy} onClick={()=>{setEdit(null);setError('');}}>Cancel</button>
      </>}
    </div>}
    {error&&<small role="alert">{error}</small>}
  </div>;
}
