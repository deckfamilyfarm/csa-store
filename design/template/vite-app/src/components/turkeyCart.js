export const CART_KEY = 'turkeyCart:v1';
export const CHECKOUT_CART_KEY = 'turkeyCheckoutCart:v1';
const breedOrder = { 'broad-breasted-white': 0, heritage: 1 };
export const sortTurkeyOptions = options => [...options].sort((a, b) =>
  (breedOrder[a.preorderBreed] ?? 2) - (breedOrder[b.preorderBreed] ?? 2) || a.priceCents - b.priceCents || a.label.localeCompare(b.label));

export function readCart(browser = window) {
  try {
    const cart = JSON.parse(browser.localStorage.getItem(CART_KEY));
    if (!Array.isArray(cart) || cart.length > 30) return [];
    const seen = new Set();
    return cart.filter(item => {
      if (!Number.isSafeInteger(item.optionId) || item.optionId < 1 || seen.has(item.optionId) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 ||
        !Number.isInteger(item.expectedPriceCents) || item.expectedPriceCents < 50) return false;
      seen.add(item.optionId); return true;
    }).map(({ optionId, quantity, expectedPriceCents }) => ({ optionId, quantity, expectedPriceCents }));
  } catch { return []; }
}
export function saveCart(cart, browser = window) {
  try {
    // Deliberately exclude customer details, photos, descriptions, and payment tokens.
    browser.localStorage.setItem(CART_KEY, JSON.stringify(cart.map(({ optionId, quantity, expectedPriceCents }) => ({ optionId, quantity, expectedPriceCents }))));
  } catch { /* The current tab still has its cart when persistent storage is unavailable. */ }
}
export function cartLines(cart, catalog) {
  return cart.map(item => {
    const option = catalog?.options.find(option => option.id === item.optionId);
    const issue = !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 ? 'Choose a whole-number quantity between 1 and 1000.'
      : !option ? 'This turkey is no longer available. Remove it to continue.'
      : option.available < item.quantity ? `Only ${Math.max(0, option.available)} available. Adjust the quantity or remove this item.`
      : option.priceCents !== item.expectedPriceCents ? 'The price has changed. Review and accept the current price.' : '';
    return { ...item, option, issue, priceChanged: Boolean(option && option.priceCents !== item.expectedPriceCents) };
  });
}
export function addToCart(cart, option, quantity) {
  const previous = cart.find(item => item.optionId === option.id);
  const count = (previous?.quantity || 0) + quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || count > Math.min(1000, option.available)) throw new Error('Choose a quantity within the available stock, including turkeys already in your cart.');
  if (previous && previous.expectedPriceCents !== option.priceCents) throw new Error('The price changed for this turkey. Review its current price in your cart before adding more.');
  return [...cart.filter(item => item.optionId !== option.id), { optionId: option.id, quantity: count, expectedPriceCents: option.priceCents }];
}
export function cartMatches(cart, items) {
  const key = values => JSON.stringify(values.map(({ optionId, quantity, expectedPriceCents, priceCents }) => [optionId, quantity, expectedPriceCents ?? priceCents]).sort((a, b) => a[0] - b[0]));
  return key(cart) === key(items);
}
export function rememberCheckoutCart(orderId, items, browser = window) {
  try { browser.localStorage.setItem(CHECKOUT_CART_KEY, JSON.stringify({ orderId, items })); } catch { /* Session checkout still works. */ }
}
export function settleCheckoutCart(order, browser = window) {
  if (!['paid', 'collected', 'refunded', 'expired'].includes(order.status)) return false;
  try {
    const checkout = JSON.parse(browser.localStorage.getItem(CHECKOUT_CART_KEY));
    if (checkout?.orderId !== order.id) return false;
    const clear = ['paid', 'collected'].includes(order.status) && cartMatches(readCart(browser), checkout.items);
    if (clear) saveCart([], browser);
    browser.localStorage.removeItem(CHECKOUT_CART_KEY);
    return clear;
  } catch { return false; }
}
export function turkeyRoute(hash) {
  const route = hash.replace(/^#\/?/, '').split('?')[0];
  return route === 'turkeys/product' ? 'product' : route === 'turkeys/cart' ? 'cart' : 'listing';
}
export function turkeyLink(view, preview = false) {
  return `#/turkeys${view === 'listing' ? '' : `/${view}`}${preview ? '?preview=1' : ''}`;
}
