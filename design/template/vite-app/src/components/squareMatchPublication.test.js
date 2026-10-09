import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRetailPriceForMatch, squareMatchPriceIssue, newSquareMatchPublication, publishSquareMatch, squareMatchChoices } from './squareMatchPublication.js';

const candidate = { squareItemId: 'I', squareVariationId: 'V', pricingType: 'FIXED_PRICING', priceAmount: 2150, currency: 'USD' };
const row = { productId: 1, packageId: 2, productName: 'Lamb Neck Slices', csaRetailPrice: { amount: 1550, regularAmount: 1550, currency: 'USD', unit: 'lb' } };
const action = { id: 30, productId: 1, packageId: 2, kind: 'price', status: 'changed', mapping: { squareItemId: 'I', squareVariationId: 'V' }, display: { current: { price: 21.5, currency: 'USD' }, proposed: { price: 15.5, currency: 'USD' } } };
const done = { id: 40, status: 'completed', actions: [{ id: 30, status: 'completed' }] };

function harness(options = {}) {
  const posts = [], gets = [], checkpoints = [];
  const deps = {
    wait: async () => {}, checkpoint: s => checkpoints.push(structuredClone(s)),
    get: async path => {
      gets.push(path);
      if (path === 'product-sync/audits/20') return { id: 20, status: 'completed' };
      if (path.includes('/actions?')) return { rows: [{ ...action, id: 99, packageId: 999 }, options.action || action] };
      if (path.endsWith('/release')) return options.existingRelease || null;
      if (path.endsWith('/progress')) return options.progress || done;
      throw new Error('Unexpected GET: ' + path);
    },
    post: async (path, body) => {
      posts.push({ path, body });
      if (path === 'square/matches/approve') return { ok: true };
      if (path === 'product-sync/audits') return { id: 20, status: 'running' };
      if (path === 'product-sync/releases') {
        if (options.loseReleaseResponse) throw new Error('Connection lost');
        return { id: 40, status: 'queued', actions: [{ id: 30, status: 'pending' }] };
      }
      if (path.endsWith('/retry')) return { id: 40, status: 'queued', actions: [{ id: 30, status: 'pending' }] };
      throw new Error('Unexpected POST: ' + path);
    }
  };
  return { deps, posts, gets, checkpoints };
}

test('one link action publishes only the selected package through a persisted audit and waits for confirmation', async () => {
  const h = harness();
  const result = await publishSquareMatch(newSquareMatchPublication(row, candidate), h.deps);
  assert.equal(result.phase, 'Completed');
  assert.deepEqual(h.posts.map(p => p.path), ['square/matches/approve', 'product-sync/audits', 'product-sync/releases']);
  assert.deepEqual(h.posts[1].body.productIds, [1]);
  assert.deepEqual(h.posts[1].body.platforms, ['square']);
  assert.deepEqual(h.posts[2].body.actionIds, [30]);
  assert.equal(h.posts[2].body.background, true);
  assert.equal(Object.hasOwn(h.posts[2].body, 'payload'), false);
  assert(h.gets.includes('product-sync/releases/40/progress'));
  assert(h.checkpoints.some(s => s.releaseId === 40));
});

test('local price, Square price, currency, or selected mapping drift stops before publication', async () => {
  for (const replacement of [
    { ...action, display: { ...action.display, proposed: { price: 16, currency: 'USD' } } },
    { ...action, display: { ...action.display, current: { price: 22, currency: 'USD' } } },
    { ...action, display: { ...action.display, proposed: { price: 15.5, currency: 'CAD' } } },
    { ...action, mapping: { squareItemId: 'I', squareVariationId: 'OTHER' } }
  ]) {
    const h = harness({ action: replacement });
    await assert.rejects(publishSquareMatch(newSquareMatchPublication(row, candidate), h.deps), e => e.needsReview);
    assert(!h.posts.some(p => p.path === 'product-sync/releases'));
  }
});

