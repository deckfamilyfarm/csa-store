export const BASKET_FLAG_KEYS = ['excludeFromSnap', 'excludeFromGuest'];
export function productBasketFlags(input = {}, vendorName = '', existing = {}) {
  const result = {};
  for (const key of BASKET_FLAG_KEYS) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') throw Object.assign(new Error(`${key} must be true or false.`), {status:400});
    result[key] = Object.hasOwn(input,key) ? input[key] : Boolean(existing[key]);
  }
  // Creamy Cow defaults to exclusion; an explicit product-level exception is
  // available for hard cheeses. Never infer that exception from product names.
  if (/creamy cow/i.test(vendorName) && !Object.hasOwn(input,'excludeFromGuest') && !Object.hasOwn(existing,'excludeFromGuest')) result.excludeFromGuest = true;
  return result;
}
