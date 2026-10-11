// Read-only catalog audit. No local catalog or Square writes.
// node --env-file=.env apps/api/scripts/reportSquarePricingUnits.js [--live] [--out=directory]
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool } from '../db.js';
import { loadApprovedSquarePricingRows, loadPackagesByProduct, buildSquareMatchRetailPrice,
  batchRetrieveSquareObjects, fetchSquare } from '../lib/squareStoreSync.js';
import { planSquareUnit } from '../lib/squarePricingUnits.js';

const live = process.argv.includes('--live');
const output = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || `reports/square-units/${new Date().toISOString().slice(0, 10)}`);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value == null ? 'Unknown' : `$${(value / 100).toFixed(2)}`;
try {
  const rows = await loadApprovedSquarePricingRows([], { includeAllProducts: true });
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct([...new Set(rows.map(row => Number(row.productId)))]);
  const objects = live ? await batchRetrieveSquareObjects(rows.map(row => row.squareVariationId)) : [];
  const objectMap = new Map(objects.map(object => [object.id, object]));
  const units = new Map();
  if (live) {
    let cursor;
    do {
      const params = new URLSearchParams({ types: 'MEASUREMENT_UNIT', ...(cursor ? { cursor } : {}) });
      const result = await fetchSquare(`/v2/catalog/list?${params}`);
      for (const object of result.objects || []) units.set(object.id, object);
      cursor = result.cursor;
    } while (cursor);
  }
  const [[cache]] = await getPool().query('SELECT MIN(last_synced_at) AS oldest, MAX(last_synced_at) AS newest FROM square_catalog_variations');
  const details = rows.map(row => {
    const object = live ? objectMap.get(row.squareVariationId) : parse(row.squareRawJson);
    const data = object?.item_variation_data;
    const retail = buildSquareMatchRetailPrice(row, packagesByProductId, metaByPackageId);
    const unitId = data?.measurement_unit_id || null;
    const definition = units.get(unitId)?.measurement_unit_data;
    const squareUnit = !data ? 'unavailable' : !unitId ? 'each/package (no measurement unit)' : definition?.measurement_unit?.weight_unit === 'IMPERIAL_POUND' ? 'lb' : definition ? JSON.stringify(definition) : `unverified unit ${unitId}`;
    let status = 'aligned', suggestion = '';
    if (!data || object.is_deleted) { status = 'review'; suggestion = 'Refresh/review the approved Square match; the variation is unavailable.'; }
    else if (retail.priceBasis === 'vendor-retail-price' && !['lbs', 'each'].includes(row.unitOfMeasure)) {
      status = 'review'; suggestion = 'Set/confirm the local Retail Price unit before changing Square. Do not infer it from the package name.';
    } else if (retail.unit === 'lb' && !unitId) {
      status = 'fix'; suggestion = `Assign a verified Square pound measurement unit; keep ${money(retail.amount)}/lb.`;
    } else if (unitId && !definition) { status = 'unverified'; suggestion = 'Read the live measurement-unit definition before deciding whether this needs a change.'; }
    else if (retail.unit === 'lb' && squareUnit !== 'lb') { status = 'review'; suggestion = 'Review the existing measurement unit and convert only after confirming the selling basis.'; }
    else if (retail.unit !== 'lb' && unitId) { status = 'review'; suggestion = 'Review Square’s explicit unit against the local each/package price.'; }
    if (live && data && !object.is_deleted) {
      const plan = planSquareUnit(retail.unit, object, units);
      status = plan.issues.length ? 'review' : plan.changed ? 'fix' : 'aligned';
      suggestion = plan.issues.join(' ') || (plan.changed ? `Set the Square selling unit to ${retail.unit}; use ${money(retail.amount)} per ${retail.unit}.` : '');
    }
    return { productId: Number(row.productId), product: row.productName, vendor: row.vendorName,
      packageId: Number(row.packageId), package: packagesByProductId.get(Number(row.productId))?.find(pkg => Number(pkg.id) === Number(row.packageId))?.name,
      squareItem: row.squareItemName, squareVariation: row.squareVariationName, squareVariationId: row.squareVariationId,
      localUnit: row.unitOfMeasure, expectedUnit: retail.unit, expectedAmount: retail.amount,
      squareAmount: data?.price_money?.amount ?? null, squareUnit, measurementUnitId: unitId,
      status, suggestion, priceDiffers: data?.price_money?.amount !== retail.amount };
  });
  const report = { generatedAt: new Date().toISOString(), source: live ? 'live Square API' : 'cached Square catalog', cache,
    linkedProducts: new Set(details.map(row => row.productId)).size, linkedPackages: details.length,
    counts: Object.fromEntries(['fix','review','unverified','aligned'].map(status => [status, details.filter(row => row.status === status).length])), rows: details };
  const issues = details.filter(row => ['fix','review'].includes(row.status));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Square pricing unit audit</title><style>body{font:16px system-ui;margin:40px;color:#213229}h1{font-size:28px}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{background:#edf2ed}small{color:#536257}.notice{padding:16px;background:#fff3d6}a{color:#245b38}</style></head><body><h1>Square pricing unit audit</h1><p>${escape(report.generatedAt)} · ${escape(report.source)} · ${report.linkedProducts} products / ${report.linkedPackages} linked packages</p><p class="notice">${live ? 'Live catalog read. No changes made by this report.' : `Preliminary: Square cache last refreshed ${escape(cache.newest)}. Live verification is required before repairs.`} ${report.counts.fix} missing-pound-unit candidates; ${report.counts.review} require review; ${report.counts.unverified} have an explicit unit whose definition has not been verified.</p><p>This report checks approved links for all vendors, excluding retired products and Membership. Unlinked products cannot be compared with Square. Only discrepancies/review items are shown below; the JSON includes full coverage. Package labels such as bags or weight ranges do not determine the Square selling unit. The local vendor retail unit controls formula products.</p><table><thead><tr><th>Product / local package</th><th>Square item / variation</th><th>Current Square</th><th>Local retail</th><th>Action</th></tr></thead><tbody>${issues.map(row => `<tr><td><strong>${escape(row.product)}</strong><br>${escape(row.package)}<br><small>Product ${row.productId} · package ${row.packageId}</small></td><td>${escape(row.squareItem)}<br>${escape(row.squareVariation)}</td><td>${money(row.squareAmount)} / ${escape(row.squareUnit)}</td><td>${money(row.expectedAmount)} / ${escape(row.expectedUnit)}${!row.localUnit ? '<br><strong>Local unit missing</strong>' : ''}</td><td><strong>${escape(row.status)}</strong><br>${escape(row.suggestion)}</td></tr>`).join('')}</tbody></table><p>Source: <a href="https://developer.squareup.com/reference/square/objects/CatalogItemVariation">Square CatalogItemVariation</a>. An absent measurement_unit_id uses whole-item quantities. Price-only synchronization misses this distinction.</p></body></html>`;
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'report.html'), html);
  console.log(JSON.stringify({ output, source: report.source, linkedProducts: report.linkedProducts, linkedPackages: report.linkedPackages, counts: report.counts,
    issues: issues.map(({ product, expectedUnit, expectedAmount, squareUnit, suggestion }) => ({ product, expectedUnit, expectedAmount, squareUnit, suggestion })) }, null, 2));
} finally { await getPool().end(); }