test('already matching Square price confirms the link without a redundant remote update', async () => {
  const h = harness({ action: { ...action, status: 'synced', display: { current: { price: 15.5, currency: 'USD' }, proposed: action.display.proposed } } });
  const result = await publishSquareMatch(newSquareMatchPublication(row, candidate), h.deps);
  assert(result.alreadyMatched);
  assert(!h.posts.some(p => p.path === 'product-sync/releases'));
});

test('a lost release response recovers the existing release instead of approving or publishing again', async () => {
  const h = harness({ loseReleaseResponse: true });
  await assert.rejects(publishSquareMatch(newSquareMatchPublication(row, candidate), h.deps), /Connection lost/);
  const saved = h.checkpoints.at(-1);
  assert.equal(saved.actionId, 30);
  const retry = harness({ existingRelease: done });
  const result = await publishSquareMatch(saved, retry.deps);
  assert.equal(result.releaseId, 40);
  assert.deepEqual(retry.posts, []);
});

test('a failed release retries its saved ID, while held releases remain available for review', async () => {
  const saved = { ...newSquareMatchPublication(row, candidate), linked: true, auditId: 20, actionId: 30, releaseId: 40 };
  let reads = 0;
  const h = harness();
  h.deps.get = async () => ++reads === 1 ? { id: 40, status: 'failed', actions: [{ id: 30, status: 'failed' }] } : done;
  await publishSquareMatch(saved, h.deps);
  assert.deepEqual(h.posts.map(p => p.path), ['product-sync/releases/40/retry']);
  const held = harness({ progress: { id: 40, status: 'held', actions: [{ id: 30, status: 'held', message: 'Local price changed.' }] } });
  await assert.rejects(publishSquareMatch(saved, held.deps), /Local price changed/);
  assert.equal(held.posts.length, 0);
});

test('linked variation remains a choice even if a different suggestion scores higher', () => {
  const linked = { ...candidate, squareVariationId: 'APPROVED', matchScore: .2 };
  const choices = squareMatchChoices({ linked, candidates: [candidate] });
  assert.equal(choices[0].squareVariationId, 'APPROVED');
  assert.equal(choices[1].squareVariationId, 'V');
});

test('missing prices, variable prices, and mismatched currencies cannot start publication', () => {
  assert.throws(() => newSquareMatchPublication({ ...row, csaRetailPrice: { amount: null } }, candidate), /missing/);
  assert.throws(() => newSquareMatchPublication(row, { ...candidate, pricingType: 'VARIABLE_PRICING' }), /fixed price/);
  assert.throws(() => newSquareMatchPublication(row, { ...candidate, currency: 'CAD' }), /currencies differ/);
});

test('a stale API response reports missing retail data, not a currency or saved-price error', () => {
  const stale = { ...row, csaRetailPrice: undefined, guestPrice: 18.08, memberPrice: 18.08, price: 10.91 };
  assert.equal(localRetailPriceForMatch(stale), null);
  assert.match(squareMatchPriceIssue(stale, candidate), /server has not returned the local retail price/);
  assert.throws(() => newSquareMatchPublication(stale, candidate), /API has restarted/);
  assert.equal(squareMatchPriceIssue({ ...stale, localRetailPrice: row.csaRetailPrice }, candidate), '');
  assert.equal(newSquareMatchPublication({ ...stale, localRetailPrice: row.csaRetailPrice }, candidate).expectedProposedAmount, 1550);
});

test('an explicitly cancelled release can be cleared for a new price review without publishing', async () => {
  const saved = { ...newSquareMatchPublication(row, candidate), linked: true, auditId: 20, actionId: 30, releaseId: 40 };
  const h = harness({ progress: { id: 40, status: 'cancelled', actions: [{ id: 30, status: 'cancelled' }] } });
  await assert.rejects(publishSquareMatch(saved, h.deps), e => e.needsReview && /cancelled/.test(e.message));
  assert.deepEqual(h.posts, []);
});
