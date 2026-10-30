import test from 'node:test';
import assert from 'node:assert/strict';
import { syncProductLocalLine, syncProductChannels, canSyncPlatforms, canSyncLocalLine, publicationMessage } from './productPricingSyncFlow.js';
const data = { revisionId: 12, revisionStatus: 'active' };
const action = { id: 7, platform: 'localline', productId: 1, status: 'changed' };
function harness({ actions = [action], receipt = null, releaseError = false } = {}) {
  const posts = [], saved = [], labels = [];
  let lookups = 0;
  return { posts, saved, labels, args: { productId: 1, data, saveJob: job => saved.push(job), progress: label => labels.push(label), wait: async () => {},
    get: async path => {
      if (path.endsWith('/release')) { lookups++; return typeof receipt === 'function' ? receipt(lookups) : receipt; }
      if (path.includes('/actions?')) return { rows: actions };
      if (path.endsWith('/progress')) return { id: 42, status: 'running' };
      return { id: 4, status: 'completed' };
    },
    post: async (path, body) => {
      posts.push({ path, body });
      if (path === 'product-sync/releases' && releaseError) throw new Error('Network lost');
      return path === 'product-sync/releases' ? { id: 42, status: 'queued' } : { id: 4 };
    } } };
}
test('one click freezes Local Line prices AND sale, then starts one background release', async () => {
  const h = harness();
  assert.equal((await syncProductLocalLine(h.args)).id, 42);
  assert.deepEqual(h.posts[0].body.platforms, ['localline']);
  assert.equal(h.posts[0].body.publicationScope, 'localline-prices-and-sales');
  assert.equal(h.posts[0].body.incoming, false);
  assert.deepEqual(h.posts[1].body.actionIds, [7]);
  assert.equal(h.posts[1].body.background, true);
  assert.equal(h.saved.at(-1).releaseId, 42);
});
test('pending pricing uses the authorized Local Line approval route', async () => {
  const h = harness();
  await syncProductLocalLine({ ...h.args, data: { ...data, revisionStatus: 'pending' } });
  assert.equal(h.posts[0].path, 'enterprise-pricing/revisions/12/approve-localline');
});
test('all already matching packages still receive a verified release receipt', async () => {
  const h = harness({ actions: [{ ...action, status: 'synced' }] });
  await syncProductLocalLine(h.args);
  assert.equal(h.posts.at(-1).path, 'product-sync/releases');
});
test('blocked package message appears directly and no publication is submitted', async () => {
  const h = harness({ actions: [{ ...action, status: 'blocked', message: 'Choose a vendor for Ground Pork.' }] });
  await assert.rejects(syncProductLocalLine(h.args), /Choose a vendor for Ground Pork/);
  assert.equal(h.posts.length, 1);
  assert.equal(h.saved.at(-1), null);
});
test('unexpected Square or another product cannot be included in publication', async () => {
  for (const extra of [{ ...action, platform: 'square' }, { ...action, productId: 2 }]) {
    const h = harness({ actions: [action, extra] });
    await assert.rejects(syncProductLocalLine(h.args));
    assert.equal(h.posts.length, 1);
  }
});
test('lost response recovers the original release', async () => {
  const h = harness({ releaseError: true, receipt: n => n === 1 ? null : { id: 42, status: 'running' } });
  assert.equal((await syncProductLocalLine(h.args)).id, 42);
  assert.equal(h.posts.filter(p => p.path === 'product-sync/releases').length, 1);
});
test('uncertain submission retains the audit; resume finds receipt without replacement', async () => {
  const h = harness({ releaseError: true });
  await assert.rejects(syncProductLocalLine(h.args), /Resume sync/);
  const next = harness({ receipt: { id: 42, status: 'queued' } });
  await syncProductLocalLine({ ...next.args, resume: h.saved.at(-1) });
  assert.equal(next.posts.length, 0);
});
test('receipt lookup failure never starts new publication', async () => {
  const h = harness();
  const get = h.args.get;
  await assert.rejects(syncProductLocalLine({ ...h.args, get: path => path.endsWith('/release') ? Promise.reject(new Error('Offline')) : get(path) }), /Offline/);
  assert.equal(h.posts.length, 1);
});
test('saved release resumes read-only, even after pricing changes', async () => {
  const h = harness();
  await syncProductLocalLine({ ...h.args, resume: { releaseId: 42, revisionId: 11 } });
  assert.equal(h.posts.length, 0);
});
test('isolated mode and unsupported sales cannot submit sync', async () => {
  for (const fields of [{ localOnly: true }, { syncBlocker: 'Scheduled sale needs review.' }]) {
    const h = harness();
    await assert.rejects(syncProductLocalLine({ ...h.args, data: { ...data, ...fields } }));
    assert.equal(h.posts.length, 0);
  }
});
test('publisher and push permissions remain separate from editing', () => {
  assert.equal(canSyncLocalLine(['pricing_editor', 'localline_push']), false);
  assert.equal(canSyncLocalLine(['pricing_publisher']), false);
  assert.equal(canSyncLocalLine(['pricing_publisher', 'localline_push']), true);
  assert.equal(canSyncLocalLine(['admin']), true);
});
test('progress describes the real server stage and preserves failure details', () => {
  assert.match(publicationMessage({ status: 'running', actions: [{status:'working',message:'Applying approved values.'}] }), /Updating prices and sale on Local Line/);
  assert.match(publicationMessage({ status: 'running', actions: [{status:'working',message:'Confirming the published values with the destination.'}] }), /Verifying/);
  assert.match(publicationMessage({ status: 'held', actions: [{status:'held',message:'Remote price changed since review.'}] }), /Remote price changed since review/);
});

test('Square-only and Both sync include exactly the selected destinations', async()=>{
  for(const platforms of [['square'],['localline','square']]) {
    const h=harness({actions:platforms.map((platform,i)=>({...action,id:7+i,platform}))});
    await syncProductChannels({...h.args,data:{...data,input:{squareEnabled:true}},platforms});
    assert.deepEqual(h.posts[0].body.platforms,platforms);
    assert.equal(h.posts[0].body.productEditorSync,true);
    assert.equal(h.posts[0].body.publicationScope,'enterprise-selected-prices');
    assert.equal(h.posts[1].body.actionIds.length,platforms.length);
  }
});
test('Both sync refuses partial checks; recovery cannot switch destinations', async()=>{
  const h=harness();
  await assert.rejects(syncProductChannels({...h.args,data:{...data,input:{squareEnabled:true}},platforms:['localline','square']}));
  assert.equal(h.posts.length,1);
  await assert.rejects(syncProductChannels({...h.args,data:{...data,input:{squareEnabled:true}},platforms:['square'],resume:{auditId:4,platforms:['localline']}}),/original destinations/);
});
test('Square eligibility and selected destination permissions are enforced',async()=>{
  const h=harness();
  await assert.rejects(syncProductChannels({...h.args,platforms:['square']}),/not enabled/);
  assert.equal(h.posts.length,0);
  assert.equal(canSyncPlatforms(['pricing_publisher','square_push'],['square']),true);
  assert.equal(canSyncPlatforms(['pricing_publisher','square_push'],['square','localline']),false);
});
