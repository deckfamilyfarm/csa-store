import React from 'react';
export function EnterpriseInventoryCell({row,localOnly}) {
  const snapshot=row.ffInventorySnapshot;
  if(!snapshot)return <small role="status">{row.ffInventoryError || (localOnly?'Live stock checks disabled':'Checking current stock…')}</small>;
  return <div className="enterprise-inventory-cell" title="Quantity is managed in Local Line. Refresh here after making a stock correction there.">
    {!snapshot.trackInventory?<span>Not tracked</span>:(snapshot.inventoryType==='package'?snapshot.packages:[{inventory:snapshot.inventory}]).map((pkg,index)=><span key={pkg.remoteId || index}>{pkg.name && <small>{pkg.name} </small>}{pkg.inventory ?? '—'}</span>)}
  </div>;
}
