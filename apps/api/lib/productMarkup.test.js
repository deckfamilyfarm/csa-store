import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProductMarkupOverride, saveProductMarkupOverride } from './productMarkup.js';
import { computeProductPricingSnapshot } from './productPricing.js';
import { buildLocalLinePricePayload } from '../localLine.js';
import { localLineInputs } from './productSyncAdapters.js';

const product = { id: 10, name: 'Hazelnuts', vendorId: 20 };
const vendor = { id: 20, name: 'Farmhands Co-Op', priceListMarkup: 0.4 };
const packages = [{ id: 30, name: 'bag', price: 10, visible: 1 }];
const snapshot = profile => computeProductPricingSnapshot({ product, vendor, packages, profile });

test('an explicit override changes only its product and all four customer lists', () => {
  const normal = snapshot({ memberMarkup: 0.45 });
  assert.equal(normal.memberPrice, 14);
  const override = snapshot({ markupOverride: '0.4500' });
  for (const key of ['guest', 'member', 'herdShare', 'snap']) {
    assert.equal(override.profile[`${key}Markup`], 0.45);
    assert.equal(override[`${key}Price`], 14.5);
  }
  assert.equal(snapshot(null).memberPrice, 14);
  assert.equal(snapshot({ markupOverride: 0 }).memberPrice, 10);
  assert.equal(snapshot({ markupOverride: null }).memberPrice, 14);
  assert.equal(snapshot({ markupOverride: 0.45, onSale: 1, saleDiscount: 0.1 }).memberPrice, 13.05);
});

test('excluded vendors and deposits keep their pricing even with a stored override', () => {
  for (const name of ['Deck Family Farm', 'Creamy Cow, LLC', "Deck Family Farm's Hyland Artisinal Meats"]) {
    const input = { product, vendor: { ...vendor, name }, packages, profile: { sourceUnitPrice: 10, sourceMultiplier: 1 } };
    const before = computeProductPricingSnapshot(input);
    const after = computeProductPricingSnapshot({ ...input, profile: { ...input.profile, markupOverride: 0.45 } });
    assert.deepEqual(after, before);
  }
  const deposit = computeProductPricingSnapshot({ product: { ...product, name: 'Jar Deposit' }, vendor, packages, profile: { markupOverride: 0.45 } });
  assert.equal(deposit.profile.markupOverride, null);
  assert.equal(deposit.memberPrice, 10);
});

test('invalid override input is rejected rather than silently clearing the default', () => {
  for (const value of [undefined, false, {}, [], NaN, Infinity, -0.01, 'no', ' ', 1000000]) {
    assert.throws(() => normalizeProductMarkupOverride(value));
  }
  assert.equal(normalizeProductMarkupOverride('0.45'), 0.45);
  assert.equal(normalizeProductMarkupOverride(null), null);
  assert.equal(normalizeProductMarkupOverride(''), null);
});

test('Local Line payload and audit baseline include the override while base price stays fixed', () => {
  const previous = process.env.LL_PRICE_LIST_GUEST_ID;
  process.env.LL_PRICE_LIST_GUEST_ID = '3124';
  try {
    const context = { product, vendor, packages, profile: { markupOverride: 0.45 }, localLineVendorId: 20, packageMeta: [], imageUrls: [] };
    const remote = { packages: [{ id: 30, price_list_entries: [{ price_list: 3124, product_price_list_entry: 40, adjustment_type: 2 }] }] };
    const payload = buildLocalLinePricePayload(context, remote);
    assert.equal(payload.vendor, 20);
    assert.equal(payload.packages[0].unit_price, 10);
    assert.equal(payload.packages[0].price_list_entries[0].adjustment_value, 45);
    assert.equal(payload.packages[0].price_list_entries[0].calculated_value, 14.5);
    assert.equal(localLineInputs(context).profile.markupOverride, 0.45);
    assert.equal(Object.hasOwn(localLineInputs({ ...context, profile: null }).profile, 'markupOverride'), false);
  } finally {
    if (previous === undefined) delete process.env.LL_PRICE_LIST_GUEST_ID;
    else process.env.LL_PRICE_LIST_GUEST_ID = previous;
  }
});

function fakePool({ name = vendor.name, productName = product.name, categoryName = 'Nuts', failWrite = false } = {}) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM products p')) return [[{ ...product, name: productName, categoryName }]];
      if (sql.includes('FROM vendors')) return [[{ ...vendor, name }]];
      if (sql.includes('FROM product_pricing_profiles')) return [[]];
      if (sql.includes('FROM product_sales')) return [[{ onSale: 1, saleDiscount: 0.1 }]];
      if (sql.includes('INSERT INTO product_pricing_profiles')) {
        if (failWrite) throw new Error('Write failed');
        return [{ affectedRows: 1 }];
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    }
  };
  return { calls, getConnection: async () => connection };
}

test('saving an override writes only the selected profile, preserves sales, and rolls back failures', async () => {
  const pool = fakePool();
  await saveProductMarkupOverride(pool, 10, 0.45);
  const writes = pool.calls.filter(call => call.sql?.startsWith('INSERT'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, [10, 0.45, 0.45, 0.45, 0.45, 0.45, 1, 0.1]);
  assert.doesNotMatch(writes[0].sql.split('ON DUPLICATE KEY UPDATE')[1], /on_sale=|sale_discount=|source_unit_price=/);
  assert.deepEqual(pool.calls.slice(-2), ['commit', 'release']);
  const failed = fakePool({ failWrite: true });
  await assert.rejects(saveProductMarkupOverride(failed, 10, 0.45), /Write failed/);
  assert.deepEqual(failed.calls.slice(-2), ['rollback', 'release']);
});

test('save rejects protected vendors, deposits, and Membership before any write', async () => {
  for (const options of [{ name: 'Deck Family Farm' }, { name: 'Creamy Cow' }, { name: 'Hyland' }, { productName: 'Deposit' }, { categoryName: 'Membership' }]) {
    const pool = fakePool(options);
    await assert.rejects(saveProductMarkupOverride(pool, 10, 0.45));
    assert.equal(pool.calls.some(call => call.sql?.startsWith('INSERT')), false);
    assert.deepEqual(pool.calls.slice(-2), ['rollback', 'release']);
  }
});
