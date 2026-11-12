// The user approved only Large at every active Square location on 2026-11-11.
// Preview first; apply reads the persisted, versioned plan and keeps its keys.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fetchSquare, listSquareCatalogItems, getSquareConfig } from '../lib/squareStoreSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';
import { hideSquareItemAtLocations, squareItemLocationSnapshot } from '../lib/squareItemLocations.js';

const directory = new URL('../../../reports/square-cornish-market-availability-2026-11-11/', import.meta.url);
const file = new URL('receipt.json', directory);
const targetHash = fingerprint(getSquareConfig());
const save = plan => fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n');
let plan;
try { plan = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!plan) {
  if (process.argv.includes('--apply')) throw new Error('Generate the reviewed preview first.');
  const [catalog, response] = await Promise.all([listSquareCatalogItems(), fetchSquare('/v2/locations')]);
  const locations = (response.locations || []).filter(row => row.status === 'ACTIVE').map(({ id, name }) => ({ id, name }));
  const cornish = catalog.filter(item => /cornish.*roasting (?:chicken|hen)/i.test(item.item_data?.name || '') && !item.is_deleted);
  const large = cornish.filter(item => /,\s*large$/i.test(item.item_data.name));
  const hidden = cornish.filter(item => /,\s*(?:medium|small|extra large|xlarge)$/i.test(item.item_data.name));
  if (large.length !== 1 || hidden.length < 2 || large.length + hidden.length !== cornish.length) throw new Error('Cornish item names or sizes need review.');
  const ids = locations.map(row => row.id);
  if (!squareItemLocationSnapshot(large[0], ids).every(row => Object.values(row.locations).every(Boolean))) throw new Error('Large is not available at every active location. Review its locations first.');
  plan = { createdAt: new Date().toISOString(), targetHash, locations, large: { id: large[0].id, name: large[0].item_data.name },
    actions: hidden.map(item => ({ name: item.item_data.name, before: item,
      request: { idempotency_key: crypto.randomUUID(), object: hideSquareItemAtLocations(item, ids) }, status: 'reviewed' })) };
  await fs.mkdir(directory, { recursive: true });
  await save(plan);
}
if (plan.targetHash !== targetHash) throw new Error('Square configuration changed since review.');
if (process.argv.includes('--apply')) {
  const ids = plan.locations.map(row => row.id);
  for (const action of plan.actions) {
    const current = (await fetchSquare(`/v2/catalog/object/${encodeURIComponent(action.before.id)}`)).object;
    const desired = squareItemLocationSnapshot(action.request.object, ids);
    if (!same(squareItemLocationSnapshot(current, ids), desired)) {
      if (current?.version !== action.before.version) throw new Error(`${action.name}: remote version changed; review before sending.`);
      action.status = 'sending'; await save(plan);
      await fetchSquare('/v2/catalog/object', { method: 'POST', body: JSON.stringify(action.request), signal: AbortSignal.timeout(60000) });
    }
    const confirmed = (await fetchSquare(`/v2/catalog/object/${encodeURIComponent(action.before.id)}`)).object;
    if (!same(squareItemLocationSnapshot(confirmed, ids), desired)) throw new Error(`${action.name}: location confirmation incomplete.`);
    action.status = 'confirmed'; action.confirmed = confirmed; action.confirmedAt = new Date().toISOString(); await save(plan);
  }
  const large = (await fetchSquare(`/v2/catalog/object/${encodeURIComponent(plan.large.id)}`)).object;
  if (!squareItemLocationSnapshot(large, ids)?.every(row => Object.values(row.locations).every(Boolean))) throw new Error('Large availability needs review.');
  plan.large.confirmedAt = new Date().toISOString(); await save(plan);
}
console.log(JSON.stringify({ receipt: file.pathname, locations: plan.locations.length, keepAvailable: plan.large.name,
  hide: plan.actions.map(row => ({ name: row.name, status: row.status })) }, null, 2));
