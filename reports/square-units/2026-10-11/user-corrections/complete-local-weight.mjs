// The existing Cajun package label explicitly says 14 oz. Save that weight so its
// newly requested $20/lb source price can calculate local CSA package prices.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getPool, getDb } from '../../../../apps/api/db.js';
import { validateSavedProductVendor } from '../../../../apps/api/lib/productVendor.js';
import { loadLocalLineSyncContext } from '../../../../apps/api/localLine.js';
import { computeProductPricingSnapshot } from '../../../../apps/api/lib/productPricing.js';
import { withSyncLock } from '../../../../apps/api/lib/productSyncSchema.js';
const base = new URL('./', import.meta.url);
const save = (name, data) => fs.writeFile(new URL(name, base), JSON.stringify(data, null, 2) + '\n');
try {
  const original = JSON.parse(await fs.readFile(new URL('local-after.json', base)));
  const originalProfile = original.profiles.find(p => p.product_id === 816905);
  const result = await withSyncLock('csa-store:scheduled-pricelist-releases', async connection => {
    await connection.beginTransaction();
    try {
      const [[product]] = await connection.query('SELECT id, name FROM products WHERE id=816905 FOR UPDATE');
      assert.equal(product.name, 'Cajun Chaurice Sausage Links');
      await validateSavedProductVendor(connection, product.id);
      const [[profile]] = await connection.query('SELECT * FROM product_pricing_profiles WHERE product_id=? FOR UPDATE', [product.id]);
      const [[pkg]] = await connection.query('SELECT p.name, m.avg_package_weight FROM packages p LEFT JOIN local_line_package_meta m ON m.package_id=p.id WHERE p.id=539546 AND p.product_id=?', [product.id]);
      assert.equal(pkg.name, '4 links/ pack 14 oz pack'); assert.equal(pkg.avg_package_weight, null);
      assert.equal(profile.unit_of_measure, 'lbs'); assert.equal(Number(profile.source_unit_price), 20);
      assert.equal(profile.min_weight, null); assert.equal(profile.max_weight, null);
      if (profile.avg_weight_override == null) {
        assert.deepEqual(JSON.parse(JSON.stringify(profile)), originalProfile, 'Pricing changed since the preceding correction.');
        await connection.query(`UPDATE product_pricing_profiles SET avg_weight_override=0.875, price_changed_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE product_id=?`, [product.id]);
      } else assert.equal(Number(profile.avg_weight_override), 0.875);
      await connection.commit();
      return { productId: product.id, packageId: 539546, basis: pkg.name, ounces: 14, pounds: 14 / 16, previousWeightOverride: null };
    } catch (error) { await connection.rollback(); throw error; }
  });
  const context = await loadLocalLineSyncContext(getDb(), 816905);
  const snapshot = computeProductPricingSnapshot({ product: context.product, vendor: context.vendor, profile: { ...context.profile, ...context.sale }, packages: context.packages,
    packageMetaByPackageId: new Map(context.packageMeta.map(m => [Number(m.packageId), m])) });
  assert.equal(snapshot.profile.unitOfMeasure, 'lbs'); assert.equal(snapshot.profile.sourceUnitPrice, 20);
  assert.equal(snapshot.profile.avgWeightOverride, 0.875);
  assert(snapshot.packageRows.length > 0);
  assert(snapshot.packageRows.every(row => row.basePrice > 0), 'Every local package must have a calculable price.');
  await save('cajun-weight.json', { ...result, verifiedAt: new Date().toISOString(), pricing: snapshot });
  console.log(JSON.stringify({ ...result, localBasePrice: snapshot.basePrice, sourceUnitPrice: snapshot.profile.sourceUnitPrice, unit: snapshot.profile.unitOfMeasure }, null, 2));
} finally { await getPool().end(); }
