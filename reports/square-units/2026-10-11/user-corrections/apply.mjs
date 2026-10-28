// Implements the user's explicit seven-product correction. No Local Line publication.
// --prepare saves local units/prices and persists a Square-only audit; --apply publishes that audit.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getPool } from '../../../../apps/api/db.js';
import { validateSavedProductVendor } from '../../../../apps/api/lib/productVendor.js';
import { withSyncLock } from '../../../../apps/api/lib/productSyncSchema.js';
import { createProductSyncAudit, getProductSyncAudit, listProductSyncActions, createProductSyncRelease, runProductSyncRelease, productSyncActionRelease } from '../../../../apps/api/lib/productSync.js';
import { loadApprovedSquarePricingRows, loadPackagesByProduct, buildSquareMatchRetailPrice, batchRetrieveSquareObjects, loadSquareMeasurementUnits } from '../../../../apps/api/lib/squareStoreSync.js';
import { squareUnitSnapshot } from '../../../../apps/api/lib/squarePricingUnits.js';
const base = new URL('./', import.meta.url);
const read = async name => JSON.parse(await fs.readFile(new URL(name, base), 'utf8'));
const save = (name, data) => fs.writeFile(new URL(name, base), JSON.stringify(data, null, 2) + '\n');
const json = value => JSON.parse(JSON.stringify(value));
const reviewed = await read('preview.json');
const ids = reviewed.map(r => r.productId);
assert.equal(reviewed.length, 7); assert.equal(new Set(ids).size, 7);
assert(process.argv.includes('--prepare') || process.argv.includes('--apply'));
const profileChangedKeys = new Set(['unit_of_measure','source_unit_price','updated_at','price_changed_at','remote_sync_status','remote_sync_message','remote_synced_at']);
const preservedProfile = row => Object.fromEntries(Object.entries(row).filter(([key]) => !profileChangedKeys.has(key)));
async function snapshot(connection = getPool()) {
  const [products] = await connection.query('SELECT * FROM products WHERE id IN (?) ORDER BY id', [ids]);
  const [profiles] = await connection.query('SELECT * FROM product_pricing_profiles WHERE product_id IN (?) ORDER BY product_id', [ids]);
  const [packages] = await connection.query('SELECT * FROM packages WHERE product_id IN (?) ORDER BY id', [ids]);
  const [sales] = await connection.query('SELECT * FROM product_sales WHERE product_id IN (?) ORDER BY product_id', [ids]);
  return json({ products, profiles, packages, sales });
}
function validateLocal(after, before) {
  assert.deepEqual(after.products, before.products, 'Product metadata and inventory must be unchanged.');
  assert.deepEqual(after.packages, before.packages, 'Package records must be unchanged.');
  assert.deepEqual(after.sales, before.sales, 'Sale settings must be unchanged.');
  for (const target of reviewed) {
    const profile = after.profiles.find(p => Number(p.product_id) === target.productId);
    assert.equal(profile.unit_of_measure, target.localUnitAfter);
    assert.equal(Number(profile.source_unit_price), target.localRetailAfter);
    assert.deepEqual(preservedProfile(profile), preservedProfile(target.profile));
  }
}
try {
  const [[admin]] = await getPool().query(`SELECT u.id FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id
    JOIN admin_roles r ON r.id=ur.role_id WHERE u.username=? AND COALESCE(u.active,1)=1 AND r.role_key='admin'`, [process.env.ADMIN_USER || 'deck.john']);
  assert(admin, 'Configured administrator must have the admin role.');
  const user = { userId: Number(admin.id), adminRoles: ['admin'] };
  const before = await read('local-before.json');
  let state = await read('state.json').catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  if (process.argv.includes('--prepare')) {
    if (!state.localApplied) {
      const after = await withSyncLock('csa-store:scheduled-pricelist-releases', async connection => {
        await connection.beginTransaction();
        try {
          await connection.query('SELECT id FROM products WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
          await connection.query('SELECT product_id FROM product_pricing_profiles WHERE product_id IN (?) ORDER BY product_id FOR UPDATE', [ids]);
          const current = await snapshot(connection);
          if (current.profiles.every(profile => {
            const target = reviewed.find(r => r.productId === Number(profile.product_id));
            return profile.unit_of_measure === target.localUnitAfter && Number(profile.source_unit_price) === target.localRetailAfter;
          })) {
            validateLocal(current, before); // Recover an acknowledged commit if the local receipt was interrupted.
          } else {
            assert.deepEqual(current, before, 'Local data changed since the preview. Review before writing.');
            for (const target of reviewed) {
              await validateSavedProductVendor(connection, target.productId);
              assert.equal(current.products.find(p => p.id === target.productId).name, target.name);
              await connection.query(`UPDATE product_pricing_profiles SET unit_of_measure=?, source_unit_price=?,
                price_changed_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP(), remote_sync_status='pending',
                remote_sync_message='User-corrected retail unit/price saved locally; Local Line publication pending.', remote_synced_at=NULL WHERE product_id=?`,
                [target.localUnitAfter, target.localRetailAfter, target.productId]);
            }
          }
          const result = await snapshot(connection);
          validateLocal(result, before);
          await connection.commit();
          return result;
        } catch (error) { await connection.rollback(); throw error; }
      });
      await save('local-after.json', after);
      state.localApplied = true;
      await save('state.json', state);
    }
    if (!state.auditId) {
      const audit = await createProductSyncAudit({ platforms: ['square'], incoming: false, productScope: 'selected', vendorGroup: 'all', productIds: ids }, user);
      state.auditId = audit.id;
      await save('state.json', state);
    }
  }
  assert(state.localApplied && state.auditId, 'Prepare first.');
  let audit;
  for (let i = 0; i < 180; i++) {
    audit = await getProductSyncAudit(state.auditId);
    if (audit.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(audit.status, 'completed', JSON.stringify(audit));
  const { rows: actions } = await listProductSyncActions(state.auditId, { platform: 'square', direction: 'outgoing', pageSize: 100 });
  assert.equal(actions.length, 7);
  for (const action of actions) {
    const target = reviewed.find(r => r.productId === action.productId && r.packageId === action.packageId);
    assert(target);
    assert.equal(action.mapping.squareVariationId, target.squareVariationId);
    assert.equal(action.payload.amount, target.proposed.amount);
    assert.deepEqual(action.payload.sellingUnit, target.proposed.unit);
    assert.equal(action.remoteBefore.amount, target.squareBefore.amount);
    assert.deepEqual(action.remoteBefore.sellingUnit, target.squareBefore.unit, 'Square changed since preview; inspect before publishing.');
    assert(['changed','synced'].includes(action.status), JSON.stringify(action));
    assert.deepEqual(action.staged, {});
  }
  await save('reviewed-actions.json', actions);
  console.log(JSON.stringify({ auditId: state.auditId, localUpdated: ids.length, squareChanges: actions.filter(a => a.status === 'changed').map(a => ({ product: a.productName, before: a.display.current, after: a.display.proposed })), alreadySynced: actions.filter(a => a.status === 'synced').map(a => a.productName) }, null, 2));
  if (process.argv.includes('--apply')) {
    const changed = actions.filter(a => a.status === 'changed');
    if (!state.releaseId && changed.length) {
      const existing = await productSyncActionRelease(state.auditId, changed[0].id);
      const release = existing || await createProductSyncRelease({ auditId: state.auditId, actionIds: changed.map(a => a.id), name: 'User correction: six products each; Cajun Chaurice $20/lb — October 11' }, user);
      state.releaseId = release.id;
      await save('state.json', state);
    }
    if (state.releaseId) {
      const result = await runProductSyncRelease(state.releaseId, { user, allowFuture: true });
      await save('release-result.json', result);
      console.log(JSON.stringify({ releaseId: result.id, status: result.status, actions: result.actions.map(a => ({ product: a.productName, status: a.status, message: a.message })) }, null, 2));
      assert.equal(result.status, 'completed', 'Preserve this release and its idempotency keys for recovery.');
    }
    const objects = await batchRetrieveSquareObjects(reviewed.map(r => r.squareVariationId));
    const units = await loadSquareMeasurementUnits();
    await save('square-after.json', { savedAt: new Date().toISOString(), objects, units: [...units.values()] });
    const after = await snapshot(); validateLocal(after, before);
    await save('local-after.json', after);
    const rows = (await loadApprovedSquarePricingRows([], { includeAllProducts: true })).filter(r => ids.includes(Number(r.productId)));
    const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct(ids);
    const verified = reviewed.map(target => {
      const remote = objects.find(o => o.id === target.squareVariationId);
      const remoteUnit = squareUnitSnapshot(remote.item_variation_data.measurement_unit_id, units);
      const retail = buildSquareMatchRetailPrice(rows.find(r => Number(r.productId) === target.productId), packagesByProductId, metaByPackageId);
      assert.equal(remote.item_variation_data.price_money.amount, target.proposed.amount);
      assert.deepEqual(remoteUnit, target.proposed.unit);
      assert.equal(retail.amount, target.proposed.amount);
      assert.equal(retail.unit, target.localUnitAfter === 'lbs' ? 'lb' : 'each');
      return { product: target.name, localUnit: target.localUnitAfter, localRetailPrice: retail.regularAmount / 100, squareUnit: remoteUnit.unit, squarePrice: retail.amount / 100, saleApplied: retail.saleApplied };
    });
    await save('verified.json', { verifiedAt: new Date().toISOString(), auditId: state.auditId, releaseId: state.releaseId, localUpdated: 7, squareUpdated: changed.length, rows: verified });
    console.log(JSON.stringify({ verified }, null, 2));
  }
} finally { await getPool().end(); }
