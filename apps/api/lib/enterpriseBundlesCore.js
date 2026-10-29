import { roundRatio, scaledInteger } from './enterprisePricingEngine.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const integer = (value, label, min = 1) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > 1000000) fail(`${label} is invalid.`);
  return n;
};
export function normalizeBundle(input) {
  if (!input || typeof input !== 'object') fail('Bundle details are required.');
  const name = String(input.name || '').trim();
  if (!name || name.length > 255) fail('Enter a bundle name of up to 255 characters.');
  const description = String(input.description || '');
  if (description.length > 30000) fail('Bundle description is too long.');
  const buyPriceCents = scaledInteger(input.buyPrice, 2, 'Bundle Buy Price');
  const discountBp = scaledInteger(input.discountPercent ?? 5, 2, 'Bundle discount');
  if (discountBp >= 10000) fail('Bundle discount must be less than 100%.');
  if (typeof input.visible !== 'boolean') fail('Choose whether the bundle is visible.');
  if (!['untracked', 'components', 'separate'].includes(input.inventoryMode)) fail('Choose an inventory mode.');
  const stock = input.stock == null || input.stock === '' ? null : integer(input.stock, 'Bundle inventory', 0);
  if (input.inventoryMode === 'separate' && stock === null) fail('Enter inventory for separately tracked bundles.');
  if (!Array.isArray(input.components) || !input.components.length || input.components.length > 200) fail('Choose between 1 and 200 component packages.');
  const components = input.components.map(row => ({ packageId: integer(row.packageId, 'Component package'), quantity: integer(row.quantity, 'Component quantity') }));
  if (new Set(components.map(c => c.packageId)).size !== components.length) fail('A package is listed twice. Change its quantity instead.');
  if (!Array.isArray(input.images) || input.images.length > 5) fail('Use at most five images.');
  const images = input.images.map(value => {
    let url; try { url = new URL(value); } catch { fail('Use a complete HTTPS image URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) fail('Use a complete HTTPS image URL.');
    return url.href;
  });
  return { name, description, vendorId: integer(input.vendorId, 'Vendor'), buyPrice: (buyPriceCents / 100).toFixed(2),
    discountPercent: discountBp / 100, visible: input.visible, inventoryMode: input.inventoryMode, stock, images, components };
}

// Each price is for a whole component package, including its existing estimated
// weight or quantity. Never multiply a per-pound price by a package count here.
export function calculateBundle(input, catalog) {
  const discountBp = scaledInteger(input.discountPercent, 2, 'Bundle discount');
  const blockers = [], resources = new Map();
  let subtotal = 0, capacityKnown = true;
  const components = input.components.map(component => {
    const row = catalog.find(row => row.packageId === component.packageId);
    if (!row || row.blocker || !Number.isSafeInteger(row.priceCents) || row.priceCents < 0) {
      blockers.push(row?.blocker || `${row?.name || `Package ${component.packageId}`} needs a current local FF package price.`);
      return { ...component, name: row?.name || `Package ${component.packageId}`, packageName: row?.packageName || '', priceCents: null, totalCents: null };
    }
    const totalCents = row.priceCents * component.quantity;
    subtotal += totalCents;
    if (!Number.isSafeInteger(subtotal)) fail('Bundle total is too large.');
    if (row.stockResource && Number.isSafeInteger(row.availableStock)) {
      const old = resources.get(row.stockResource);
      resources.set(row.stockResource, { stock: old ? Math.min(old.stock, row.availableStock) : row.availableStock,
        needed: (old?.needed || 0) + component.quantity * (row.stockUnitsPerPackage || 1) });
    } else capacityKnown = false;
    return { ...component, productId: row.productId, name: row.name, packageName: row.packageName, priceCents: row.priceCents, totalCents,
      revisionId: row.revisionId, promotionId: row.promotionId || null };
  });
  const priceCents = blockers.length ? null : roundRatio(BigInt(subtotal) * BigInt(10000 - discountBp), 10000n);
  const componentCapacity = capacityKnown && resources.size ? Math.max(0, Math.min(...[...resources.values()].map(r => Math.floor(r.stock / r.needed)))) : null;
  return { components, blockers, subtotalCents: blockers.length ? null : subtotal, priceCents,
    savingsCents: priceCents == null ? null : subtotal - priceCents,
    buyPriceCents: scaledInteger(input.buyPrice, 2), componentCapacity,
    availableBundles: input.inventoryMode === 'separate' ? input.stock : input.inventoryMode === 'components' ? componentCapacity : null,
    baskets: Object.fromEntries(['guest','member','herdShare','snap'].map(key => [key, priceCents])) };
}

export function observedBundlePrices(source) {
  return (source?.product_price_list_entries || []).map(row => {
    const entry = row.box_package_entry || {}, base = Number(source.price), value = Number(entry.adjustment_value);
    let price = base;
    if (entry.adjustment) price = Number(entry.adjustment_type) === 1 ? base + value : Number(entry.adjustment_type) === 2 ? base * (1 + value / 100) : Number(entry.adjustment_type) === 3 ? value : NaN;
    return { listId: Number(row.price_list), name: row.price_list_name, priceCents: Number.isFinite(price) && price >= 0 ? Math.round((price + Number.EPSILON) * 100) : null };
  });
}
