import {digest} from './pricingCutover.js';
import {scaledInteger} from './enterprisePricingEngine.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const number=value=>value==null?null:Number(value);
export function bundleRemoteState(remote) {
  return {id:Number(remote.id),name:remote.name,description:remote.description||'',visible:!!remote.visible,vendor:Number(remote.vendor?.id??remote.vendor),price:scaledInteger(remote.price,2),
    inventoryType:remote.inventory_type,trackInventory:!!remote.track_inventory,
    images:(remote.images||[]).map(i=>({id:i.id,image:i.product_image,url:i.full,order:i.priority_order})),
    contents:(remote.box_contents||[]).map(g=>({id:g.id,packages:(g.content_product_packages||[]).map(p=>({packageId:p.product_package,quantity:p.quantity,swaps:p.swaps||[]}))})),
    lists:(remote.product_price_list_entries||[]).map(p=>({id:p.id,listId:Number(p.price_list),entryId:p.box_package_entry?.id,
      adjustment:!!p.box_package_entry?.adjustment,type:number(p.box_package_entry?.adjustment_type),value:number(p.box_package_entry?.adjustment_value),
      sale:!!(p.box_package_entry?.on_sale||p.box_package_entry?.on_sale_toggle),crossedOut:number(p.box_package_entry?.strikethrough_display_value)}))};
}
export function prepareBundlePatch(bundle,remote,listIds,remoteVendor,components) {
  if(bundle.output.blockers.length)fail(bundle.output.blockers.join(' '));
  if(remote.is_deleted||remote.has_swaps||remote.ownership!=='MANAGED')fail('Deleted, shared or swappable bundles require manual review.');
  if(listIds.length!==4||new Set(listIds).size!==4||listIds.some(id=>!Number.isSafeInteger(id)||id<=0))fail('Configure four distinct Local Line baskets.');
  if(remote.box_contents?.length!==1)fail('This bundle has an unsupported contents layout.');
  const mode=remote.track_inventory?remote.inventory_type==='dynamic'?'components':'separate':'untracked';
  if(bundle.input.inventoryMode!==mode)fail('Inventory mode changes require a separate inventory review.');
  if(mode==='separate'&&Number(bundle.input.stock)!==Number(remote.inventory))fail('Bundle inventory changed. Review stock separately before publishing prices.');
  const imageURLs=(remote.images||[]).map(i=>i.full);
  if(digest(imageURLs)!==digest(bundle.input.images))fail('New bundle images must first be uploaded and matched in Local Line.');
  const before=bundleRemoteState(remote),expected=structuredClone(before),patch=[];
  const replace=(path,value)=>patch.push({op:'replace',path,value});
  for(const key of ['name','description','visible'])if(expected[key]!==bundle.input[key]){replace(`/${key}`,bundle.input[key]);expected[key]=bundle.input[key];}
  if(before.vendor!==remoteVendor){replace('/vendor',remoteVendor);expected.vendor=remoteVendor;}
  if(before.price!==bundle.output.buyPriceCents){replace('/price',bundle.output.buyPriceCents/100);expected.price=bundle.output.buyPriceCents;}
  const old=remote.box_contents[0].content_product_packages||[];
  if(old.some(p=>p.swaps?.length))fail('Swappable components require manual review.');
  const wanted=components.map(c=>({product_package:c.remotePackageId,quantity:c.quantity}));
  if(digest(old.map(c=>({product_package:c.product_package,quantity:c.quantity})))!==digest(wanted)){
    replace('/box_contents/0/content_product_packages',wanted.map(c=>({...c,swaps:[]})));
    expected.contents[0].packages=wanted.map(c=>({packageId:c.product_package,quantity:c.quantity,swaps:[]}));
  }
  for(const id of listIds){
    const entries=before.lists.filter(p=>p.listId===id);if(entries.length!==1||!entries[0].entryId)fail(`Bundle is missing a unique basket mapping (${id}).`);
    const index=before.lists.findIndex(p=>p.listId===id),entry=before.lists[index];
    if(entry.sale)fail('Resolve the existing bundle sale before changing its regular price.');
    for(const [field,value] of Object.entries({adjustment:true,adjustment_type:3,adjustment_value:bundle.output.priceCents/100}))replace(`/product_price_list_entries/${index}/box_package_entry/${field}`,value);
    Object.assign(expected.lists[index],{adjustment:true,type:3,value:bundle.output.priceCents/100});
  }
  return {before,expected,patch};
}
export function componentPriceCents(pkg,entry){
  if(entry?.on_sale||entry?.on_sale_toggle)fail('Resolve component sales before publishing a bundle.');
  if(entry?.calculated_value!=null)return scaledInteger(entry.calculated_value,2);
  if(entry?.adjustment&&Number(entry.adjustment_type)===3)return scaledInteger(entry.adjustment_value,2);
  fail(`Verify the current selling price of component package ${pkg.id} in all four baskets.`);
}
