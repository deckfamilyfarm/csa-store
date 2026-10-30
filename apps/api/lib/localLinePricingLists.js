// CSA Members is retired. Keep its historical records, but never use it as a
// pricing destination, comparison baseline, or new product mapping.
export const ACTIVE_LOCAL_LINE_BASKETS = Object.freeze([
  { key: 'guest', name: 'Guest Basket', env: 'LL_PRICE_LIST_GUEST_ID' },
  { key: 'herdShare', name: 'Herd Share Members', env: 'LL_PRICE_LIST_HERDSHARE_ID' },
  { key: 'snap', name: 'SNAP', env: 'LL_PRICE_LIST_SNAP_ID' }
]);
export const LOCAL_LINE_PRICING_POLICY = 'guest-herdshare-snap-existing-enrollment-v2';
export const activeLocalLinePriceListIds = (env = process.env) => ACTIVE_LOCAL_LINE_BASKETS.map(list => Number(env[list.env]));
export function validateActiveLocalLinePriceListIds(ids) {
  if (ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || isRetiredLocalLineList(id))) {
    throw new Error('Configure three distinct Local Line baskets: Guest Basket, Herd Share Members, and SNAP.');
  }
  return ids;
}
export function isRetiredLocalLineList(id, name = '', env = process.env) {
  return String(name).trim().toLowerCase() === 'csa members' ||
    Number(id) === Number(env.LL_PRICE_LIST_CSA_MEMBERS_ID || 2718);
}
export function assertNoRetiredLocalLinePrices(payload) {
  const entries = [...(payload.product_price_list_entries || []), ...(payload.packages || []).flatMap(pkg => pkg.price_list_entries || [])];
  if (entries.some(entry => isRetiredLocalLineList(entry.price_list_id ?? entry.price_list))) {
    throw new Error('CSA Members is retired. Run a new pricing check before publishing this saved update.');
  }
}

// Basket enrollment is separate from price calculation. Never enroll a product
// in another customer group as a side effect of a price or sale publication.
export function enrolledLocalLineLists(pkg, ids = activeLocalLinePriceListIds()) {
  validateActiveLocalLinePriceListIds(ids);
  const entries = pkg?.price_list_entries || [];
  const selected = entries.filter(e => ids.includes(Number(e.price_list_id ?? e.price_list)));
  const listIds = selected.map(e => Number(e.price_list_id ?? e.price_list));
  if (!listIds.length || new Set(listIds).size !== listIds.length || selected.some(e => !Number.isSafeInteger(Number(e.product_price_list_entry ?? e.id)) || Number(e.product_price_list_entry ?? e.id) <= 0)) {
    throw new Error(`Package ${pkg?.name || pkg?.id || ''} needs at least one unique, valid active Local Line basket mapping.`);
  }
  return listIds.sort((a,b)=>a-b);
}
export function localLineBasketSnapshot(remote, ids = activeLocalLinePriceListIds()) {
  return (remote?.packages || []).map(pkg => ({ packageId: Number(pkg.id), listIds: enrolledLocalLineLists(pkg, ids) })).sort((a,b)=>a.packageId-b.packageId);
}
export function assertLocalLineBasketEligibility(remote, vendorName, ids = activeLocalLinePriceListIds()) {
  const snapshot = localLineBasketSnapshot(remote, ids);
  return snapshot;
}

export function expectedLocalLineLists(product, ids = activeLocalLinePriceListIds()) {
  validateActiveLocalLinePriceListIds(ids);
  return ids.filter((id,index)=>!(index===0&&Boolean(product?.excludeFromGuest))&&!(index===2&&Boolean(product?.excludeFromSnap)));
}
export function validateProductBasketMappings(remote, product, vendorName, ids = activeLocalLinePriceListIds()) {
  const snapshot = assertLocalLineBasketEligibility(remote, vendorName, ids);
  const expected = expectedLocalLineLists(product, ids).sort((a,b)=>a-b);
  for(const row of snapshot) if(JSON.stringify(row.listIds)!==JSON.stringify(expected)) {
    const name = remote.packages.find(p=>Number(p.id)===row.packageId)?.name || row.packageId;
    throw new Error(`Package ${name}: Local Line basket availability differs from the saved Guest/SNAP exclusions. Review its basket mappings before publishing.`);
  }
  return snapshot;
}
