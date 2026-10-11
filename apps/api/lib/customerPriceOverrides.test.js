import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCustomerPriceOverrides, customerOverridePrice, assertProductWideSaleAllowed } from './customerPriceOverrides.js';
import { computeProductPricingSnapshot } from './productPricing.js';
import { buildLocalLinePricePayload, stageLocalLineContext } from '../localLine.js';
import { localLineInputs, localLineProjection } from './productSyncAdapters.js';
import { saveCustomerPriceOverrides } from './customerPriceOverrideSave.js';

const settings = [
  { packageId: 30, priceListId: 3124, adjustment: true, adjustmentType: 2, adjustmentValue: 40, onSale: true, strikethrough: 5.03 },
  { packageId: 30, priceListId: 2966, adjustment: true, adjustmentType: 2, adjustmentValue: 40, onSale: true, strikethrough: 4.52 }
];
const context = { product: { id: 10, name: 'Paste Tomatoes', vendorId: 20 }, vendor: { id: 20, name: "Grazier's Garden", priceListMarkup: .4 },
  packages: [{ id: 30, name: 'lb', price: 2.5, visible: 1 }], packageMeta: [], imageUrls: [], localLineVendorId: 20,
  profile: { markupOverride: .45, customerPriceOverridesJson: JSON.stringify(settings), onSale: 0 }, sale: { onSale: 0 } };
