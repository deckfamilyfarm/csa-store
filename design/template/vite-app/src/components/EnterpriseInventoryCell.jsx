import React,{useEffect,useRef,useState} from 'react';
import {adminPost} from '../adminApi.js';
import {canPublishInventory} from '../../../../../apps/api/lib/adminRoles.js';

export function EnterpriseInventoryCell({row,token,roles,localOnly,onSaved}){
 const snapshot=row.ffInventorySnapshot;
 const [conflict,setConflict]=useState(null),[reset,setReset]=useState(0);
 const accept=s=>{setConflict(null);onSaved(s.inventory,s);};
 const eligible=canPublishInventory(roles)&&!localOnly&&!row.ffInventoryError;
 return <div className="enterprise-inventory-cell">
 {!snapshot?<small role="status">{row.ffInventoryError|| (localOnly?'Live stock checks disabled':'Checking current stock…')}</small>:<>
 {!snapshot.trackInventory?<span>Not tracked</span>:(snapshot.inventoryType==='package'?snapshot.packages:[{inventory:snapshot.inventory}]).map((pkg,i)=><Stock key={`${reset}:${pkg.remoteId||i}`} pkg={pkg} snapshot={snapshot} name={row.name} enabled={eligible&&!conflict} token={token} id={row.id} onSaved={accept} onConflict={setConflict}/>)}
 {row.ffInventoryError&&<small role="alert">{row.ffInventoryError}</small>}
 </>}
 {conflict&&<div role="alert"><small>Local Line stock or its inventory type changed. Your edit was not sent.</small><button type="button" onClick={()=>{setReset(n=>n+1);accept(conflict);}}>Use current stock</button></div>}
 </div>;
}
function Stock({pkg,snapshot,name,enabled,token,id,onSaved,onConflict}){
 const [value,setValue]=useState(pkg.inventory==null?'':String(pkg.inventory)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef(false),dirty=useRef(false),failed=useRef(false),baseline=useRef(snapshot);
 const packageMode=snapshot.inventoryType==='package';
 useEffect(()=>{if(!dirty.current){baseline.current=snapshot;setValue(pkg.inventory==null?'':String(pkg.inventory));}},[snapshot,pkg.inventory]);
 const editable=enabled&&(!packageMode||Boolean(pkg.packageId));
 async function save(raw){
  if(pending.current||!editable)return;
  if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647){setError('Enter a whole number of 0 or more.');return;}
  const quantity=Number(raw);if(quantity===pkg.inventory){dirty.current=false;setError('');return;}
  pending.current=true;setBusy(true);setError('');
  try{const result=await adminPost(`products/${id}/inventory`,token,{changes:packageMode?{packageInventory:[{packageId:pkg.packageId,inventory:quantity}]}:{inventory:quantity},expectedInventory:baseline.current});
   if(!result?.ok||!result.localLineUpdate)throw Error('Stock was not confirmed. Refresh before retrying.');
   dirty.current=false;failed.current=false;onSaved(result.currentInventory);
  }catch(e){failed.current=true;setError(e.message);if(e.inventoryConflict)onConflict(e.inventoryConflict);}finally{pending.current=false;setBusy(false);}
 }
 return <div>{packageMode&&<small>{pkg.name}</small>}<div className="enterprise-inventory-stepper" role="group" aria-label={`FF inventory for ${name}${packageMode?' '+pkg.name:''}`}>
 <button type="button" disabled={!editable||busy||!Number(value)} onMouseDown={e=>e.preventDefault()} onClick={()=>save(String(Math.max(0,Number(value)-1)))} aria-label={`Decrease ${name} ${pkg.name||''}`}>−</button>
 <input className="input" type="number" min="0" step="1" value={value} disabled={!editable} readOnly={busy} aria-label={`FF inventory quantity for ${name}${packageMode?' '+pkg.name:''}`} onChange={e=>{dirty.current=true;failed.current=false;setValue(e.target.value);setError('');}} onBlur={()=>{if(dirty.current&&!failed.current)save(value);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();save(value);}if(e.key==='Escape'){dirty.current=false;failed.current=false;setValue(pkg.inventory==null?'':String(pkg.inventory));setError('');e.currentTarget.blur();}}}/>
 <button type="button" disabled={!editable||busy||pkg.inventory==null} onMouseDown={e=>e.preventDefault()} onClick={()=>save(String(Number(value)+1))} aria-label={`Increase ${name} ${pkg.name||''}`}>+</button></div>
 {packageMode&&!pkg.packageId&&<small>Package mapping required</small>}{busy&&<small role="status">Confirming with Local Line…</small>}{error&&<small role="alert">{error}</small>}</div>;
}
