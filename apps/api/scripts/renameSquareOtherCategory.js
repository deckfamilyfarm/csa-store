// User-approved Square-only rename, 2026-11-13. Preview, then --apply.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fetchSquare, getSquareConfig, listSquareCatalogItems } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';

const directory = new URL('../../../.local-pricing/square-variety-other-2026-11-13/', import.meta.url);
const file = new URL('receipt.json', directory);
const targetHash = fingerprint(getSquareConfig());
const categoryId = 'FVL2C232OWWY5XYAOMYOUDQ7';
const category = async () => (await fetchSquare('/v2/catalog/object/' + categoryId)).object;
const members = async () => (await listSquareCatalogItems()).filter(item => !item.is_deleted && item.item_data.categories?.some(ref => ref.id === categoryId));
const save = async plan => {
  await fs.mkdir(directory, { recursive: true });
  const temp = new URL('receipt.next.json', directory);
  await fs.writeFile(temp, JSON.stringify(plan, null, 2) + '\n'); await fs.rename(temp, file);
};
let plan;
try { plan = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  assert(!process.argv.includes('--apply'), 'Prepare the preview first.');
  const [before, items] = await Promise.all([category(), members()]);
  assert.equal(before?.category_data?.name, 'Other'); assert(!before.is_deleted);
  const after = structuredClone(before); after.category_data.name = 'Variety & Other';
  plan = { targetHash, status: 'prepared', before, items, request: { idempotency_key: crypto.randomUUID(), object: after } };
  await save(plan);
}
assert.equal(targetHash, plan.targetHash, 'Square configuration changed.');
if (process.argv.includes('--apply')) {
  if (plan.status === 'prepared') {
    assert(same(await category(), plan.before), 'Category changed since preview.');
    plan.status = 'sending'; await save(plan);
    plan.response = await fetchSquare('/v2/catalog/object', { method: 'POST', body: JSON.stringify(plan.request), signal: AbortSignal.timeout(60000) });
    plan.status = 'responded'; await save(plan);
    assert(!plan.response.errors?.length, JSON.stringify(plan.response.errors));
  }
  // An uncertain request is checked by reading; never generate a replacement.
  const [confirmed, items] = await Promise.all([category(), members()]);
  const clean = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['updated_at', 'version'].includes(key)));
  assert(same(clean(confirmed), clean(plan.request.object)), 'Category verification failed.');
  assert(same(items.slice().sort((a,b)=>a.id.localeCompare(b.id)), plan.items.slice().sort((a,b)=>a.id.localeCompare(b.id))), 'Product membership or item fields changed; review.');
  plan.status = 'confirmed'; plan.confirmed = confirmed; plan.confirmedAt = new Date().toISOString(); await save(plan);
}
console.log(JSON.stringify({ status: plan.status, before: plan.before.category_data.name, after: plan.request.object.category_data.name, products: plan.items.length }, null, 2));
