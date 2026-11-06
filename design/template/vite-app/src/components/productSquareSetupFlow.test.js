import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadSquareSetup, canLinkSquare, canCreateSquare, squareSetupReady,
  previewProductSquareCreation, approveProductSquareLink, finishProductSquareCreation } from './productSquareSetupFlow.js';

function harness({ current = {}, setup = {}, creation = {} } = {}) {
  const posts = [];
  return { posts, args: { productId: 7, roles: ['admin'],
    get: async path => path.endsWith('/square-setup') ? { enabled: true, rows: [{ productId: 7, packageId: 70, linked: null }], ...setup }
      : { revisionId: 12, revisionStatus: 'active', input: { squareEnabled: true }, ...current },
    post: async (path, body) => { posts.push({ path, body }); return { productId: 7, id: 'saved-key', status: 'draft', ...creation }; }
  } };
}
test('pricing and channel grants remain separate for matching, creation and publication', () => {
  assert.equal(canReadSquareSetup(['pricing_editor']), false);
  assert.equal(canReadSquareSetup(['pricing_publisher', 'square_push']), true);
  assert.equal(canLinkSquare(['pricing_publisher', 'square_push']), false);
  assert.equal(canCreateSquare(['square_pull']), false);
  assert.equal(canCreateSquare(['square_push']), false);
  assert.equal(canCreateSquare(['square_pull', 'square_push']), true);
  assert.equal(canCreateSquare(['admin']), true);
});
test('creation previews use the current saved revision and require explicit final approval', async () => {
  const h = harness({ current: { revisionStatus: 'pending' } });
  assert.equal((await previewProductSquareCreation(h.args)).id, 'saved-key');
  assert.deepEqual(h.posts, [
    { path: 'enterprise-pricing/revisions/12/approve-channels', body: { platforms: ['square'] } },
    { path: 'square/products/preview', body: { productId: 7 } }
  ]);
  assert.ok(!h.posts.some(row => row.path.endsWith('/create')));
});
test('uncertain and completed creations recover the original receipt despite newer pending prices', async () => {
  for (const status of ['sending', 'created', 'completed']) {
    const creation = { id: 'original-key', productId: 7, status, variations: [{ amount: 1200 }] };
    const h = harness({ current: { revisionId: 99, revisionStatus: 'pending' }, setup: { creation } });
    assert.deepEqual(await previewProductSquareCreation(h.args), creation);
    assert.equal(h.posts.length, 0);
  }
});
test('isolated mode, missing pricing, disabled Square, existing links and missing approval rights hold new creation', async () => {
  for (const options of [
    { current: { localOnly: true } }, { current: { revisionId: null } },
    { current: { input: { squareEnabled: false } } }, { setup: { enabled: false } },
    { setup: { rows: [{ linked: { squareVariationId: 'already-linked' } }] } }
  ]) {
    const h = harness(options);
    await assert.rejects(previewProductSquareCreation(h.args));
    assert.equal(h.posts.length, 0);
  }
  const h = harness({ current: { revisionStatus: 'pending' } });
  await assert.rejects(previewProductSquareCreation({ ...h.args, roles: ['square_pull', 'square_push'] }), /Pricing Publisher/);
  assert.equal(h.posts.length, 0);
});
test('link approval is scoped to this package and never publishes a price or starts a legacy release', async () => {
  const h = harness();
  await approveProductSquareLink({ ...h.args, row: { productId: 7, packageId: 70 },
    candidate: { squareItemId: 'ITEM', squareVariationId: 'V', score: .9 } });
  assert.deepEqual(h.posts, [{ path: 'square/matches/approve', body: { productId: 7, packageId: 70,
    squareItemId: 'ITEM', squareVariationId: 'V', matchScore: .9 } }]);
  await assert.rejects(approveProductSquareLink({ ...h.args, row: { productId: 8, packageId: 80 }, candidate: {} }));
  assert.equal(h.posts.length, 1);
});
test('creation retries submit the exact frozen creation ID, while another product cannot be substituted', async () => {
  const h = harness();
  const creation = { id: 'original-key', productId: 7, status: 'sending' };
  await finishProductSquareCreation({ ...h.args, creation });
  await finishProductSquareCreation({ ...h.args, creation });
  assert.deepEqual(h.posts.map(row => row.path), ['square/products/original-key/create', 'square/products/original-key/create']);
  await assert.rejects(finishProductSquareCreation({ ...h.args, creation: { ...creation, productId: 8 } }));
  assert.equal(h.posts.length, 2);
});
test('Square sync readiness requires every local package to have an available remote variation', () => {
  const linked = { linked: { squareVariationId: 'V', pricingType: 'FIXED_PRICING' } };
  assert.equal(squareSetupReady({ enabled: true, rows: [linked] }), true);
  for (const setup of [null, { enabled: false, rows: [linked] }, { enabled: true, rows: [] },
    { enabled: true, rows: [linked, { linked: null }] }, { enabled: true, rows: [{ linked: { squareVariationId: 'deleted' } }] }])
    assert.equal(squareSetupReady(setup), false);
});
