import crypto from 'node:crypto';
import { fail, integer, text, email, hash, tokenHash, parse, checkoutReturnOrigin } from './storefrontCore.js';
export { fail, integer, text, email, hash, tokenHash, parse, checkoutReturnOrigin };
export const json = value => JSON.stringify(value);
export const uuid = () => crypto.randomUUID();
export const MAX_CENTS = 10000000;
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = value => hash(json(canonical(value)));
export function addressInput(input = {}) {
  const result = {
    first_name: text(input.firstName, 'first name', 80), last_name: text(input.lastName, 'last name', 80),
    email: email(input.email), phone: text(input.phone, 'phone', 40),
    address1: text(input.addressLine1, 'street address', 200), address2: text(input.addressLine2, 'address line 2', 200, false),
    city: text(input.city, 'city', 100), region: text(input.state, 'state', 2).toUpperCase(),
    zip: text(input.postalCode, 'postal code', 20), country: text(input.country || 'US', 'country', 2).toUpperCase()
  };
  if (result.country !== 'US' || !/^[A-Z]{2}$/.test(result.region) || !/^\d{5}(?:-\d{4})?$/.test(result.zip) || result.phone.replace(/\D/g, '').length < 7) fail('Enter a US shipping address and valid phone number.');
  return result;
}
export function cartInput(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) fail('Choose between 1 and 30 merchandise variants. Farm products require their existing order workflow.');
  const seen = new Set();
  return items.map(item => {
    if (item.fulfillmentKind && item.fulfillmentKind !== 'printify') fail('Mixed farm and merchandise checkout is not available yet.');
    const variantId = integer(item.variantId, 'Variant', 1, 2147483647);
    if (seen.has(variantId)) fail('Combine duplicate variants into one cart row.');
    seen.add(variantId);
    return { variantId, quantity: integer(item.quantity, 'Quantity', 1, 20), expectedPriceCents: integer(item.expectedPriceCents, 'Displayed price', 50, MAX_CENTS) };
  }).sort((a,b) => a.variantId-b.variantId);
}
// Proposal only: 45% production margin, rounded up to whole dollars. Shipping,
// supplier tax and actual payment fees must be reviewed separately before launch.
export function proposedRetail(cost) {
  return Number.isSafeInteger(cost) && cost >= 0 ? Math.ceil(cost / 55) * 100 : null;
}
export function safeImage(url) {
  try { const value = new URL(url); return value.protocol === 'https:' && !value.username && !value.password ? value.href : null; } catch { return null; }
}
export function verifyPrintifySignature(body, signature, secret) {
  if (!secret) fail('Printify webhook is not configured.', 503);
  if (!Buffer.isBuffer(body) || !/^sha256=[a-f0-9]{64}$/.test(String(signature))) fail('Invalid Printify signature.', 400);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) fail('Invalid Printify signature.', 400);
  let event; try { event = JSON.parse(body.toString('utf8')); } catch { fail('Invalid Printify event.'); }
  if (!event.id || !event.type || !event.resource?.id || !event.resource?.data?.shop_id) fail('Invalid Printify event.');
  return event;
}
export function supplierProduct(record) {
  const p = record.product;
  if (!p || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) || Number(p.shop_id) !== Number(record.shopId)) fail('Supplier product identity is invalid.');
  const shopId = integer(record.shopId, 'Shop ID', 1, 2147483647);
  const variantIds = new Set();
  const variants = (p.variants || []).map(v => {
    const id = integer(v.id, 'Supplier variant ID', 1, 2147483647);
    if (variantIds.has(id)) fail('Duplicate supplier variant.'); variantIds.add(id);
    const options = (v.options || []).map(optionId => {
      const option = (p.options || []).find(o => o.values?.some(value => value.id === optionId));
      const value = option?.values.find(value => value.id === optionId);
      if (!value) fail('Supplier variant option is missing.');
      return { type: option.type || option.name, title: value.title, id: optionId };
    });
    return { id, title: text(v.title, 'variant title', 255), sku: String(v.sku || ''), options,
      enabled: v.is_enabled === true, available: v.is_available === true,
      cost: v.cost == null ? null : integer(v.cost, 'Supplier cost', 0, MAX_CENTS),
      channelPrice: v.price == null ? null : integer(v.price, 'Channel price', 0, MAX_CENTS) };
  });
  if (!variants.length) fail('Supplier product has no variants.');
  return { shopId, externalId: p.id, name: text(p.title, 'product name', 255), description: String(p.description || ''),
    images: (p.images || []).map(image => ({ ...image, src: safeImage(image.src) })).filter(image => image.src),
    blueprintId: integer(p.blueprint_id, 'Blueprint ID', 1), providerId: integer(p.print_provider_id, 'Print provider ID', 1),
    sourceVisible: p.visible === true, variants, record, sourceHash: fingerprint(record) };
}
export function verifySupplierOrder(receipt, frozen) {
  if (!receipt?.id || receipt.metadata?.shop_order_id !== frozen.external_id) fail('Supplier order attribution requires review.', 409);
  const key = row => `${row.product_id}/${row.variant_id}/${row.quantity}`;
  if (json((receipt.line_items || []).map(key).sort()) !== json(frozen.line_items.map(key).sort())) fail('Supplier order items require review.', 409);
  for (const field of ['first_name','last_name','address1','address2','city','region','zip','country']) {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/^united states(?: of america)?$/, 'us');
    if (normalize(receipt.address_to?.[field]) !== normalize(frozen.address_to[field])) fail('Supplier shipping address requires review.', 409);
  }
  if (receipt.shipping_method !== undefined && Number(receipt.shipping_method) !== frozen.shipping_method) fail('Supplier shipping service requires review.', 409);
  return receipt;
}
