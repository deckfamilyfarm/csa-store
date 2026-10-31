import { fail } from './productSyncCore.js';
const count=value=>{
 if(value==null)return null;
 if(typeof value==='boolean'||String(value).trim()===''||!Number.isSafeInteger(Number(value))||Number(value)<0)fail('Local Line returned an unsupported inventory count. Review stock in Local Line.');
 return Number(value);
};
export function remoteInventory(remote,mappings=[]){
 const inventoryType=remote.inventory_type||'product';
 if(!['product','package'].includes(inventoryType))fail('Local Line inventory type is not supported.');
 if(typeof remote.track_inventory!=='boolean')fail('Local Line did not return inventory tracking status.');
 const result={inventory:inventoryType==='product'?count(remote.inventory):null,trackInventory:remote.track_inventory,checkedAt:new Date().toISOString()};
 // Preserve the legacy product snapshot shape when the API omits its type.
 if(remote.inventory_type||inventoryType==='package')result.inventoryType=inventoryType;
 if(inventoryType==='package'){
  if(!Array.isArray(remote.packages)||!remote.packages.length)fail('Local Line did not return its inventory packages.');
  result.packages=remote.packages.map(p=>{const matches=mappings.filter(m=>Number(m.remoteId)===Number(p.id));return {packageId:matches.length===1?Number(matches[0].packageId):null,remoteId:Number(p.id),name:p.name||'Package',inventory:count(p.current_inventory)};});
 }
 return result;
}
export function inventoryConflict(remote,expected,mappings=[],targets=null){
 const current=remoteInventory(remote,mappings),type=current.inventoryType||'product';
 if(!expected||typeof expected.trackInventory!=='boolean')fail('Refresh FF inventory before editing its quantity.',428);
 if(type!==(expected.inventoryType||'product')||expected.trackInventory!==current.trackInventory)return current;
 if(type==='package'){
  if(!Array.isArray(expected.packages))fail('Refresh package inventory before editing its quantity.',428);
  for(const target of targets||current.packages){
   const p=current.packages.find(p=>p.packageId===Number(target.packageId)),old=expected.packages.find(p=>p.packageId===Number(target.packageId));
   if(!p||!old||!p.packageId||p.remoteId!==old.remoteId||p.inventory!==old.inventory)return current;
  }
  return null;
 }
 if(!Object.hasOwn(expected,'inventory')||(expected.inventory!==null&&(!Number.isSafeInteger(expected.inventory)||expected.inventory<0)))fail('Refresh FF inventory before editing its quantity.',428);
 return current.inventory!==expected.inventory?current:null;
}
export function stockPayload(remote,changes,expected,mappings){
 const current=remoteInventory(remote,mappings),packageMode=current.inventoryType==='package';
 const targets=changes.packageInventory;
 if(expected&&(current.inventoryType||'product')!==(expected.inventoryType||'product'))return {conflict:current};
 if(packageMode&&Object.hasOwn(changes,'inventory'))fail('This product tracks stock by package. Refresh and edit the individual package quantities.',409);
 if(!packageMode&&targets)fail('This product now tracks stock by product. Refresh before editing.',409);
 const conflict=inventoryConflict(remote,expected,mappings,targets);
 if(conflict)return {conflict};
 if(!remote.track_inventory&&changes.trackInventory!==1)fail('Full Farm inventory tracking is off. Refresh before editing stock.',409);
 if(!packageMode)return {payload:{set_inventory:changes.inventory}};
 for(const target of targets){if(!current.packages.some(p=>p.packageId===target.packageId))fail('Package mapping changed. Refresh and review before editing.',409);}
 // Include all IDs to preserve siblings, but set stock only on explicitly edited packages.
 return {payload:{packages:current.packages.map(p=>{const target=targets.find(t=>t.packageId===p.packageId);return {id:p.remoteId,...(target?{set_inventory:target.inventory}:{})};})}};
}
