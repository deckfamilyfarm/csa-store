// Read-only discovery. Run from the repository root with node --env-file=.env.
// This script has no provider mutation or order endpoint and never logs tokens.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.umask(0o077);
const root = path.dirname(new URL(import.meta.url).pathname);
const raw = path.join(root, 'raw');
const run = path.join(raw, 'catalog-2026-11-17');
const token = process.env.PRINTIFY_API_TOKEN?.trim();
if (!token) throw new Error('PRINTIFY_API_TOKEN is missing.');
const base = 'https://api.printify.com/v1/';
const errors = [];
const requests = [];
let lastRequest = 0;
await fs.mkdir(run, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(raw, '.gitignore'), '*\n', { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = async (file, value) => {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
};

async function get(endpoint, optional = false) {
  if (!/^(shops(?:\/\d+\/products(?:\/[a-zA-Z0-9-]+)?)?|catalog\/[a-zA-Z0-9_/-]+|uploads\/[a-zA-Z0-9-]+)\.json(?:\?[a-zA-Z0-9=&_-]+)?$/.test(endpoint)) {
    throw new Error('Endpoint rejected by discovery allowlist.');
  }
  const url = new URL(endpoint, base);
  if (url.origin !== 'https://api.printify.com') throw new Error('Invalid API origin.');
  const file = path.join(run, createHash('sha256').update(endpoint).digest('hex') + '.json');
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    requests.push({ endpoint, status: cached.status, capturedAt: cached.capturedAt, cached: true });
    return cached.data;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(Math.max(0, 700 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'CSAStore-ReadOnlyDiscovery/1.0', Accept: 'application/json' }
      });
    } catch {
      throw new Error('Printify GET failed at network/transport layer; no credentials logged.');
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await sleep(Math.min(10000, Math.max(1500, Number(response.headers.get('retry-after') || 0) * 1000)));
      continue;
    }
    const capturedAt = new Date().toISOString();
    requests.push({ endpoint, status: response.status, capturedAt, cached: false });
    if (!response.ok) {
      await response.body?.cancel();
      const error = { endpoint, status: response.status, capturedAt };
      errors.push(error);
      if (!optional || response.status === 401) {
        await save(path.join(run, 'request-status.json'), { requests, errors });
        throw new Error(`Printify GET returned HTTP ${response.status} for ${endpoint}.`);
      }
      return null;
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('Printify returned invalid JSON.'); }
    // Only response bodies are stored; request headers and credentials are excluded.
    await save(file, { endpoint, status: response.status, capturedAt, data });
    return data;
  }
}

async function pages(endpoint) {
  const all = [];
  let expected = null;
  for (let page = 1; page <= 1000; page++) {
    const data = await get(`${endpoint}?limit=50&page=${page}`);
    if (!Array.isArray(data.data)) throw new Error('Unexpected paginated response shape.');
    all.push(...data.data);
    if (Number.isInteger(data.total)) expected = data.total;
    if (Number.isInteger(data.last_page) ? page >= data.last_page : data.next_page_url === null || data.data.length < 50) {
      if (expected !== null && all.length !== expected) throw new Error('Catalog pagination total changed; review snapshot.');
      return all;
    }
  }
  throw new Error('Pagination safety limit reached.');
}

