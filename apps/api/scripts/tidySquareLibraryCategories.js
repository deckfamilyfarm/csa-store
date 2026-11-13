// User-requested category names, FFCSA/Scandifest merge and whole-turkey removal,
// 2026-11-13. Prepare without flags, inspect, then --apply. Receipts survive failure.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fetchSquare, getSquareConfig, listSquareCatalogItems } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';

const directory = new URL('../../../.local-pricing/square-library-cleanup-2026-11-13/', import.meta.url);
const file = new URL('receipt.json', directory);
const read = name => fs.readFile(new URL(name, directory), 'utf8').then(JSON.parse);
const targetHash = fingerprint(getSquareConfig());
async function save(plan) {
  const temp = new URL('receipt.next.json', directory);
  await fs.writeFile(temp, JSON.stringify(plan, null, 2) + '\n'); await fs.rename(temp, file);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['version', 'updated_at', 'created_at'].includes(key)).map(([key, entry]) => [key, stable(entry)]));
}
const refs = item => [...(item.item_data.categories || []).map(row => row.id), item.item_data.category_id, item.item_data.reporting_category?.id].filter(Boolean);
async function retrieve(ids) {
  const result = await fetchSquare('/v2/catalog/batch-retrieve', { method: 'POST', body: JSON.stringify({ object_ids: ids, include_deleted_objects: true }) });
  assert(!result.errors?.length, JSON.stringify(result.errors)); return result.objects || [];
}
let plan;
try { plan = await read('receipt.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  assert(!process.argv.includes('--apply'), 'Prepare the preview first.');
  const before = await read('before.json');
  const category = name => {
    const found = before.categories.filter(row => row.category_data.name === name);
    assert.equal(found.length, 1, 'Ambiguous category: ' + name); return found[0];
  };
  const renames = [['Beef, 100% grassfed', 'Grassfed Beef'], ['Eggs, Organic Layers', 'Eggs'],
    ['Fruits/Nuts Honey', 'Honey, Nuts, and Fruit'], ['Roasters & Turkeys', 'Roasters'], ['FFCSA', 'Other']];
  const changes = renames.map(([oldName, newName]) => {
    assert(!before.categories.some(row => row.category_data.name === newName), 'Destination category already exists.');
    const original = category(oldName), after = structuredClone(original); after.category_data.name = newName;
    return { before: original, after };
  });
  const source = category('Scandifest'), destination = category('FFCSA');
  for (const item of before.items.filter(item => refs(item).includes(source.id))) {
    const after = structuredClone(item);
    const remap = ref => ref.id === source.id ? { id: destination.id } : ref;
    after.item_data.categories = (after.item_data.categories || []).map(remap)
      .filter((ref, index, rows) => rows.findIndex(row => row.id === ref.id) === index);
    if (after.item_data.category_id === source.id) after.item_data.category_id = destination.id;
    if (after.item_data.reporting_category?.id === source.id) after.item_data.reporting_category = remap(after.item_data.reporting_category);
    changes.push({ before: item, after });
  }
  const turkey = before.items.find(item => item.id === 'WXM5MVVZNSSOZIQHHDQMWAK6');
  assert.equal(turkey?.item_data.name, 'Broad Breasted White Thanksgiving Turkeys, Medium');
  plan = { targetHash, preparedAt: new Date().toISOString(), status: 'prepared', renames, changes,
    request: { idempotency_key: crypto.randomUUID(), batches: [{ objects: changes.map(row => row.after) }] },
    deletions: [source, turkey].map(original => ({ before: original, status: 'prepared',
      expectedIds: [original.id, ...(original.item_data?.variations || []).map(row => row.id)] })) };
  await save(plan);
}
assert.equal(plan.targetHash, targetHash, 'Square configuration changed.');
if (process.argv.includes('--apply')) {
  if (plan.status === 'prepared') {
    const current = await retrieve([...plan.changes.map(row => row.before.id), ...plan.deletions.map(row => row.before.id)]);
    for (const action of [...plan.changes, ...plan.deletions]) assert(same(current.find(row => row.id === action.before.id), action.before), 'Live baseline changed: ' + action.before.id);
    plan.status = 'sending'; await save(plan);
    try {
      plan.response = await fetchSquare('/v2/catalog/batch-upsert', { method: 'POST', body: JSON.stringify(plan.request), signal: AbortSignal.timeout(60000) });
      plan.status = plan.response.errors?.length ? 'held' : 'updated'; await save(plan);
      assert(!plan.response.errors?.length, JSON.stringify(plan.response.errors));
    } catch (error) {
      plan.error = error.message; await save(plan); throw error;
    }
  }
  assert(['updated', 'confirmed'].includes(plan.status), 'Uncertain or rejected request: review the saved receipt before proceeding.');
  const updated = await retrieve(plan.changes.map(row => row.before.id));
  for (const action of plan.changes) {
    const current = updated.find(row => row.id === action.after.id);
    if (action.after.type === 'ITEM') {
      // Square assigns category ordinals when moving an item. Compare IDs and
      // every other field, excluding server-managed timestamps and versions.
      const clean = item => {
        const result = stable(item);
        result.item_data.categories = (result.item_data.categories || []).map(row => ({ id: row.id }));
        if (result.item_data.reporting_category) result.item_data.reporting_category = { id: result.item_data.reporting_category.id };
        return result;
      };
      assert(same(clean(current), clean(action.after)), 'Item verification failed: ' + action.before.id);
    } else assert(same(stable(current), stable(action.after)), 'Category verification failed: ' + action.before.id);
  }
  for (const deletion of plan.deletions) {
    if (deletion.status === 'prepared') {
      const current = (await retrieve([deletion.before.id]))[0];
      assert(same(current, deletion.before), 'Deletion baseline changed: ' + deletion.before.id);
      if (deletion.before.type === 'CATEGORY') {
        const items = await listSquareCatalogItems();
        assert(!items.some(item => refs(item).includes(deletion.before.id)), 'Category still has item references.');
      }
      deletion.status = 'sending'; await save(plan);
      deletion.response = await fetchSquare('/v2/catalog/object/' + deletion.before.id, { method: 'DELETE', signal: AbortSignal.timeout(60000) });
      deletion.status = 'responded'; await save(plan);
      assert(!deletion.response.errors?.length, JSON.stringify(deletion.response.errors));
    }
    const deletedIds = deletion.response?.deleted_object_ids || deletion.expectedIds;
    assert(deletion.expectedIds.every(id => deletedIds.includes(id)), 'Expected deletion missing from response.');
    const extras = deletedIds.filter(id => !deletion.expectedIds.includes(id));
    if (extras.length) {
      // Square also cascades item deletion to its POS grid tiles. Prove those
      // extra IDs referenced this exact item before accepting the response.
      const history = await fetchSquare('/v2/catalog/batch-retrieve', { method: 'POST', body: JSON.stringify({
        object_ids: extras, include_deleted_objects: true, catalog_version: deletion.before.version
      }) });
      assert(history.objects?.length === extras.length && history.objects.every(row => row.type === 'PAGE_TILE' && row.page_tile_data?.item_id === deletion.before.id), 'Unexpected deletion scope.');
      deletion.dependentTiles = history.objects; await save(plan);
    }
    const current = await retrieve(deletedIds);
    assert(current.length === deletedIds.length && current.every(row => row.is_deleted), 'Deletion is not confirmed; hold before retrying.');
    deletion.status = 'confirmed'; await save(plan);
  }
  const items = await listSquareCatalogItems();
  const active = items.filter(row => !row.is_deleted && !row.item_data.is_archived);
  assert(active.every(row => row.item_data.categories?.length), 'An active product is uncategorized.');
  const otherId = plan.changes.find(row => row.after.category_data?.name === 'Other').after.id;
  plan.verification = { activeProducts: active.length, uncategorized: 0, otherProducts: active.filter(row => refs(row).includes(otherId)).map(row => row.item_data.name),
    turkeySausagePreserved: active.some(row => row.id === 'EMLOI6VDW2L4CQCOJWU2BDGO') };
  assert(plan.verification.turkeySausagePreserved);
  plan.status = 'confirmed'; plan.confirmedAt = new Date().toISOString(); await save(plan);
}
console.log(JSON.stringify({ status: plan.status, renames: plan.renames, movedItems: plan.changes.filter(row => row.after.type === 'ITEM').map(row => row.after.item_data.name),
  deletions: plan.deletions.map(row => ({ name: row.before.category_data?.name || row.before.item_data.name, status: row.status, objectCount: row.expectedIds.length })), verification: plan.verification }, null, 2));
