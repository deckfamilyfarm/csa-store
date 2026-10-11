// User confirmed all 14 review products are priced per each/package.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getPool } from '../../../apps/api/db.js';
import { loadApprovedSquarePricingRows, loadPackagesByProduct, buildSquareMatchRetailPrice } from '../../../apps/api/lib/squareStoreSync.js';
const base = new URL('./', import.meta.url);
const save = (name, value) => fs.writeFile(new URL(name, base), JSON.stringify(value, null, 2) + '\n');
try {
  const report = JSON.parse(await fs.readFile(new URL('live-before/report.json', base)));
  const targets = report.rows.filter(row => row.status === 'review');
  assert.equal(targets.length, 14);
  const ids = targets.map(row => row.productId);
  const rows = (await loadApprovedSquarePricingRows([], { includeAllProducts: true })).filter(row => ids.includes(Number(row.productId)));
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct(ids);
  const preview = rows.map(row => {
    const before = buildSquareMatchRetailPrice(row, packagesByProductId, metaByPackageId);
    const after = buildSquareMatchRetailPrice({ ...row, unitOfMeasure: 'each' }, packagesByProductId, metaByPackageId);
    assert.equal(before.amount, after.amount, `${row.productName}: changing unit would change the inferred rate; review first.`);
    return { productId: Number(row.productId), product: row.productName, oldUnit: row.unitOfMeasure, unit: 'each', amount: after.amount, squareAmount: Number(row.squarePriceAmount) };
  });
  await save('local-each-preview.json', preview);
  if (process.argv.includes('--apply')) {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM products WHERE id IN (?) FOR UPDATE', [ids]);
      const [profiles] = await connection.query('SELECT * FROM product_pricing_profiles WHERE product_id IN (?) FOR UPDATE', [ids]);
      if (profiles.length === ids.length && profiles.every(row => row.unit_of_measure === 'each')) {
        await connection.rollback();
      } else {
        assert.equal(profiles.length, 0, 'Local profiles changed since the review; inspect before proceeding.');
        const [products] = await connection.query('SELECT * FROM products WHERE id IN (?)', [ids]);
        const [packages] = await connection.query('SELECT * FROM packages WHERE product_id IN (?)', [ids]);
        const [sales] = await connection.query('SELECT * FROM product_sales WHERE product_id IN (?)', [ids]);
        await save('local-before-each.json', { savedAt: new Date().toISOString(), profiles, products, packages, sales });
        await connection.query("INSERT INTO product_pricing_profiles (product_id,unit_of_measure,created_at,updated_at) VALUES ?", [ids.map(id => [id, 'each', new Date(), new Date()])]);
        const [after] = await connection.query('SELECT * FROM product_pricing_profiles WHERE product_id IN (?)', [ids]);
        assert.equal(after.length, 14); assert(after.every(row => row.unit_of_measure === 'each'));
        await connection.commit();
        await save('local-after-each.json', after);
      }
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  console.log(JSON.stringify({ applied: process.argv.includes('--apply'), rows: preview }, null, 2));
} finally { await getPool().end(); }
