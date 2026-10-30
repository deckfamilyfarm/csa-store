import React, {useRef, useState} from 'react';
import {adminPost} from '../adminApi.js';
import {canPublishInventory} from '../../../../../apps/api/lib/adminRoles.js';

export function EnterpriseVisibilityCell({row, token, roles, localOnly, onSaved}) {
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const request=useRef(false);
  const known=typeof row.ffVisible==='boolean';
  const enabled=canPublishInventory(roles)&&!localOnly&&known;
  async function toggle() {
    if(request.current||!enabled)return;
    request.current=true;setBusy(true);setError('');
    const visible=!row.ffVisible;
    try {
      const result=await adminPost(`products/${row.id}/inventory`,token,{changes:{visible:Number(visible)}});
      if(!result?.ok||!result?.localLineUpdate)throw new Error('Visibility was not confirmed. Check Local Line before retrying.');
      onSaved(visible);
    } catch(e) {setError(e.message);} finally {request.current=false;setBusy(false);}
  }
  return <div className="enterprise-visibility-cell">
    <button type="button" className={`enterprise-visibility-button ${row.ffVisible?'is-visible':'is-hidden'}`} disabled={!enabled||busy}
      role="switch" aria-checked={known?row.ffVisible:false} aria-busy={busy} aria-label={`FF visibility for ${row.name}: ${known?(row.ffVisible?'visible':'hidden'):'unknown'}`}
      title={localOnly?'Channel updates are disabled in local test mode.':!enabled?'Visibility editing requires inventory publishing permission.':`Click to ${row.ffVisible?'hide':'show'} this product in Full Farm. Updates Local Line immediately.`}
      onClick={toggle}><span className="enterprise-visibility-thumb" aria-hidden="true">{busy?'…':known?(row.ffVisible?'✓':'×'):'?'}</span></button>
    {busy&&<small role="status">Confirming with Local Line…</small>}
    {error&&<small role="alert">{error}</small>}
  </div>;
}