try {
  const shops = await get('shops.json');
  if (!Array.isArray(shops)) throw new Error('Unexpected shops response.');
  console.log(JSON.stringify({ tokenVerified: true, shops: shops.map(s => ({ id: s.id, title: s.title, salesChannel: s.sales_channel })) }));
  if (process.argv.includes('--shops-only')) process.exit(0);
  const products = [];
  for (const shop of shops) {
    const listed = await pages(`shops/${shop.id}/products.json`);
    if (new Set(listed.map(p => p.id)).size !== listed.length) throw new Error('Duplicate product IDs in pagination.');
    for (const item of listed) {
      const product = await get(`shops/${shop.id}/products/${item.id}.json`);
      if (product.id !== item.id) throw new Error('Product ID mismatch.');
      products.push({ shopId: shop.id, shopTitle: shop.title, salesChannel: shop.sales_channel, product });
    }
    console.log(JSON.stringify({ shopId: shop.id, productCount: listed.length }));
  }
  const pairs = new Map();
  for (const { product } of products) {
    const key = `${product.blueprint_id}/${product.print_provider_id}`;
    if (pairs.has(key)) continue;
    const endpoint = `catalog/blueprints/${product.blueprint_id}/print_providers/${product.print_provider_id}`;
    pairs.set(key, {
      blueprint: await get(`catalog/blueprints/${product.blueprint_id}.json`, true),
      provider: await get(`catalog/print_providers/${product.print_provider_id}.json`, true),
      blueprintProvider: await get(`${endpoint}.json`, true),
      variants: await get(`${endpoint}/variants.json?show-out-of-stock=1`, true),
      shipping: await get(`${endpoint}/shipping.json`, true)
    });
  }
  const artworkIds = [...new Set(products.flatMap(({ product }) => (product.print_areas || []).flatMap(area =>
    (area.placeholders || []).flatMap(holder => (holder.images || []).map(image => image.id).filter(Boolean)))))];
  const artworks = [];
  for (const id of artworkIds) artworks.push({ id, upload: await get(`uploads/${id}.json`, true) });
  const optionValues = product => new Map((product.options || []).flatMap(o => (o.values || []).map(v => [v.id, { type: o.type, name: o.name, title: v.title }])));
  const mappings = products.flatMap(({ shopId, shopTitle, salesChannel, product }) => {
    const options = optionValues(product);
    return (product.variants || []).map(v => ({
      sourceShopId: shopId, sourceProductId: product.id, sourceVariantId: v.id,
      shopTitle, salesChannel, name: product.title, variantTitle: v.title, sku: v.sku,
      options: (v.options || []).map(id => ({ id, ...(options.get(id) || {}) })),
      enabled: v.is_enabled ?? null, available: v.is_available ?? null,
      blueprintId: product.blueprint_id, printProviderId: product.print_provider_id,
      supplierCostCents: v.cost ?? null, existingChannelRetailCents: v.price ?? null,
      currency: product.currency ?? shops.find(s => s.id === shopId)?.currency ?? null,
      targetShopId: null, targetProductId: null, targetVariantId: null,
      localProductId: null, localVariantId: null, localRetailCents: null,
      status: 'source_captured_pending_review'
    }));
  });
  const summaries = products.map(({ shopId, shopTitle, salesChannel, product: p }) => {
    const pair = pairs.get(`${p.blueprint_id}/${p.print_provider_id}`);
    const enabled = (p.variants || []).filter(v => v.is_enabled);
    const prices = enabled.map(v => v.price).filter(Number.isInteger);
    const costs = enabled.map(v => v.cost).filter(Number.isInteger);
    return {
      shopId, shopTitle, salesChannel, productId: p.id, title: p.title,
      blueprintId: p.blueprint_id, blueprintTitle: pair.blueprint?.title ?? null,
      printProviderId: p.print_provider_id, printProvider: pair.provider?.title ?? pair.blueprintProvider?.title ?? null,
      visible: p.visible ?? null, locked: p.is_locked ?? null,
      variantCount: p.variants?.length || 0, enabledVariantCount: enabled.length,
      enabledAvailableVariantCount: enabled.filter(v => v.is_available === true).length,
      enabledUnknownAvailabilityCount: enabled.filter(v => v.is_available == null).length,
      existingRetailMinCents: prices.length ? Math.min(...prices) : null,
      existingRetailMaxCents: prices.length ? Math.max(...prices) : null,
      supplierCostMinCents: costs.length ? Math.min(...costs) : null,
      supplierCostMaxCents: costs.length ? Math.max(...costs) : null,
      currency: p.currency ?? shops.find(s => s.id === shopId)?.currency ?? null,
      imageCount: p.images?.length || 0,
      descriptionCaptured: typeof p.description === 'string',
      artworkIds: [...new Set((p.print_areas || []).flatMap(a => (a.placeholders || []).flatMap(h => (h.images || []).map(i => i.id).filter(Boolean))))],
      decorationMethods: [...new Set((p.print_areas || []).flatMap(a => (a.placeholders || []).map(h => h.decoration_method).filter(Boolean)))],
      external: p.external ?? null,
      shippingCaptured: pair.shipping !== null,
      catalogVariantsCaptured: pair.variants !== null,
      artworkVisualVerification: 'pending'
    };
  });
  const inventory = {
    capturedAt: new Date().toISOString(), status: errors.length ? 'captured_with_gaps' : 'source_catalog_captured_pending_review',
    tokenVerified: true, shopsRetrieved: true, shops, shopCount: shops.length,
    productCount: products.length, variantCount: mappings.length,
    enabledVariantCount: mappings.filter(v => v.enabled).length,
    existingWixShopIds: shops.filter(s => /wix/i.test(s.sales_channel || '')).map(s => s.id),
    fulfillmentShopDecision: 'pending_approval_policy_and_order_channel_verification',
    artworkCount: artworkIds.length, artworkMetadataRetrievedCount: artworks.filter(a => a.upload).length,
    artworkVerified: false, rawSnapshotDirectory: path.relative(root, run),
    products: summaries, errors, remoteWritesPerformed: false, wixDisconnected: false,
    note: 'Prices are existing channel values, not approved CSA retail. Currency must be verified where absent. No supplier order or shop mutation was attempted.'
  };
  await save(path.join(run, 'complete-catalog.json'), { products, catalogPairs: Object.fromEntries(pairs), artworks, requests, errors });
  await save(path.join(root, 'catalog-inventory.json'), inventory);
  await save(path.join(root, 'variant-migration-mapping.json'), { capturedAt: inventory.capturedAt, mappings });
  function csv(value) {
    let text = value == null ? '' : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  const columns = ['shopId', 'productId', 'title', 'printProvider', 'blueprintId', 'printProviderId', 'variantCount', 'enabledVariantCount', 'enabledAvailableVariantCount', 'existingRetailMinCents', 'existingRetailMaxCents', 'supplierCostMinCents', 'supplierCostMaxCents', 'currency', 'imageCount'];
  await fs.writeFile(path.join(root, 'products.csv'), [columns.map(csv).join(','), ...summaries.map(p => columns.map(c => csv(p[c])).join(','))].join('\n') + '\n', { mode: 0o600 });
  await save(path.join(run, 'request-status.json'), { requests, errors });
  console.log(JSON.stringify({ status: inventory.status, shops: shops.length, products: products.length, variants: mappings.length, enabledVariants: inventory.enabledVariantCount, artworkReferences: artworkIds.length, metadataGaps: errors }));
} catch (error) {
  console.error(error.message.replaceAll(token, '[REDACTED]'));
  process.exitCode = 1;
}