function withLists(fn) {
  const values = { LL_PRICE_LIST_GUEST_ID: '3124', LL_PRICE_LIST_HERDSHARE_ID: '2966', LL_PRICE_LIST_CSA_MEMBERS_ID: '2718', LL_PRICE_LIST_SNAP_ID: '5622' };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]])); Object.assign(process.env, values);
  try { return fn(); } finally { for (const [k,v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v; }
}
test('independent customer sale prices override 45%, retain distinct strikes, and leave other groups alone', () => withLists(() => {
  const snapshot = computeProductPricingSnapshot(context);
  assert.equal(snapshot.guestPrice, 3.5); assert.equal(snapshot.herdSharePrice, 3.5);
  assert.equal(snapshot.guestRegularPrice, 5.03); assert.equal(snapshot.herdShareRegularPrice, 4.52);
  assert.equal(snapshot.memberPrice, 3.63); assert.equal(snapshot.snapPrice, 3.63);
  assert.equal(snapshot.customerPrices.guest.onSale, true);
  assert.equal(snapshot.profile.markupOverride, .45); assert.equal(snapshot.profile.onSale, false);
}));
test('mixed sale flags and unusual crossed-out prices are preserved exactly', () => withLists(() => {
  const rows = settings.map(row => ({ ...row, onSale: row.priceListId === 2966, strikethrough: row.priceListId === 2966 ? 5.32 : null }));
  const snapshot = computeProductPricingSnapshot({ ...context, packages: [{ ...context.packages[0], price: 4 }], profile: { ...context.profile, customerPriceOverridesJson: JSON.stringify(rows) } });
  assert.equal(snapshot.guestPrice, 5.6); assert.equal(snapshot.herdSharePrice, 5.6);
  assert.equal(snapshot.customerPrices.guest.onSale, false); assert.equal(snapshot.customerPrices.herdShare.onSale, true);
  assert.equal(snapshot.customerPrices.herdShare.strikethrough, 5.32);
}));
test('payload preserves exact writable pricing inputs and audits detect settings changes', () => withLists(() => {
  const remote = { vendor: 20, packages: [{ id: 30, name: 'lb', unit_price: 2.5, inventory_per_unit: 1, price_list_entries: settings.map((s,i) => ({ price_list_id: s.priceListId, product_price_list_entry: 40+i, adjustment: s.adjustment, adjustment_type: s.adjustmentType, adjustment_value: s.adjustmentValue, on_sale_toggle: s.onSale, strikethrough_display_value: s.strikethrough, max_units_per_order: 2 })) }] };
  const payload = buildLocalLinePricePayload(context, remote);
  for (const e of payload.packages[0].price_list_entries) { assert.equal(e.adjustment_value, 40); assert.equal(e.on_sale_toggle, true); assert.equal(e.max_units_per_order, 2); }
  assert.deepEqual(localLineProjection(remote.packages[0], payload.packages[0]), localLineProjection(payload.packages[0], payload.packages[0], true));
  const baseline = localLineInputs(context);
  assert.deepEqual(baseline.profile.customerPriceOverrides, normalizeCustomerPriceOverrides(settings));
  assert.notDeepEqual(localLineInputs({ ...context, profile: { ...context.profile, customerPriceOverridesJson: null } }), baseline);
  assert.throws(() => stageLocalLineContext(context, { onSale: 0 }), /customer-group/);
  assert.throws(() => buildLocalLinePricePayload(context, remote, { saleDiscount: .1 }), /customer-group/);
  assert.doesNotThrow(() => stageLocalLineContext(context, { visible: 0 }));
  assert.throws(() => buildLocalLinePricePayload(context, { packages: [{id:30,price_list_entries:[]}] }), /no existing Local Line listing/);
}));
test('formula vendors and deposits ignore stored customer settings', () => withLists(() => {
  for (const vendorName of ['Deck Family Farm', 'Hyland', 'Creamy Cow']) {
    const input = { ...context, vendor: { ...context.vendor, name: vendorName } };
    const withOverride = computeProductPricingSnapshot(input), without = computeProductPricingSnapshot({ ...input, profile: { ...context.profile, customerPriceOverridesJson: null } });
    assert.deepEqual(withOverride, without);
  }
  const deposit = computeProductPricingSnapshot({ ...context, product: { ...context.product, name: 'Jar Deposit' } });
  assert.equal(deposit.guestPrice, 2.5); assert.deepEqual(deposit.profile.customerPriceOverrides, []);
}));
test('invalid, duplicate and negative-price settings fail; fixed and dollar adjustments work', () => {
  for (const rows of ['bad json', {}, [settings[0], settings[0]], [{ ...settings[0], onSale: 'false' }], [{ ...settings[0], priceListId: 0 }], [{ ...settings[0], adjustmentValue: '' }], [{ ...settings[0], adjustmentValue: -101 }]]) assert.throws(() => normalizeCustomerPriceOverrides(rows));
  assert.equal(customerOverridePrice(2.5, { ...settings[0], adjustmentType: 3, adjustmentValue: 1.99 }).final, 1.99);
  assert.equal(customerOverridePrice(2.5, { ...settings[0], adjustmentType: 1, adjustmentValue: -.5 }).final, 2);
  assert.throws(() => customerOverridePrice(2.5, { ...settings[0], adjustmentType: 1, adjustmentValue: -3 }));
  assert.doesNotThrow(() => assertProductWideSaleAllowed({}, { onSale: 1 }));
});

function fakePool({ vendorName = context.vendor.name, packageId = 30, fail = false } = {}) {
  const calls = [], connection = { beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
    query: async (sql, params) => {
      calls.push({sql,params});
      if (sql.includes('FROM products p')) return [[{ ...context.product, categoryName: 'Produce' }]];
      if (sql.includes('FROM vendors')) return [[{ ...context.vendor, name: vendorName }]];
      if (sql.includes('FROM packages')) return [[{ id: packageId, price: 2.5 }]];
      if (sql.includes('FROM product_sales')) return [[{ on_sale: 0, sale_discount: null }]];
      if (sql.startsWith('INSERT')) { if (fail) throw new Error('Write failed'); return [{affectedRows:1}]; }
      assert.fail(sql);
    } };
  return { calls, getConnection: async () => connection };
}
test('local save scopes package/list IDs, preserves formula and global sale fields, and rolls back errors', async () => {
  const old = process.env.LL_PRICE_LIST_GUEST_ID, oldHerd = process.env.LL_PRICE_LIST_HERDSHARE_ID;
  process.env.LL_PRICE_LIST_GUEST_ID = '3124'; process.env.LL_PRICE_LIST_HERDSHARE_ID = '2966';
  try {
    const pool = fakePool(); await saveCustomerPriceOverrides(pool, 10, settings);
    const write = pool.calls.find(c => c.sql?.startsWith('INSERT'));
    assert.deepEqual(JSON.parse(write.params[1]), normalizeCustomerPriceOverrides(settings));
    assert.doesNotMatch(write.sql.split('ON DUPLICATE KEY UPDATE')[1], /markup_override=|source_unit_price=|on_sale=|sale_discount=/);
    assert.deepEqual(pool.calls.slice(-2), ['commit','release']);
    for (const options of [{vendorName:'Hyland'}, {packageId:31}, {fail:true}]) { const pool = fakePool(options); await assert.rejects(saveCustomerPriceOverrides(pool,10,settings)); assert.deepEqual(pool.calls.slice(-2), ['rollback','release']); }
    await assert.rejects(saveCustomerPriceOverrides(fakePool(),10,[{...settings[0],priceListId:9999}]));
  } finally { old === undefined ? delete process.env.LL_PRICE_LIST_GUEST_ID : process.env.LL_PRICE_LIST_GUEST_ID=old; oldHerd === undefined ? delete process.env.LL_PRICE_LIST_HERDSHARE_ID : process.env.LL_PRICE_LIST_HERDSHARE_ID=oldHerd; }
});
