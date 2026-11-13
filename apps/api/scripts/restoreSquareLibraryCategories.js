// One-time recovery authorized 2026-11-13. Preview before --apply.
// Use the catalog from before deletion for category assignments only; preserve
// every current item/variation field and version. Never replay old item bodies.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fetchSquare, listSquareCatalogItems, getSquareConfig } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';
import { squareObjectAtLocation } from '../lib/squareItemLocations.js';

const directory = new URL('../../../.local-pricing/square-category-restore-2026-11-13/', import.meta.url);
const receiptFile = new URL('receipt.json', directory);
const targetHash = fingerprint(getSquareConfig());
const supplemental = new Map([
  ['JLKTUM5MXH7F3JTHB7K4VBJC', 'Scandifest'],
  ['X5UX2PTIWGXDQ3S5U3MORXZT', 'FFCSA'],
  ['SQ6ANRDASE5UMIAPXJDLXK7R', 'FFCSA'],
  ['R7R5YLMIBYYUXAQH5I55WE5N', 'FFCSA'],
  ['WXM5MVVZNSSOZIQHHDQMWAK6', 'Roasters & Turkeys'],
  ['XHEH6EXU5CSKY4V3FLUWA4PN', 'FFCSA'],
  ['52GV4CMWOZSDWW7VC3Z6573X', 'FFCSA'],
  ['LEVEFO7MFXRUONIC3I7H3HFE', 'Hyland Processing']
]);
const read = name => fs.readFile(new URL(name, directory), 'utf8').then(JSON.parse);
async function save(plan) {
  const temp = new URL('receipt.next.json', directory);
  await fs.writeFile(temp, JSON.stringify(plan, null, 2) + '\n');
  await fs.rename(temp, receiptFile);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['version', 'created_at', 'updated_at'].includes(key))
    .map(([key, entry]) => [key, stable(entry)]));
}
function unrelated(item) {
  const result = stable(item);
  for (const key of ['categories', 'category_id', 'reporting_category']) delete result.item_data[key];
  return result;
}
async function liveCategories() {
  const objects = []; let cursor;
  do {
    const params = new URLSearchParams({ types: 'CATEGORY' });
    if (cursor) params.set('cursor', cursor);
    const response = await fetchSquare('/v2/catalog/list?' + params);
    objects.push(...(response.objects || [])); cursor = response.cursor;
  } while (cursor);
  return objects.filter(row => !row.is_deleted);
}
let plan;
try { plan = await read('receipt.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  assert(!process.argv.includes('--apply'), 'Generate the preview first.');
  const history = await read('historical.json');
  const [items, existingCategories] = await Promise.all([listSquareCatalogItems(), liveCategories()]);
  const oldCategories = history.filter(row => row.type === 'CATEGORY' && !row.is_deleted);
  assert(oldCategories.every(row => row.category_data.category_type === 'REGULAR_CATEGORY' && !row.category_data.parent_category?.id), 'Unexpected category hierarchy.');
  const aliases = new Map(oldCategories.map(row => [row.id, '#restore-' + row.id]));
  const categories = oldCategories.map(row => {
    assert(!existingCategories.some(existing => existing.category_data.name === row.category_data.name), 'Category already exists; review mapping.');
    const category_data = { name: row.category_data.name, category_type: 'REGULAR_CATEGORY' };
    // Let Square assign fresh display ordinals: the new Test category now
    // occupies an ordinal previously used by a deleted category.
    for (const key of ['abbreviation', 'label_color']) {
      if (row.category_data[key] !== undefined) category_data[key] = structuredClone(row.category_data[key]);
    }
    return { type: 'CATEGORY', id: aliases.get(row.id), present_at_all_locations: true, category_data };
  });
  const remap = ref => {
    assert(aliases.has(ref.id), 'Historical category missing: ' + ref.id);
    return { ...ref, id: aliases.get(ref.id) };
  };
  const actions = items.filter(row => !row.is_deleted && !row.item_data.is_archived).map(before => {
    const old = history.find(row => row.type === 'ITEM' && row.id === before.id);
    assert(old, 'No historical identity for ' + before.id);
    let refs = structuredClone(old.item_data.categories || []);
    if (old.item_data.category_id && !refs.some(ref => ref.id === old.item_data.category_id)) refs.push({ id: old.item_data.category_id });
    if (!refs.length) {
      const category = oldCategories.find(row => row.category_data.name === supplemental.get(before.id));
      assert(category, 'No approved category for ' + before.item_data.name);
      refs = [{ id: category.id }];
    }
    const after = structuredClone(before);
    after.item_data.categories = [...(after.item_data.categories || []), ...refs.map(remap)];
    if (!after.item_data.reporting_category) after.item_data.reporting_category = remap(old.item_data.reporting_category || refs[0]);
    assert(same(unrelated(after), unrelated(before)), 'Unrelated fields changed in preparation.');
    return { id: before.id, name: before.item_data.name, categoryNames: refs.map(ref => oldCategories.find(row => row.id === ref.id).category_data.name), before, after };
  });
  assert.equal(actions.length, 132, 'Unexpected active item count; review catalog.');
  plan = { createdAt: new Date().toISOString(), historicalAt: '2026-11-13T08:00:00Z', targetHash, status: 'prepared',
    existingCategories, categories, actions,
    request: { idempotency_key: crypto.randomUUID(), batches: [{ objects: [...categories, ...actions.map(row => row.after)] }] } };
  await save(plan);
}
assert.equal(plan.targetHash, targetHash, 'Square configuration changed.');
if (process.argv.includes('--apply') || process.argv.includes('--verify')) {
  if (plan.status === 'prepared' && process.argv.includes('--apply')) {
    const [current, categories] = await Promise.all([listSquareCatalogItems(), liveCategories()]);
    assert(same(categories, plan.existingCategories), 'Categories changed after preview; review before publishing.');
    for (const action of plan.actions) {
      assert(same(current.find(item => item.id === action.id), action.before), action.name + ': item changed after preview.');
    }
    plan.status = 'sending'; await save(plan);
    // Exact body/key remain durable if the response is lost. Hold rather than
    // construct another request. --verify can confirm via saved ID mappings.
    try {
      plan.response = await fetchSquare('/v2/catalog/batch-upsert', { method: 'POST', body: JSON.stringify(plan.request), signal: AbortSignal.timeout(60000) });
    } catch (error) {
      plan.status = error.remoteRejected ? 'rejected' : 'uncertain';
      plan.error = error.message; await save(plan); throw error;
    }
    plan.status = plan.response.errors?.length ? 'held' : 'responded'; await save(plan);
    assert(!plan.response.errors?.length, JSON.stringify(plan.response.errors));
  }
  assert(plan.response?.id_mappings, 'No confirmed response; inspect the held request before recovery.');
  const ids = new Map(plan.response.id_mappings.map(row => [row.client_object_id, row.object_id]));
  const [items, categories, locationResponse] = await Promise.all([listSquareCatalogItems(), liveCategories(), fetchSquare('/v2/locations')]);
  const resolve = ref => ({ ...ref, id: ids.get(ref.id) || ref.id });
  const verified = [];
  for (const action of plan.actions) {
    const current = items.find(row => row.id === action.id);
    assert(current && !current.is_deleted && !current.item_data.is_archived, 'Missing active item: ' + action.name);
    const expected = action.after.item_data.categories.map(resolve);
    assert(same(current.item_data.categories.map(row => row.id).sort(), expected.map(row => row.id).sort()), 'Category mismatch: ' + action.name);
    assert.equal(current.item_data.reporting_category?.id, resolve(action.after.item_data.reporting_category).id, 'Reporting category mismatch: ' + action.name);
    assert(same(unrelated(current), unrelated(action.before)), 'Other fields changed: ' + action.name);
    verified.push({ id: action.id, name: action.name, categories: current.item_data.categories.map(ref => categories.find(row => row.id === ref.id)?.category_data.name) });
  }
  for (const expected of plan.categories) {
    const current = categories.find(row => row.id === ids.get(expected.id));
    assert(current?.present_at_all_locations && current.category_data.name === expected.category_data.name, 'Category unavailable or incorrect.');
  }
  plan.status = 'confirmed'; plan.confirmedAt = new Date().toISOString();
  plan.verification = { products: verified, locations: locationResponse.locations.filter(row => row.status === 'ACTIVE').map(location => ({
    id: location.id, name: location.name,
    categorizedAvailableProducts: items.filter(item => !item.is_deleted && !item.item_data.is_archived && squareObjectAtLocation(item, location.id)
      && item.item_data.variations.some(variation => !variation.is_deleted && squareObjectAtLocation(variation, location.id)) && item.item_data.categories?.length).length
  })) };
  await save(plan);
}
console.log(JSON.stringify({ receipt: receiptFile.pathname, status: plan.status, categories: plan.categories.map(row => row.category_data.name), products: plan.actions.length, locations: plan.verification?.locations }, null, 2));
