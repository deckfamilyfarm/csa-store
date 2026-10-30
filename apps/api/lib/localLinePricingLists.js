// CSA Members is retired. Keep its historical records, but never use it as a
// pricing destination, comparison baseline, or new product mapping.
export const ACTIVE_LOCAL_LINE_BASKETS = Object.freeze([
  { key: 'guest', name: 'Guest Basket', env: 'LL_PRICE_LIST_GUEST_ID' },
  { key: 'herdShare', name: 'Herd Share Members', env: 'LL_PRICE_LIST_HERDSHARE_ID' },
  { key: 'snap', name: 'SNAP', env: 'LL_PRICE_LIST_SNAP_ID' }
]);
export const LOCAL_LINE_PRICING_POLICY = 'guest-herdshare-snap-v1';
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
