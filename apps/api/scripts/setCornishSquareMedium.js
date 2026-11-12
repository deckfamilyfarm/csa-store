// User's revised instruction: Medium only at all active locations, with every
// Cornish item in Roasters & Turkeys. Retain the earlier Large-only receipt.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fetchSquare, listSquareCatalogItems, getSquareConfig } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';
import { hideSquareItemAtLocations, showSquareItemAtLocations, squareItemLocationSnapshot } from '../lib/squareItemLocations.js';

const redRanger = process.argv.includes('--red-ranger');
const family = redRanger ? 'Red Ranger' : 'Cornish';
const familyPattern = redRanger ? /red ranger.*roasting (?:chicken|hen)/i : /cornish.*roasting (?:chicken|hen)/i;
const directory = new URL(`../../../reports/${redRanger ? 'square-red-ranger-medium' : 'square-cornish-medium'}-2026-11-11/`, import.meta.url);
const file = new URL('receipt.json', directory);
const targetHash = fingerprint(getSquareConfig());
const save = plan => fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n');
const categoriesOf = item => [...new Set([...(item.item_data?.categories || []).map(c => c.id), item.item_data?.category_id].filter(Boolean))].sort();
const snapshot = (item, locations) => ({ availability: squareItemLocationSnapshot(item, locations), categories: categoriesOf(item) });
async function readCategories() {
  const result = []; let cursor;
  do {
    const q = new URLSearchParams({ types: 'CATEGORY' }); if (cursor) q.set('cursor', cursor);
    const page = await fetchSquare('/v2/catalog/list?' + q);
    result.push(...page.objects || []); cursor = page.cursor;
  } while (cursor);
  return result.filter(row => !row.is_deleted);
}
let plan;
try { plan = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  if (process.argv.includes('--apply')) throw new Error('Generate the preview first.');
  const [items, categories, response] = await Promise.all([listSquareCatalogItems(), readCategories(), fetchSquare('/v2/locations')]);
  const matches = categories.filter(row => row.category_data?.name.trim().toLowerCase() === 'roasters & turkeys');
  if (matches.length !== 1) throw new Error('Roasters & Turkeys needs an unambiguous existing Square category.');
  const locations = response.locations.filter(row => row.status === 'ACTIVE').map(({ id, name }) => ({ id, name }));
  const ids = locations.map(row => row.id), category = matches[0];
  const cornish = items.filter(item => !item.is_deleted && familyPattern.test(item.item_data?.name || ''));
  if (cornish.filter(item => /,\s*medium$/i.test(item.item_data.name)).length !== 1 || cornish.some(item => !/,\s*(?:medium|large|small|extra large|xlarge)$/i.test(item.item_data.name))) throw new Error(`Review the ${family} size names before publication.`);
  plan = { createdAt: new Date().toISOString(), targetHash, locations, category: { id: category.id, name: category.category_data.name },
    actions: cornish.map(item => {
      const active = /,\s*medium$/i.test(item.item_data.name);
      const next = (active ? showSquareItemAtLocations : hideSquareItemAtLocations)(item, ids);
      next.item_data.categories = [...(next.item_data.categories || [])];
      if (!next.item_data.categories.some(c => c.id === category.id)) next.item_data.categories.push({ id: category.id });
      return { name: item.item_data.name, active, before: item,
        request: { idempotency_key: crypto.randomUUID(), object: next }, status: 'reviewed' };
    }) };
  await fs.mkdir(directory, { recursive: true }); await save(plan);
}
if (plan.targetHash !== targetHash) throw new Error('Square configuration changed since review.');
if (process.argv.includes('--apply')) {
  const ids = plan.locations.map(row => row.id);
  for (const action of plan.actions) {
    const current = (await fetchSquare(`/v2/catalog/object/${action.before.id}`)).object;
    if (!same(snapshot(current, ids), snapshot(action.request.object, ids))) {
      if (current?.version !== action.before.version) throw new Error(`${action.name}: the Square version changed; review before sending.`);
      action.status = 'sending'; await save(plan);
      await fetchSquare('/v2/catalog/object', { method: 'POST', body: JSON.stringify(action.request), signal: AbortSignal.timeout(60000) });
    }
    const confirmed = (await fetchSquare(`/v2/catalog/object/${action.before.id}`)).object;
    if (!same(snapshot(confirmed, ids), snapshot(action.request.object, ids))) throw new Error(`${action.name}: confirmation incomplete.`);
    action.status = 'confirmed'; action.confirmed = confirmed; action.confirmedAt = new Date().toISOString(); await save(plan);
  }
}
console.log(JSON.stringify({ receipt: file.pathname, locations: plan.locations.length, category: plan.category.name,
  actions: plan.actions.map(row => ({ name: row.name, available: row.active, status: row.status })) }, null, 2));
