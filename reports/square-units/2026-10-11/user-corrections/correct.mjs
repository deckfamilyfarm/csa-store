import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getPool } from '../../../../apps/api/db.js';
import { loadApprovedSquarePricingRows, loadPackagesByProduct, buildSquareMatchRetailPrice, batchRetrieveSquareObjects, loadSquareMeasurementUnits, buildSquarePriceAuditRow } from '../../../../apps/api/lib/squareStoreSync.js';
import { squareUnitSnapshot } from '../../../../apps/api/lib/squarePricingUnits.js';

const targets = [
  { id: 813080, name: 'Pet Food, Organ Blend', unit: 'each' },
  { id: 805689, name: 'Organic Ground Beef', unit: 'each' },
  { id: 805688, name: 'Natural Ground Beef', unit: 'each' },
  { id: 805664, name: 'Hamburger Patties', unit: 'each' },
  { id: 805691, name: 'Ground Pork', unit: 'each' },
  { id: 813092, name: 'Ground Lamb', unit: 'each' },
  { id: 816905, name: 'Cajun Chaurice Sausage Links', unit: 'lbs', sourceUnitPrice: 20 },
];
const ids = targets.map(t => t.id);
const base = new URL('./', import.meta.url);
const save = (name, value) => fs.writeFile(new URL(name, base), JSON.stringify(value, null, 2) + '\n');
const read = async name => JSON.parse(await fs.readFile(new URL(name, base), 'utf8'));
async function snapshot(connection = getPool()) {
  const [products] = await connection.query('SELECT * FROM products WHERE id IN (?) ORDER BY id', [ids]);
  const [profiles] = await connection.query('SELECT * FROM product_pricing_profiles WHERE product_id IN (?) ORDER BY product_id', [ids]);
  const [packages] = await connection.query('SELECT * FROM packages WHERE product_id IN (?) ORDER BY id', [ids]);
  const [sales] = await connection.query('SELECT * FROM product_sales WHERE product_id IN (?) ORDER BY product_id', [ids]);
  return JSON.parse(JSON.stringify({ products, profiles, packages, sales }));
}
try {
  if (process.argv.includes('--check-local')) {
    const [rows] = await getPool().query(`SELECT p.id, p.name, p.unit, p.num_of_items, m.avg_package_weight, m.num_of_items AS cached_quantity,
      pp.unit_of_measure, pp.source_unit_price, pp.min_weight, pp.max_weight, pp.avg_weight_override
      FROM packages p LEFT JOIN local_line_package_meta m ON m.package_id=p.id
      LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.product_id WHERE p.product_id IN (?)`, [ids]);
    console.log(JSON.stringify(rows, null, 2));
  } else {
  const stateExists = await fs.access(new URL('state.json', base)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert(!stateExists, 'Corrections are already prepared/applied; preserve the original preview and receipts.');
  const before = await snapshot();
  assert.equal(before.products.length, 7); assert.equal(before.profiles.length, 7);
  const rows = (await loadApprovedSquarePricingRows([], { includeAllProducts: true })).filter(row => ids.includes(Number(row.productId)));
  assert.equal(rows.length, 7, 'Expected one approved Square variation for each reviewed product.');
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct(ids);
  const units = await loadSquareMeasurementUnits();
  const remoteObjects = await batchRetrieveSquareObjects(rows.map(row => row.squareVariationId));
  const preview = targets.map(target => {
    const row = rows.find(row => Number(row.productId) === target.id);
    assert.equal(row.productName, target.name);
    assert.equal(before.products.find(p => p.id === target.id).is_deleted || 0, 0);
    const beforeRetail = buildSquareMatchRetailPrice(row, packagesByProductId, metaByPackageId);
    const next = { ...row, unitOfMeasure: target.unit, ...(target.sourceUnitPrice === undefined ? {} : { sourceUnitPrice: target.sourceUnitPrice }) };
    const proposed = buildSquareMatchRetailPrice(next, packagesByProductId, metaByPackageId);
    if (target.unit === 'each') assert.equal(proposed.amount, beforeRetail.amount, 'Each corrections must preserve existing rates and sales.');
    else assert.equal(proposed.amount, 2000, 'Cajun must sell for exactly $20/lb.');
    const remote = remoteObjects.find(obj => obj.id === row.squareVariationId);
    assert(remote);
    const audit = buildSquarePriceAuditRow({ ...next, squareRawJson: JSON.stringify(remote) }, packagesByProductId, metaByPackageId, units);
    assert.notEqual(audit.status, 'blocked', JSON.stringify(audit));
    return { productId: target.id, name: target.name, packageId: Number(row.packageId), squareVariationId: row.squareVariationId,
      localUnitBefore: row.unitOfMeasure, localUnitAfter: target.unit, localRetailBefore: beforeRetail.regularAmount / 100,
      localRetailAfter: proposed.regularAmount / 100, saleApplied: proposed.saleApplied,
      squareBefore: { amount: remote.item_variation_data.price_money.amount, unit: squareUnitSnapshot(remote.item_variation_data.measurement_unit_id, units) },
      proposed: { amount: proposed.amount, unit: audit.proposedUnit }, profile: before.profiles.find(p => p.product_id === target.id) };
  });
  await save('preview.json', preview);
  await save('local-before.json', before);
  await save('square-before.json', { savedAt: new Date().toISOString(), objects: remoteObjects, units: [...units.values()] });
  console.log(JSON.stringify(preview.map(({ profile, ...row }) => row), null, 2));
  }
} finally { await getPool().end(); }
