import test from 'node:test';
import assert from 'node:assert/strict';
import { merchandiseProductSummary, merchandiseSaveInput, merchandiseQuickApproval } from './merchandiseAdminView.js';

const product = () => ({ id: 7, version: 12, vendorId: 3153, active: false, artworkReviewed: false, currency: null,
  variants: [
    { id: 1, canSell: true, enabled: false, retailCents: null, proposedRetailCents: 1400, sellingPriceCents: 1400 },
    { id: 2, canSell: false, enabled: true, retailCents: 1800, proposedRetailCents: 1600, sellingPriceCents: 1800 },
    { id: 3, canSell: true, enabled: false, retailCents: 2400, proposedRetailCents: 2100, sellingPriceCents: 2400 }
  ] });

test('one click approves artwork and USD, lists all available variants and preserves intentional price overrides', () => {
  const p = product();
  const saved = merchandiseQuickApproval(p);
  assert.equal(saved.version, 12);
  assert.equal(saved.vendorId, 3153);
  assert.equal(saved.active, true);
  assert.equal(saved.artworkReviewed, true);
  assert.equal(saved.currency, 'USD');
  assert.deepEqual(saved.variants, [
    { id: 1, enabled: true, retailCents: null },
    { id: 2, enabled: false, retailCents: 1800 },
    { id: 3, enabled: true, retailCents: 2400 }
  ]);
  assert.equal(p.active, false);
  assert.equal(p.variants[1].enabled, true);
});

test('unavailable products are disabled even when a stale saved listing or variant flag remains enabled', () => {
  const p = product();
  p.active = true; p.artworkReviewed = true; p.currency = 'USD';
  p.variants = p.variants.map(variant => ({ ...variant, canSell: false, enabled: true }));
  const summary = merchandiseProductSummary(p);
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.listed, false);
  assert.equal(summary.available, 0);
  assert.equal(summary.selling, 0);
  assert.equal(summary.priceRange, null);
  assert.throws(() => merchandiseQuickApproval(p), /No available/);
  assert.equal(merchandiseSaveInput(p).active, false);
});

test('missing valid prices hold quick approval and only confirmed available selections count as listed', () => {
  const p = product();
  p.active = true; p.artworkReviewed = true; p.currency = 'USD';
  p.variants[0].enabled = true;
  let summary = merchandiseProductSummary(p);
  assert.equal(summary.status, 'listed');
  assert.equal(summary.allSelling, false);
  assert.deepEqual(summary.priceRange, [1400, 1400]);
  assert.deepEqual(summary.defaultRange, [1400, 2100]);
  assert.equal(summary.modified, 1);
  p.variants[2].sellingPriceCents = null;
  assert.throws(() => merchandiseQuickApproval(p), /Review prices/);
  p.currency = null;
  assert.equal(merchandiseProductSummary(p).listed, false);
});

test('popup price edits are explicit; clearing an override restores the default without changing other prices or selections', () => {
  const p = product();
  const saved = merchandiseSaveInput(p, { 1: '15.75', 3: '  ' });
  assert.deepEqual(saved.variants, [
    { id: 1, enabled: false, retailCents: 1575 },
    { id: 2, enabled: true, retailCents: 1800 },
    { id: 3, enabled: false, retailCents: null }
  ]);
  for (const value of ['1.001', '-1', 'NaN', '0', '100000.01']) {
    assert.throws(() => merchandiseSaveInput(p, { 1: value }), /prices/);
  }
});
