import fs from 'node:fs/promises';
import { fetchSquare, listSquareCatalogItems } from '../lib/squareStoreSync.js';
import { squareObjectAtLocation } from '../lib/squareItemLocations.js';

const [items, response] = await Promise.all([listSquareCatalogItems(), fetchSquare('/v2/locations')]);
const locations = response.locations.filter(row => row.status === 'ACTIVE');
const categories = []; let cursor;
do {
  const params = new URLSearchParams({ types: 'CATEGORY' }); if (cursor) params.set('cursor', cursor);
  const page = await fetchSquare('/v2/catalog/list?' + params);
  categories.push(...(page.objects || []).filter(row => !row.is_deleted)); cursor = page.cursor;
} while (cursor);
const names = new Map(categories.map(row => [row.id, row.category_data?.name]));
const rows = items.filter(item => !item.is_deleted && !item.item_data?.is_archived).map(item => {
  const ids = [...new Set([...(item.item_data?.categories || []).map(row => row.id), item.item_data?.category_id].filter(Boolean))];
  const variations = (item.item_data.variations || []).filter(row => !row.is_deleted);
  return { id: item.id, name: item.item_data.name, categoryIds: ids, categories: ids.map(id => names.get(id)).filter(Boolean),
    reportingCategory: names.get(item.item_data.reporting_category?.id) || null,
    variations: variations.map(row => ({ id: row.id, name: row.item_variation_data.name, sku: row.item_variation_data.sku || '' })),
    availableAt: locations.filter(location => squareObjectAtLocation(item, location.id) && variations.some(row => squareObjectAtLocation(row, location.id))).map(row => row.name) };
}).filter(row => !row.categories.length).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
const directory = new URL(`../../../reports/square-uncategorized-${new Date().toISOString().slice(0, 10)}/`, import.meta.url);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(new URL('items.json', directory), JSON.stringify({ capturedAt: new Date().toISOString(), activeLocations: locations.map(({ id, name }) => ({ id, name })), rows }, null, 2) + '\n');
const csv = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
await fs.writeFile(new URL('items.csv', directory), [
  ['Square item ID', 'Product', 'Variation / SKU', 'Available locations', 'Reporting category'],
  ...rows.map(row => [row.id, row.name, row.variations.map(v => `${v.name}: ${v.sku}`).join('; '), row.availableAt.join('; ') || 'Not currently available', row.reportingCategory || ''])
].map(row => row.map(csv).join(',')).join('\n') + '\n');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const table = list => `<table><thead><tr><th>Product</th><th>Variation / SKU</th><th>Available locations</th></tr></thead><tbody>${list.map(row => `<tr><td>${esc(row.name)}<br><small>${esc(row.id)}</small></td><td>${row.variations.map(v => esc(`${v.name} · ${v.sku}`)).join('<br>')}</td><td>${esc(row.availableAt.join(', ') || 'Not currently available')}</td></tr>`).join('')}</tbody></table>`;
const active = rows.filter(row => row.availableAt.length), unavailable = rows.filter(row => !row.availableAt.length);
await fs.writeFile(new URL('items.html', directory), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Uncategorized Square items</title><style>body{font:16px system-ui;max-width:1200px;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;text-align:left;vertical-align:top;padding:8px}small{color:#666}</style><h1>Uncategorized Square items</h1><p>Live Square catalog, ${esc(new Date().toISOString())}. Deleted and archived items excluded. No catalog changes were made by this report.</p><h2>Available at active locations (${active.length})</h2>${table(active)}<h2>Not currently available at active locations (${unavailable.length})</h2>${table(unavailable)}</html>`);
console.log(JSON.stringify({ report: new URL('items.html', directory).pathname, total: rows.length,
  available: active.map(row => ({ name: row.name, id: row.id })), unavailable: unavailable.map(row => ({ name: row.name, id: row.id })) }, null, 2));
