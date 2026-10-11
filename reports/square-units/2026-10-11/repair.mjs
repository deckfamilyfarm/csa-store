// One-time repair for the nine products in live-before/report.json.
// Prepare: node --env-file=.env reports/square-units/2026-10-11/repair.mjs
// Apply/retry that exact persisted release: append --apply.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getPool } from '../../../apps/api/db.js';
import { batchRetrieveSquareObjects, loadSquareMeasurementUnits } from '../../../apps/api/lib/squareStoreSync.js';
import { createProductSyncAudit, getProductSyncAudit, listProductSyncActions,
  createProductSyncRelease, runProductSyncRelease } from '../../../apps/api/lib/productSync.js';
const base = new URL('./', import.meta.url);
const each = process.argv.includes('--each');
const prefix = each ? 'each-' : '';
const read = async name => JSON.parse(await fs.readFile(new URL(prefix + name, base), 'utf8'));
const save = async (name, value) => fs.writeFile(new URL(prefix + name, base), JSON.stringify(value, null, 2) + '\n');
try {
  const report = JSON.parse(await fs.readFile(new URL('live-before/report.json', base), 'utf8'));
  assert.equal(report.source, 'live Square API');
  const targets = report.rows.filter(row => row.status === (each ? 'review' : 'fix'));
  assert.equal(targets.length, each ? 14 : 9);
  if (!each) assert(targets.every(row => row.expectedUnit === 'lb' && row.measurementUnitId === null && row.squareAmount === row.expectedAmount));
  const [[admin]] = await getPool().query(`SELECT u.id FROM users u
    JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id
    WHERE u.username=? AND COALESCE(u.active,1)=1 AND r.role_key='admin'`, [process.env.ADMIN_USER || 'deck.john']);
  assert(admin, 'The configured administrator must exist and have the admin role.');
  const user = { userId: Number(admin.id), adminRoles: ['admin'] };
  let state = await read('repair-state.json').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!state) {
    assert(!process.argv.includes('--apply'), 'Prepare and review the persisted audit first.');
    const units = await loadSquareMeasurementUnits();
    const before = await batchRetrieveSquareObjects(targets.map(row => row.squareVariationId));
    await save('square-before.json', { savedAt: new Date().toISOString(), units: [...units.values()], objects: before });
    const audit = await createProductSyncAudit({ platforms: ['square'], productScope: 'selected', vendorGroup: 'all', productIds: targets.map(row => row.productId) }, user);
    state = { auditId: audit.id, reportGeneratedAt: report.generatedAt };
    await save('repair-state.json', state);
  }
  let audit;
  do {
    audit = await getProductSyncAudit(state.auditId);
    if (audit.status === 'running') await new Promise(resolve => setTimeout(resolve, 1000));
  } while (audit.status === 'running');
  assert.equal(audit.status, 'completed', JSON.stringify(audit));
  const { rows: actions } = await listProductSyncActions(state.auditId, { platform: 'square', direction: 'outgoing', pageSize: 100 });
  assert.equal(actions.length, targets.length);
  for (const action of actions) {
    const target = targets.find(row => row.packageId === action.packageId && row.squareVariationId === action.mapping.squareVariationId);
    assert(target, 'Unreviewed target');
    assert(each ? ['changed', 'synced'].includes(action.status) : action.status === 'changed');
    assert.equal(action.payload.amount, target.expectedAmount);
    assert.equal(action.remoteBefore.amount, target.squareAmount);
    assert.equal(action.remoteBefore.sellingUnit.id, target.measurementUnitId);
    assert.equal(action.payload.sellingUnit.unit, each ? 'each/package' : 'lb');
    if (!each) assert(action.payload.sellingUnit.precision > 0);
    assert.equal(Object.keys(action.staged).length, 0);
  }
  await save('reviewed-actions.json', actions);
  console.log(JSON.stringify({ auditId: state.auditId, changes: actions.map(action => ({ product: action.productName, price: action.display.proposed.price, from: action.display.current.sellingUnit, to: action.display.proposed.sellingUnit })) }, null, 2));
  if (process.argv.includes('--apply')) {
    if (!state.releaseId) {
      const release = await createProductSyncRelease({ auditId: state.auditId, actionIds: actions.filter(action => action.status === 'changed').map(action => action.id), name: each ? 'Align Square after confirming 14 products priced each — October 11' : 'Correct nine Square selling units to lb — reviewed October 11' }, user);
      state.releaseId = release.id;
      await save('repair-state.json', state);
    }
    const result = await runProductSyncRelease(state.releaseId, { user, allowFuture: true });
    await save('repair-result.json', result);
    const after = await batchRetrieveSquareObjects(targets.map(row => row.squareVariationId));
    await save('square-after.json', { savedAt: new Date().toISOString(), objects: after });
    console.log(JSON.stringify({ releaseId: result.id, status: result.status, actions: result.actions.map(action => ({ product: action.productName, status: action.status, message: action.message })) }, null, 2));
    assert.equal(result.status, 'completed', 'Some repairs need review; preserve this release for recovery.');
    for (const target of targets) {
      const object = after.find(row => row.id === target.squareVariationId);
      const action = actions.find(row => row.packageId === target.packageId);
      assert.equal(object?.item_variation_data?.measurement_unit_id || null, action.payload.sellingUnit.id);
      assert.equal(object?.item_variation_data?.price_money?.amount, target.expectedAmount);
    }
  }
} finally { await getPool().end(); }
