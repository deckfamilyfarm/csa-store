import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterReviewRows, selectedReviewRows, reviewState, canPublishReview, reviewPriceSummary, reviewWarnings, publishReviewedRevision } from './enterpriseReviewTable.js';
const product = (id = 1) => ({ id, productId: id, productName: 'Deodorant', vendorName: 'Granny Smith', status: 'approved', input: { squareEnabled: true },
  check: { auditId: 10, status: 'completed', actions: [{ id: 100, platform: 'localline', status: 'changed' }, { id: 101, platform: 'square', status: 'synced' }] } });
test('select all is limited to filtered current revisions, including matches beyond the former 250-row cap', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ ...product(i + 1), vendorName: i < 290 ? 'Other' : 'Granny Smith' }));
  const filtered = filterReviewRows(rows, { vendor: 'Granny Smith', search: 'deodorant', status: 'ready' });
  assert.equal(filtered.length, 10);
  assert.equal(selectedReviewRows(filtered, rows.map(r => r.id)).length, 10);
  assert.deepEqual(selectedReviewRows(filtered, [1, 999]), []);
});
test('all destinations must be checked and ready; blocked and partial products are not publishable', () => {
  const row = product(); assert.equal(reviewState(row), 'ready');
  row.check.actions.pop(); assert.equal(reviewState(row), 'unchecked');
  row.input.squareEnabled = false; assert.equal(reviewState(row), 'ready');
  row.check.actions[0].status = 'blocked'; assert.equal(reviewState(row), 'attention');
  row.check.actions[0].message = 'Missing CSA Members basket'; assert.deepEqual(reviewWarnings(row), ['Missing CSA Members basket']);
  row.check.actions[0] = { ...row.check.actions[0], status: 'changed', released: true, publicationStatus: 'partial' };
  assert.equal(reviewState(row), 'attention');
  row.check.actions[0].publicationStatus = 'running'; assert.equal(reviewState(row), 'publishing');
  row.check.actions[0].publicationStatus = 'completed'; row.check.actions[0].releaseStatus = 'completed';
  assert.equal(reviewState(row), 'synced');
});
test('publication needs publisher and every applicable push grant', () => {
  assert.equal(canPublishReview(product(), ['pricing_editor', 'localline_push', 'square_push']), false);
  assert.equal(canPublishReview(product(), ['pricing_publisher', 'localline_push']), false);
  assert.equal(canPublishReview(product(), ['pricing_publisher', 'localline_push', 'square_push']), true);
});
test('live audit prices take precedence and unknown prices are not displayed as zero', () => {
  const row = product(); row.comparison = [{ destination: 'Local Line', currentCents: 1120, localCents: 1680 }];
  row.check.actions[0].display = { pricingComparison: [{ destination: 'Local Line', currentCents: 1500, localCents: 1680 }] };
  assert.equal(reviewPriceSummary(row, 'Local Line', 'currentCents'), '$15.00');
  row.check.actions[0].releaseStatus = 'completed';
  assert.equal(reviewPriceSummary(row, 'Local Line', 'currentCents'), '$16.80');
  delete row.check.actions[0].releaseStatus;
  row.check.actions[0].display.pricingComparison[0].currentCents = null;
  assert.equal(reviewPriceSummary(row, 'Local Line', 'currentCents'), 'Needs check');
});
test('publish includes changed and synced actions in the same coordinated release', async () => {
  const calls = []; await publishReviewedRevision(product(), { get: async () => null, post: async (path, body) => { calls.push({ path, body }); return { id: 50 }; } });
  assert.deepEqual(calls[0].body.actionIds, [100, 101]); assert.equal(calls[0].body.background, true);
});
test('lost publication responses recover the same release; retries never duplicate it', async () => {
  let reads = 0, writes = 0;
  const dependencies = { get: async () => ++reads > 1 ? { id: 50, status: 'running' } : null,
    post: async () => { writes++; throw Error('Response lost'); } };
  assert.equal((await publishReviewedRevision(product(), dependencies)).id, 50);
  assert.equal((await publishReviewedRevision(product(), dependencies)).id, 50);
  assert.equal(writes, 1);
});
test('failed receipt lookup or incomplete check prevents any release submission', async () => {
  let writes = 0;
  const deps = { get: async () => { throw Error('Offline'); }, post: async () => writes++ };
  await assert.rejects(publishReviewedRevision(product(), deps), /Offline/);
  const row = product(); row.check.status = 'partial';
  await assert.rejects(publishReviewedRevision(row, deps), /Check and review/);
  assert.equal(writes, 0);
});
