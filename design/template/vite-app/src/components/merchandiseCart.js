export const MERCH_CART='csaMerchandiseCart.v1', MERCH_PENDING='csaMerchandiseCheckout.v1';
export const validToken=value=>/^[a-f0-9]{64}$/.test(String(value || ''));
export function cleanCart(value) {
  if (!Array.isArray(value)) return [];
  const seen=new Set();
  return value.filter(row=>Number.isInteger(row.variantId)&&row.variantId>0&&!seen.has(row.variantId)&&seen.add(row.variantId)&&
    Number.isInteger(row.quantity)&&row.quantity>=1&&row.quantity<=20&&Number.isInteger(row.expectedPriceCents)&&row.expectedPriceCents>=50).slice(0,30)
    .map(({variantId,quantity,expectedPriceCents})=>({variantId,quantity,expectedPriceCents}));
}
export const cartKey=cart=>JSON.stringify(cleanCart(cart).sort((a,b)=>a.variantId-b.variantId));
export function readCart(storage) { try { return cleanCart(JSON.parse(storage.getItem(MERCH_CART))); } catch { return []; } }
export function readPending(storage,now=Date.now()) {
  try { const value=JSON.parse(storage.getItem(MERCH_PENDING)); return validToken(value?.token)&&typeof value.quoteId==='string'&&value.expiresMs>now?value:null; } catch { return null; }
}
export function rememberAccess(storage,orderId,token,now=Date.now()) {
  if (!validToken(token)) throw new Error('Invalid checkout access token.');
  storage.setItem(`csaMerchandiseOrder.${orderId}`,JSON.stringify({token,expiresMs:now+7*86400000}));
}
export function orderAccess(storage,orderId,now=Date.now()) {
  try { const value=JSON.parse(storage.getItem(`csaMerchandiseOrder.${orderId}`));return value.expiresMs>now&&validToken(value.token)?value.token:null; } catch {return null;}
}
export function cartAfterPayment(cart,pending,order) {
  return order?.paid && pending?.orderId===order.id && pending.cartKey===cartKey(cart)?[]:cart;
}
