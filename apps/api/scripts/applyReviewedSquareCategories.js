// The user assigned these eight previously uncategorized Square items.
// Preserve the exact catalog bodies, keys and receipts across retries.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import { fetchSquare, listSquareCatalogItems, getSquareConfig } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';

const correctPorkChops = process.argv.includes('--correct-pork-chops');
const assignments = correctPorkChops ? [
  ['ILHEC25TNXQ4LPPDALYQPVZH', 'Pork Chop, Bone-in', 'Pasture Raised Pork'],
  ['7TZ2PHV5WBRXETZIWZWGIHBA', 'Pork Chop, Boneless', 'Pasture Raised Pork']
] : [
  ['IS5M2UVFIMSFPBAGYZZ7T22C', "Bavarian Style Grazier's Sausage", 'Sausages & N Free Cures'],
  ['VOQME3YDXUVD2ZVARTKIS42R', 'Chicken Thighs', 'Roasters & Turkeys'],
  ['FKULRXIWE4PAV5FT5UFCEIJ2', 'Old World Style Hot Dogs', 'Sausages & N Free Cures'],
  ['ILHEC25TNXQ4LPPDALYQPVZH', 'Pork Chop, Bone-in', 'Roasters & Turkeys'],
  ['7TZ2PHV5WBRXETZIWZWGIHBA', 'Pork Chop, Boneless', 'Roasters & Turkeys'],
  ['N54VBMXA4Z5ZGU4DQZLCZWLD', 'Red Ranger Roasting Chicken, Medium', 'Roasters & Turkeys'],
  ['RV3JWBI2MVGAZEFD3Z7RMLJL', 'Red Ranger Roasting Chicken, Small', 'Roasters & Turkeys'],
  ['R4NQPB7JMMTFNNECJOKHDET4', 'Smoked Pork Hocks -Skin-on and Smoked', 'Pasture Raised Pork']
];
const directory = new URL(`../../../reports/${correctPorkChops ? 'square-pork-chop-category-correction' : 'square-category-assignments'}-2026-11-11/`, import.meta.url);
const file = new URL('receipt.json', directory);
const targetHash = fingerprint(getSquareConfig());
const save = plan => fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n');
const ids = item => [...new Set([...(item?.item_data?.categories || []).map(row => row.id), item?.item_data?.category_id].filter(Boolean))].sort();
function otherFields(item) {
  const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !['version', 'updated_at', 'created_at'].includes(key)).map(([key, item]) => [key, clean(item)])) : value;
  const next = clean(item);
  for (const key of ['categories', 'category_id', 'reporting_category']) delete next.item_data[key];
  return next;
}
let plan;
try { plan = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  if (process.argv.includes('--apply')) throw new Error('Generate the reviewed preview first.');
  const categories = []; let cursor;
  do {
    const params = new URLSearchParams({ types: 'CATEGORY' }); if (cursor) params.set('cursor', cursor);
    const result = await fetchSquare('/v2/catalog/list?' + params);
    categories.push(...(result.objects || []).filter(row => !row.is_deleted)); cursor = result.cursor;
  } while (cursor);
  const items = await listSquareCatalogItems();
  plan = { createdAt: new Date().toISOString(), targetHash, actions: assignments.map(([id, name, categoryName]) => {
    const item = items.find(row => row.id === id);
    const matches = categories.filter(row => row.category_data?.name === categoryName);
    if (matches.length !== 1) throw new Error(`Review the existing ${categoryName} category.`);
    if (!item || item.is_deleted || item.item_data?.is_archived || item.item_data?.name !== name || !item.version) throw new Error(`Review the live item match for ${name}.`);
    const category = matches[0], next = structuredClone(item);
    next.item_data.categories = [...(next.item_data.categories || [])];
    if (correctPorkChops) {
      const roasters = categories.filter(row => row.category_data?.name === 'Roasters & Turkeys');
      if (roasters.length !== 1) throw new Error('Review the existing Roasters & Turkeys category.');
      next.item_data.categories = next.item_data.categories.filter(row => row.id !== roasters[0].id);
      if (next.item_data.category_id === roasters[0].id) next.item_data.category_id = category.id;
      if (next.item_data.reporting_category?.id === roasters[0].id) next.item_data.reporting_category = { id: category.id };
    }
    if (!next.item_data.categories.some(row => row.id === category.id)) next.item_data.categories.push({ id: category.id });
    return { name, categoryName, categoryId: category.id, before: item,
      request: { idempotency_key: crypto.randomUUID(), object: next }, status: 'reviewed' };
  }) };
  await fs.mkdir(directory, { recursive: true }); await save(plan);
}
if (plan.targetHash !== targetHash) throw new Error('Square configuration changed since review.');
if (process.argv.includes('--apply')) {
  for (const extension of ['json', 'html', 'csv']) {
    const from = new URL(`../../../reports/square-uncategorized-2026-11-11/items.${extension}`, import.meta.url);
    await fs.copyFile(from, new URL(`uncategorized-before.${extension}`, directory), constants.COPYFILE_EXCL)
      .catch(error => { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; });
  }
  for (const action of plan.actions) {
    const current = (await fetchSquare(`/v2/catalog/object/${action.before.id}`)).object;
    if (!current || current.is_deleted) throw new Error(`${action.name}: item missing or deleted.`);
    if (!same(ids(current), ids(action.request.object))) {
      if (current.version !== action.before.version) throw new Error(`${action.name}: catalog version changed. Review before sending.`);
      action.status = 'sending'; await save(plan);
      await fetchSquare('/v2/catalog/object', { method: 'POST', body: JSON.stringify(action.request), signal: AbortSignal.timeout(60000) });
    }
    const confirmed = (await fetchSquare(`/v2/catalog/object/${action.before.id}`)).object;
    if (!same(ids(confirmed), ids(action.request.object))) throw new Error(`${action.name}: category confirmation incomplete.`);
    if (!same(otherFields(confirmed), otherFields(action.before))) throw new Error(`${action.name}: other catalog fields changed; review the receipt.`);
    action.status = 'confirmed'; action.confirmed = confirmed; action.confirmedAt = new Date().toISOString(); await save(plan);
  }
}
console.log(JSON.stringify({ receipt: file.pathname, actions: plan.actions.map(({ name, categoryName, status }) => ({ name, category: categoryName, status })) }, null, 2));
