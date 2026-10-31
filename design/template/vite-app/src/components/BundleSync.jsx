import React,{useEffect,useState} from 'react';
import {adminGet,adminPost} from '../adminApi.js';
const money=cents=>`$${(Number(cents)/100).toFixed(2)}`;
export function BundleSync({id,token,roles,localOnly,dirty,publicationId,onPublished}){
 const [receipt,setReceipt]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const grant=key=>roles.includes('admin')||roles.includes(key);
 const publisher=roles.some(r=>['admin','pricing_admin','pricing_publisher'].includes(r));
 useEffect(()=>{let cancelled=false;if(publicationId)adminGet(`enterprise-pricing/bundle-publications/${publicationId}`,token).then(r=>{if(!cancelled)setReceipt(r);}).catch(e=>{if(!cancelled)setMessage(e.message);});return()=>{cancelled=true;};},[publicationId,token]);
 async function check(){setBusy(true);setMessage('');try{setReceipt(await adminPost(`enterprise-pricing/bundles/${id}/review`,token,{}));}catch(e){setMessage(e.message);}finally{setBusy(false);}}
 async function publish(){if(!window.confirm('Approve and publish these reviewed bundle changes to Local Line?'))return;setBusy(true);setMessage('');try{const r=await adminPost(`enterprise-pricing/bundle-publications/${receipt.id}/publish`,token,{});setReceipt(r);setMessage(r.status==='verified'?'Local Line confirmed the bundle update.':r.status);onPublished?.();}catch(e){setMessage(e.message);try{setReceipt(await adminGet(`enterprise-pricing/bundle-publications/${receipt.id}`,token));}catch{}}finally{setBusy(false);}}
 const snap=receipt?.snapshot;
 return <div>{localOnly?<p className="small">Channel access is disabled in local testing.</p>:<>
  <p className="small">Sync component prices first. Checking confirms the bundle discount against all three active baskets. Inventory changes are reviewed separately.</p>
  {publisher&&grant('localline_pull')&&<button className="button alt" disabled={busy||dirty||['publishing','uncertain'].includes(receipt?.status)} onClick={check}>Check Local Line</button>}
  {snap&&<><p>Review #{receipt.id} · {receipt.status}</p><table className="admin-table"><thead><tr><th>Field</th><th>Channel</th><th>Saved bundle</th></tr></thead><tbody>
   <tr><td>Name</td><td>{snap.before.name}</td><td>{snap.expected.name}</td></tr>
   <tr><td>Visibility</td><td>{snap.before.visible?'Visible':'Hidden'}</td><td>{snap.expected.visible?'Visible':'Hidden'}</td></tr>
   <tr><td>Cost</td><td>{money(snap.before.price)}</td><td>{money(snap.expected.price)}</td></tr>
   <tr><td>Vendor ID</td><td>{snap.before.vendor}</td><td>{snap.expected.vendor}</td></tr>
   <tr><td>Description</td><td>{snap.before.description.replace(/<[^>]*>/g,' ')}</td><td>{snap.expected.description.replace(/<[^>]*>/g,' ')}</td></tr>
   <tr><td>Component packages</td><td>{snap.before.contents.flatMap(g=>g.packages).map(p=>`${p.quantity} × #${p.packageId}`).join(', ')}</td><td>{snap.components.map(p=>`${p.quantity} × ${p.name||`#${p.remotePackageId}`}`).join(', ')}</td></tr>
   {snap.listIds.map(id=>{const before=snap.before.lists.find(p=>p.listId===id),after=snap.expected.lists.find(p=>p.listId===id);const price=!before.adjustment?snap.before.price:before.type===3?Math.round(before.value*100):before.type===2?Math.round(snap.before.price*(1+before.value/100)):snap.before.price+Math.round(before.value*100);return <tr key={id}><td>Basket {id}</td><td>{money(price)}</td><td>{money(Math.round(after.value*100))}</td></tr>;})}
  </tbody></table>{publisher&&grant('localline_push')&&receipt.status!=='verified'&&<button className="button" disabled={busy||dirty} onClick={publish}>{receipt.attempted_at?'Verify / retry this publication':'Approve & publish bundle'}</button>}</>}
 </>}{message&&<p role="status">{message}</p>}</div>;
}
