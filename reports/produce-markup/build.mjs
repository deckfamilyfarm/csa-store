#!/usr/bin/env node
// Read-only catalog and order analysis. This file never saves prices or publishes to a platform.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from '../../apps/api/node_modules/xlsx/xlsx.js';
import { getDb, getPool } from '../../apps/api/db.js';
import * as schema from '../../apps/api/schema.js';
import { computeFinalPrice, isNoMarkupProduct, isSourcePricingVendor, resolvePricingProfile } from '../../apps/api/lib/productPricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(x => {
  const at = x.indexOf('=');
  return [x.slice(2, at < 0 ? undefined : at), at < 0 ? 'true' : x.slice(at + 1)];
}));
const output = path.resolve(args.output || path.join(here, 'produce-markup-plan.xlsx'));
const overridesPath = path.resolve(args.overrides || path.join(here, 'classification-overrides.json'));
const snapshotPath = args.snapshot ? path.resolve(args.snapshot) : null;
const lastCompleteMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0));
const defaultThrough = lastCompleteMonth.toISOString().slice(0, 10);
const from = args.from || `${defaultThrough.slice(0, 4)}-01-01`;
const through = args.through || defaultThrough;
assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
assert.match(through, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(from <= through, 'The sales start date must be on or before the end date.');
const num = value => value == null || value === '' ? null : Number(value);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const key = (productId, packageId) => `${Number(productId)}|${Number(packageId)}`;
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const listKeys = { 'Guest Basket': 'guest', 'CSA Members': 'member', 'Herd Share Members': 'herdShare', SNAP: 'snap' };
const isProduceCategory = name => /organic (fruit|fruiting vegetables|cruciferous vegetables|vegetables|mushrooms)/i.test(name || '');
const tierName = { 100: 'Under 1 week / high loss', 60: '1 week to under 1 month', 45: '1 month+ / preserved' };
const dollarFmt = '$#,##0.00;[Red]($#,##0.00)';
const pctFmt = '0.0%';

function classify(name, category) {
  const n = fold(name), c = fold(category);
  const out = (rate, why) => ({ rate, tier: tierName[rate], why });
  if (/\b(frozen|dried|dehydrated|cured)\b/.test(n)) return out(45, 'Frozen, dried, or cured');
  if (c.includes('mushroom')) return out(100, 'Fresh mushrooms');
  if (c.includes('herb')) return out(100, 'Fresh herbs and flowers wilt quickly');
  if (c.includes('leafy')) {
    if (/\bcabbage\b/.test(n) && !/bok choi/.test(n)) return out(45, 'Mature storage cabbage');
    if (/\b(radicchio|chicory head|chicory|endive)\b/.test(n) && !/mix|young|braising/.test(n)) return out(60, 'Firm chicory or radicchio; verify storage practice');
    return out(100, 'Leafy greens, lettuce, salad mix, or shoots');
  }
  if (c.includes('cruciferous')) {
    if (/kohlrabi/.test(n)) return out(60, 'Kohlrabi is sold here in bunches; verify whether tops are removed');
    if (/raab|rapini|greens/.test(n)) return out(100, 'Tender brassica greens');
    return out(60, 'Broccoli, cauliflower, or Brussels sprouts');
  }
  if (c.includes('root')) {
    if (/(green garlic|garlic scape|scallion|spring onion|green onion|baby red onion|carrot \(baby\) bunch)/.test(n)) return out(100, 'Fresh or bunched roots/alliums with tender tops');
    if (/(radish|leek|fennel|hakurei turnip|salad turnip|walla walla onion|sweet onion|fresh red onion)/.test(n)) return out(60, 'Fresh root or allium generally kept for weeks');
    if (/shishito pepper/.test(n)) return out(60, 'Pepper filed in roots category');
    if (/(potato|onion|shallot|garlic|carrot|beet|turnip|rutab|celeriac|parsnip|sunchoke|yacon|daikon)/.test(n)) return out(45, 'Storage root or cured allium; confirm tops removed and correct storage');
    return { rate: null, tier: 'Review', why: 'Unrecognized root item' };
  }
  if (c.includes('fruiting vegetable')) {
    if (/(kabocha|kubucha|butternut|delicata|honeynut|acorn squash|winter squash|autumn frost|tetsakabuto|blue kuri|mini butternut)/.test(n)) return out(45, 'Hard-rind winter squash');
    if (/(pepper|jalapeno|habanero|poblano|serrano|cayenne|fresno|padron|shishito|cornito)/.test(n)) return out(60, 'Fresh peppers generally store for weeks');
    if (/tomatillo/.test(n)) return out(60, 'Tomatillo; confirm condition on receipt');
    if (/(tomato|cucumber|eggplant|zucchini|summer squash|bean|pea)/.test(n)) return out(100, 'Tender or ripe fruiting vegetable');
    return { rate: null, tier: 'Review', why: 'Unrecognized fruiting vegetable' };
  }
  if (c.includes('fruit')) {
    if (/apple.*seconds/.test(n)) return out(60, 'Blemished apples; shorter marketable life than sound storage fruit');
    if (/\b(apple|quince)\b/.test(n)) return out(45, 'Storage apple or quince');
    if (/\b(pear|kiwi|persimmon|watermelon)\b/.test(n)) return out(60, 'Fresh fruit that may last weeks if handled well');
    if (/\b(eggplant)\b/.test(n)) return out(100, 'Eggplant filed in fruit category');
    if (/tomatillo/.test(n)) return out(60, 'Tomatillo filed in fruit category');
    return out(100, 'Fresh fruit; review ripeness and cold chain');
  }
  return { rate: null, tier: 'Review', why: 'Category outside produce scope' };
}

async function catalog() {
  if (snapshotPath) return JSON.parse(await readFile(snapshotPath, 'utf8'));
  const db = getDb(), data = {};
  for (const name of ['vendors', 'categories', 'products', 'packages', 'productPricingProfiles', 'productSales']) {
    data[name] = await db.select().from(schema[name]);
  }
  return data;
}

async function sales() {
  if (snapshotPath) return { rows: [], overall: 0, months: [], source: 'Offline catalog snapshot; no sales history' };
  const pool = getPool();
  const [rows] = await pool.query(`SELECT product_id AS productId, package_id AS packageId,
    price_list_name AS priceList, SUM(quantity) AS quantity, SUM(retail_amount) AS actualRevenue,
    COUNT(*) AS lineCount FROM local_line_order_reporting_entries
    WHERE fulfillment_date BETWEEN ? AND ? AND order_status = 'OPEN' AND payment_status = 'PAID'
      AND price_list_name IN ('Guest Basket','CSA Members','Herd Share Members','SNAP')
    GROUP BY product_id, package_id, price_list_name`, [from, through]);
  const [[overall]] = await pool.query(`SELECT COALESCE(SUM(retail_amount),0) AS revenue,
    COUNT(*) AS lineCount FROM local_line_order_reporting_entries
    WHERE fulfillment_date BETWEEN ? AND ? AND order_status = 'OPEN' AND payment_status = 'PAID'
      AND price_list_name IN ('Guest Basket','CSA Members','Herd Share Members','SNAP')`, [from, through]);
  const [months] = await pool.query(`SELECT month_key AS monthKey, status, row_count AS rowCount,
    synced_at AS syncedAt FROM local_line_order_reporting_months
    WHERE month_key BETWEEN ? AND ? ORDER BY month_key`, [from.slice(0, 7), through.slice(0, 7)]);
  return { rows, overall: Number(overall.revenue), overallLines: Number(overall.lineCount), months,
    source: 'Local Line reporting cache: OPEN + PAID order lines, four shopping price lists' };
}

function sheet(rows, widths, filter = false) {
  const s = XLSX.utils.aoa_to_sheet(rows);
  s['!cols'] = widths.map(w => ({ wch: w }));
  if (filter) s['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(rows[0].length - 1)}${rows.length}` };
  return s;
}
function fmtCol(s, col, start, end, z) {
  for (let r = start; r <= end; r++) {
    const cell = s[XLSX.utils.encode_cell({ r: r - 1, c: col - 1 })];
    if (cell && cell.t === 'n') cell.z = z;
  }
}
function formula(s, address, expression, cached) { s[address] = { t: typeof cached === 'number' ? 'n' : 's', f: expression, v: cached }; }

const data = await catalog();
const saleData = await sales();
const overrides = JSON.parse(await readFile(overridesPath, 'utf8'));
const vendors = new Map(data.vendors.map(v => [Number(v.id), v]));
const categories = new Map(data.categories.map(c => [Number(c.id), c]));
const profiles = new Map(data.productPricingProfiles.map(p => [Number(p.productId), p]));
const salesProfiles = new Map(data.productSales.map(p => [Number(p.productId), p]));
const packagesByProduct = new Map();
for (const p of data.packages) {
  if (!packagesByProduct.has(Number(p.productId))) packagesByProduct.set(Number(p.productId), []);
  packagesByProduct.get(Number(p.productId)).push(p);
}
const salesBySku = new Map();
for (const s of saleData.rows) {
  const k = key(s.productId, s.packageId);
  if (!salesBySku.has(k)) salesBySku.set(k, []);
  salesBySku.get(k).push(s);
}

const rows = [], model = [], excluded = { formulaVendor: 0, missingVendor: 0, nonProduce: 0, membershipOrDeposit: 0 };
for (const product of data.products) {
  if (product.isDeleted) continue;
  const category = categories.get(Number(product.categoryId))?.name || '';
  if (!isProduceCategory(category)) { excluded.nonProduce++; continue; }
  const vendor = vendors.get(Number(product.vendorId));
  if (isSourcePricingVendor(vendor)) { excluded.formulaVendor++; continue; }
  if (isNoMarkupProduct(product) || fold(category) === 'membership') { excluded.membershipOrDeposit++; continue; }
  if (!vendor?.name?.trim()) excluded.missingVendor++;
  const packages = packagesByProduct.get(Number(product.id)) || [];
  const profile = { ...(profiles.get(Number(product.id)) || {}), ...(salesProfiles.get(Number(product.id)) || {}) };
  const resolved = resolvePricingProfile({ product, vendor, packages, profile });
  const configuredMarkups = ['guestMarkup', 'memberMarkup', 'herdShareMarkup', 'snapMarkup'].map(x => resolved[x]);
  const sameMarkup = configuredMarkups.every(x => x === configuredMarkups[0]);
  const customPrices = Array.isArray(resolved.customerPriceOverrides) && resolved.customerPriceOverrides.length > 0;
  let decision = classify(product.name, category);
  const manual = overrides[String(product.id)];
  if (manual) {
    assert.ok([45, 60, 100, 'skip'].includes(manual.rate), `Invalid override rate for product ${product.id}`);
    assert.ok(String(manual.reason || '').trim(), `Missing override reason for product ${product.id}`);
    decision = manual.rate === 'skip' ? { rate: null, tier: 'Manual skip', why: manual.reason }
      : { rate: manual.rate, tier: tierName[manual.rate], why: `Manual: ${manual.reason}` };
  }
  const packageList = packages.length ? packages : [{ id: null, name: '', price: null, visible: 0 }];
  for (const pkg of packageList) {
    const base = num(pkg.price);
    const current = sameMarkup ? num(configuredMarkups[0]) : null;
    const target = decision.rate == null ? null : decision.rate / 100;
    const currentRegular = base != null && current != null ? computeFinalPrice(base, current, false, 0).regular : null;
    const proposedRegular = base != null && target != null ? computeFinalPrice(base, target, false, 0).regular : null;
    const status = !vendor?.name?.trim() ? 'HOLD missing vendor' : decision.rate == null ? 'HOLD classification' : !base || base <= 0 ? 'HOLD missing base price'
      : customPrices ? 'HOLD customer price overrides' : !sameMarkup ? 'HOLD different customer-list rates'
      : resolved.onSale ? 'REVIEW active sale' : !product.visible || !pkg.visible ? 'REVIEW hidden / seasonal' : 'Candidate';
    const skuSales = pkg.id == null ? [] : (salesBySku.get(key(product.id, pkg.id)) || []);
    const units = skuSales.reduce((n, x) => n + Number(x.quantity || 0), 0);
    const actualRevenue = skuSales.reduce((n, x) => n + Number(x.actualRevenue || 0), 0);
    rows.push({ vendor: vendor?.name || '(missing vendor)', category, productId: Number(product.id), product: product.name,
      packageId: pkg.id == null ? null : Number(pkg.id), package: pkg.name || '',
      visible: Boolean(product.visible && pkg.visible), base, current, target, tier: decision.tier,
      reason: decision.why, currentRegular, proposedRegular,
      difference: currentRegular != null && proposedRegular != null ? money(proposedRegular - currentRegular) : null,
      pctIncrease: currentRegular > 0 && proposedRegular != null ? proposedRegular / currentRegular - 1 : null,
      units, actualRevenue, status, currentOverride: num(profiles.get(Number(product.id))?.markupOverride),
      onSale: Boolean(resolved.onSale), saleDiscount: Number(resolved.saleDiscount || 0),
      customPrices, salesLines: skuSales.length });
    if (status.startsWith('HOLD') || base == null || pkg.id == null) continue;
    for (const s of skuSales) {
      const list = listKeys[s.priceList];
      if (!list || Number(s.quantity) <= 0) continue;
      const priorMarkup = num(resolved[`${list}Markup`]);
      const oldPrice = computeFinalPrice(base, priorMarkup, Boolean(resolved.onSale), Number(resolved.saleDiscount || 0)).final;
      const newPrice = computeFinalPrice(base, target, Boolean(resolved.onSale), Number(resolved.saleDiscount || 0)).final;
      if (oldPrice == null || newPrice == null) continue;
      model.push({ category, tier: decision.tier, vendor: vendor.name, visible: Boolean(product.visible && pkg.visible), productId: Number(product.id),
        packageId: Number(pkg.id), list: s.priceList, units: Number(s.quantity),
        actualRevenue: Number(s.actualRevenue || 0), oldRevenue: Number(s.quantity) * oldPrice,
        newRevenue: Number(s.quantity) * newPrice, proxyCost: Number(s.quantity) * base });
    }
  }
}
rows.sort((a, b) => a.category.localeCompare(b.category) || a.tier.localeCompare(b.tier) || a.vendor.localeCompare(b.vendor) || a.product.localeCompare(b.product) || (a.packageId || 0) - (b.packageId || 0));
const sum = (list, field) => list.reduce((n, x) => n + (Number(x[field]) || 0), 0);
const oldRevenue = sum(model, 'oldRevenue'), newRevenue = sum(model, 'newRevenue');
const proxyCost = sum(model, 'proxyCost'), actualAffectedRevenue = sum(model, 'actualRevenue');
const visibleModel = model.filter(r => r.visible), hiddenModel = model.filter(r => !r.visible);
const visibleOldRevenue = sum(visibleModel, 'oldRevenue'), visibleNewRevenue = sum(visibleModel, 'newRevenue');
const hiddenOldRevenue = sum(hiddenModel, 'oldRevenue'), hiddenNewRevenue = sum(hiddenModel, 'newRevenue');
const defaultFee = 0.03;

const plan = [
  ['PRODUCE MARKUP PLAN — REVIEW BEFORE APPLYING'],
  ['Generated UTC', new Date().toISOString()],
  ['Catalog', snapshotPath ? `Offline snapshot: ${snapshotPath}` : 'Live local CSA Store database, read only'],
  ['Sales period', `${from} through ${through}; ${saleData.source}`],
  ['Scope', 'Organic fruit, fruiting vegetables, cruciferous vegetables, mushrooms, herbs, leafy greens, roots; nondeleted; named vendors.'],
  ['Exclusions and holds', `Deck Family Farm / Hyland / Creamy Cow: ${excluded.formulaVendor} excluded products; deposits/Membership: ${excluded.membershipOrDeposit} excluded; missing vendor: ${excluded.missingVendor} held.`],
  ['Cost warning', '“Vendor cost proxy” is the local package base price, not a verified supplier invoice or landed cost. Enter actual cost and review before approval.'],
  ['Profit warning', 'Profit Model estimates CHANGE in net profit if other expenses are fixed. It cannot establish absolute net income without an accounting baseline, true landed costs, loss rates, and demand response.'],
  ['Shelf-life warning', 'Tiers are planning assumptions. Actual life depends on maturity, delivery age, temperature, packaging, and your sell-through.'],
  [],
  ['CATEGORY / TIER', 'Markup', 'Package rows', 'Sample SKU', 'Vendor cost proxy', 'Current regular', 'Proposed regular', 'Rule'],
];
const groups = new Map();
for (const r of rows) {
  const k = `${r.category}|${r.tier}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, group] of groups) {
  const sample = [...group].filter(r => r.base > 0).sort((a, b) => Number(b.visible) - Number(a.visible) || b.units - a.units)[0] || group[0];
  plan.push([`${sample.category} — ${sample.tier}`, sample.target, group.length,
    `${sample.product}${sample.package ? ` / ${sample.package}` : ''}`, sample.base, sample.currentRegular,
    sample.proposedRegular, sample.reason]);
}
plan.push([], ['AGENT IMPLEMENTATION INSTRUCTIONS'],
  ['1. Review scope', 'Filter Product Pricing by HOLD and REVIEW. Confirm vendor, category, active/seasonal status, product shelf life, and package identity. Do not publish products with unresolved holds.'],
  ['2. Verify cost', 'Compare the local base price and the blank “Verified vendor cost” field against supplier invoices, freight, packaging, and any purchased-unit conversions. Correct costs through the normal local pricing workflow first.'],
  ['3. Confirm tier', 'Use 100% for produce normally sold within a week, 60% for about 1–4 weeks, and 45% for storage, frozen, or dried items. Amend classification-overrides.json for product-specific decisions and regenerate the workbook.'],
  ['4. Check price and demand', 'Review sample and all SKU prices against local retail prices and producer agreements. Check recent spoilage, customer volume, and active sales; revise rates where demand or margins warrant.'],
  ['5. Save locally', 'For approved standard products only, set the product markup override in Store → Pricing / Products Details, or PUT /api/admin/products/:id/markup with markupOverride 1.00, 0.60, or 0.45. This is a local save.'],
  ['6. Publish deliberately', 'Run selected-product checks in Store → Product Sync for Local Line. Review frozen audit actions and price-list results, then approve only supported price actions. Do not patch Local Line directly. Square mirrors its separate CSA Store retail/package price rules; do not push these customer-list markups to Square.'],
  ['7. Verify and monitor', 'Read back local and Local Line guest/member/herd-share/SNAP prices, sales and exceptions. Compare weekly sell-through, shrink, and order units for at least four weeks; adjust tiers individually.'],
  [], ['SOURCES', 'URL'],
  ['University of Minnesota vegetable storage and shelf life', 'https://extension.umn.edu/garden-and-home/yard-and-garden/gardening-in-minnesota/harvesting-and-storing-home-garden-vegetables'],
  ['Oregon State food storage times', 'https://extension.oregonstate.edu/sites/extd8/files/2023-08/pnw612.pdf'],
  ['NC State retailer produce margin guidance', 'https://growingsmallfarms.ces.ncsu.edu/growingsmallfarms-marketingretailers/'],
  [],
  ['RERUN', 'From the repository root: node --env-file=.env reports/produce-markup/build.mjs'],
  ['Fixed period', 'Add --from=2026-01-01 --through=2026-09-30. Without dates, the script uses the current year through the last complete month.'],
  ['Manual decision file', 'classification-overrides.json accepts product IDs such as {"805758":{"rate":45,"reason":"Frozen product"}}. Rates are 45, 60, 100, or "skip".'],
);

const headers = ['Vendor', 'Category', 'Product ID', 'Product', 'Package ID', 'Package', 'Visible now',
  'Vendor cost proxy / local base', 'Verified vendor cost (enter)', 'Current markup', 'New markup', 'Shelf-life tier',
  'Classification reason', 'Current regular price', 'New regular price', 'Change / unit', 'Price change %',
  'Historical units', 'Historical actual revenue', 'Modeled revenue gain, same units', 'Existing product override',
  'Active sale', 'Sale discount', 'Customer price overrides', 'Activation status', 'Agent decision', 'Agent notes'];
const pricing = [headers, ...rows.map(r => [r.vendor, r.category, r.productId, r.product, r.packageId,
  r.package, r.visible ? 'Yes' : 'No', r.base, null, r.current, r.target, r.tier, r.reason,
  r.currentRegular, r.proposedRegular, r.difference, r.pctIncrease, r.units, money(r.actualRevenue),
  r.difference == null || r.status.startsWith('HOLD') ? null : money(r.units * r.difference), r.currentOverride, r.onSale ? 'Yes' : 'No',
  r.saleDiscount, r.customPrices ? 'Yes' : 'No', r.status, '', ''])];

const profit = [
  ['PROFIT MODEL — INCREMENTAL EFFECT, NOT AUDITED NET INCOME'],
  ['Sales period', `${from} through ${through}`],
  ['Included', 'OPEN + PAID Local Line order lines in Guest, CSA Members, Herd Share, and SNAP; eligible produce SKUs only. Hidden seasonal SKUs with historic sales are included.'],
  ['Method', 'Replay historic units at CURRENT local prices and proposed prices; hold other expenses constant. Package base is a COGS proxy, not verified invoice cost.'],
  ['Variable transaction fee (editable)', defaultFee],
  ['Historical actual revenue — all four lists', money(saleData.overall)],
  ['Actual accounting net income for same period (enter)', null],
  ['Historical actual revenue — modeled affected SKUs', money(actualAffectedRevenue)],
  ['Replayed current revenue — affected SKUs', money(oldRevenue)],
  ['Replayed proposed revenue — affected SKUs', money(newRevenue)],
  ['Purchase/base cost proxy — affected SKU units', money(proxyCost)],
  ['Historical sales lines — all four lists', saleData.overallLines || 0],
  ['Affected SKU/list rows used', model.length],
  ['Currently visible SKUs — net change, same units', money((visibleNewRevenue - visibleOldRevenue) * (1 - defaultFee))],
  ['Hidden / seasonal SKUs — potential net change', money((hiddenNewRevenue - hiddenOldRevenue) * (1 - defaultFee))],
  ['Unmatched sales or held prices', 'Not modeled. See Product Pricing HOLD rows; blanks or missing package links reduce coverage.'],
  [],
  ['SCENARIO', 'Unit volume decline', 'Current replay revenue', 'New replay revenue',
    'Purchase cost if adjusted', 'Purchase cost if fixed', 'Net profit change: buying adjusts',
    'Net profit change: purchases fixed', 'Overall net profit if baseline entered — adjusted',
    'Overall net profit if baseline entered — fixed'],
];
const firstScenario = profit.length + 1;
for (const decline of [0, 0.05, 0.1, 0.2]) {
  const n = profit.length + 1;
  const adjusted = ((1 - decline) * newRevenue - oldRevenue) * (1 - defaultFee) + decline * proxyCost;
  const fixed = ((1 - decline) * newRevenue - oldRevenue) * (1 - defaultFee);
  profit.push([`${Math.round(decline * 100)}% fewer units`, decline, money(oldRevenue), money((1 - decline) * newRevenue),
    money((1 - decline) * proxyCost), money(proxyCost), money(adjusted), money(fixed),
    null, null]);
}
const lastScenario = firstScenario + 3;
profit.push([], ['CATEGORY EFFECT AT UNCHANGED UNITS', 'Historic units', 'Current replay revenue',
  'Proposed replay revenue', 'Revenue change', 'Net change after fee']);
const categoriesModel = new Map();
for (const row of model) {
  if (!categoriesModel.has(row.category)) categoriesModel.set(row.category, []);
  categoriesModel.get(row.category).push(row);
}
const categoryStart = profit.length + 1;
for (const [category, items] of categoriesModel) {
  profit.push([category, sum(items, 'units'), money(sum(items, 'oldRevenue')),
    money(sum(items, 'newRevenue')), money(sum(items, 'newRevenue') - sum(items, 'oldRevenue')), null]);
}
profit.push([], ['SALES CACHE MONTH', 'Status', 'Imported line count', 'Last synced UTC']);
for (const m of saleData.months) profit.push([m.monthKey, m.status, Number(m.rowCount), String(m.syncedAt || '')]);
profit.push([], ['MODEL LIMITS'],
  ['Actual net income', 'Enter accounting net income for the same period in B7 to see projected overall net income. Without it, only the change can be estimated.'],
  ['Cost proxy', 'The local package base is not an invoice-backed vendor cost; freight, spoilage, packing, labor, taxes, and fixed expenses are not separately measured here.'],
  ['Demand', 'Scenarios show 0%, 5%, 10%, and 20% fewer units. Buying-adjusts assumes procurement drops proportionately; fixed-purchases treats unsold units as added loss.'],
  ['Visible versus seasonal', 'The all-SKU scenario assumes currently hidden seasonal products return in a comparable season. For near-term impact from visible products, use the visible-only line above.'],
  ['Sales price replay', 'Historical revenue may differ from replay because prices, sales, and customer-specific adjustments changed during the period. Compare rows 8–10 before relying on the projection.'],
  ['Product exclusions', 'Formula vendors Deck/Hyland/Creamy Cow, memberships, deposits, missing vendors, and customer-price override HOLDs are not repriced by this plan.'],
  ['No mutation', 'Generating this workbook reads the catalog and local order cache only. It does not save, audit, or publish prices.']);

const book = XLSX.utils.book_new();
const sPlan = sheet(plan, [62, 80, 18, 52, 23, 22, 22, 76]);
const sPricing = sheet(pricing, [28, 48, 13, 42, 13, 25, 13, 23, 23, 17, 16, 29, 58, 21, 20, 18, 18, 18, 23, 25, 22, 13, 16, 23, 34, 20, 50], true);
const sProfit = sheet(profit, [62, 24, 27, 27, 29, 29, 35, 34, 43, 42]);
for (let r = 2; r <= pricing.length; r++) {
  for (const col of [10, 11, 17, 21, 23]) fmtCol(sPricing, col, r, r, pctFmt);
  for (const col of [8, 9, 14, 15, 16, 19, 20]) fmtCol(sPricing, col, r, r, dollarFmt);
}
for (const col of [2, 5, 6, 7]) fmtCol(sPlan, col, 12, 11 + groups.size, col === 2 ? pctFmt : col === 5 || col === 6 || col === 7 ? dollarFmt : '0');
fmtCol(sProfit, 2, 5, 5, pctFmt);
for (const row of [6, 8, 9, 10, 11, 14, 15]) fmtCol(sProfit, 2, row, row, dollarFmt);
for (let r = firstScenario; r <= lastScenario; r++) {
  fmtCol(sProfit, 2, r, r, pctFmt);
  for (const col of [3, 4, 5, 6, 7, 8, 9, 10]) fmtCol(sProfit, col, r, r, dollarFmt);
  formula(sProfit, `D${r}`, `(1-B${r})*$B$10`, money((1 - profit[r - 1][1]) * newRevenue));
  formula(sProfit, `E${r}`, `(1-B${r})*$B$11`, money((1 - profit[r - 1][1]) * proxyCost));
  formula(sProfit, `G${r}`, `(D${r}-C${r})*(1-$B$5)+$B$11-E${r}`, profit[r - 1][6]);
  formula(sProfit, `H${r}`, `(D${r}-C${r})*(1-$B$5)`, profit[r - 1][7]);
  formula(sProfit, `I${r}`, `IF(ISNUMBER($B$7),$B$7+G${r},"Enter B7")`, 'Enter B7');
  formula(sProfit, `J${r}`, `IF(ISNUMBER($B$7),$B$7+H${r},"Enter B7")`, 'Enter B7');
}
for (let r = categoryStart; r < categoryStart + categoriesModel.size; r++) {
  formula(sProfit, `F${r}`, `(D${r}-C${r})*(1-$B$5)`, money((profit[r - 1][3] - profit[r - 1][2]) * (1 - defaultFee)));
  for (const col of [3, 4, 5, 6]) fmtCol(sProfit, col, r, r, dollarFmt);
}
XLSX.utils.book_append_sheet(book, sPlan, 'Plan & Agent Steps');
XLSX.utils.book_append_sheet(book, sPricing, 'Product Pricing');
XLSX.utils.book_append_sheet(book, sProfit, 'Profit Model');
await mkdir(path.dirname(output), { recursive: true });
XLSX.writeFile(book, output);
const check = XLSX.readFile(output);
assert.equal(check.SheetNames.length, 3);
assert.equal(XLSX.utils.sheet_to_json(check.Sheets['Product Pricing']).length, rows.length);
console.log(JSON.stringify({ output, generatedAt: new Date().toISOString(), salesPeriod: [from, through],
  packageRows: rows.length, productCount: new Set(rows.map(r => r.productId)).size,
  tiers: Object.fromEntries([45, 60, 100].map(rate => [rate, rows.filter(r => r.target === rate / 100).length])),
  holds: rows.filter(r => r.status.startsWith('HOLD')).length,
  actualAffectedRevenue: money(actualAffectedRevenue), oldReplayRevenue: money(oldRevenue),
  newReplayRevenue: money(newRevenue), sameVolumeNetProfitChangeAfter3PctFee: money((newRevenue - oldRevenue) * (1 - defaultFee)),
  visibleOnlyNetChangeAfter3PctFee: money((visibleNewRevenue - visibleOldRevenue) * (1 - defaultFee)),
  excluded }, null, 2));
if (!snapshotPath) await getPool().end();
