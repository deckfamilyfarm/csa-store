// User-approved change: these four bones sell for $10 per bag in Square and
// $9 per package in Full Farm. A bag is one each; weights remain descriptive.
// Preserve the existing package Cost through an explicit lb-to-bag conversion.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { getPool } from '../db.js';
import { getLocalLineAccessToken } from '../localLineAuth.js';
import { fetchLocalLineProduct } from '../localLine.js';
import { batchRetrieveSquareObjects, loadSquareMeasurementUnits, getSquareConfig } from '../lib/squareStoreSync.js';
import { planSquareUnit } from '../lib/squarePricingUnits.js';
import { getPricingSettings, getApprovedEnterpriseRevision, previewEnterprisePricing, saveEnterprisePricingDraft, approveEnterprisePricingRevision } from '../lib/enterprisePricingService.js';
import { enterprisePackageCostCents } from '../lib/enterpriseLocalLineCost.js';
import { createProductSyncAudit, getProductSyncAudit, listProductSyncActions, createProductSyncRelease, productSyncActionRelease, runProductSyncRelease } from '../lib/productSync.js';
import { fingerprint, same } from '../lib/productSyncCore.js';
import { readSavedEnterprisePricing } from '../lib/enterprisePricingReads.js';

const directory = new URL('../../../reports/bone-bag-pricing-2026-11-11/', import.meta.url);
const file = new URL('receipt.json', directory);
const pool = getPool();
const productIds = [922135, 825834, 825835, 813078];
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const target = () => fingerprint({ square: getSquareConfig(), db: [process.env.STORE_DB_HOST, process.env.STORE_DB_PORT, process.env.STORE_DB_DATABASE] });
const save = async plan => { await fs.writeFile(new URL('receipt.tmp', directory), JSON.stringify(plan, null, 2) + '\n'); await fs.rename(new URL('receipt.tmp', directory), file); };
async function actor() {
  const [[user]] = await pool.query('SELECT id,active FROM users WHERE username=?', ['jdeck']);
  assert.ok(user?.active, 'The requesting administrator must be active.');
  const [rows] = await pool.query('SELECT r.role_key FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.user_id=?', [user.id]);
  const roles = rows.map(row => row.role_key);
  assert.ok(roles.includes('admin') || roles.includes('square_push') && roles.includes('localline_push') && roles.some(role => ['pricing_admin', 'pricing_publisher'].includes(role)), 'Pricing and both channel permissions required.');
  return { userId: Number(user.id), adminRoles: roles };
}
function assertTarget(preview, packageId, costCents) {
  assert.equal(preview.input.pricingUnit, 'each'); assert.equal(preview.input.squareEnabled, true);
  assert.equal(preview.output.packages.length, 1);
  const pkg = preview.output.packages[0];
  assert.equal(pkg.packageId, packageId); assert.equal(pkg.quantity, 1);
  assert.equal(pkg.squareVariationCents, 1000); assert.equal(pkg.localLineRegularCents, 900);
  assert.equal(pkg.localLineSaleCents, 900);
  assert.equal(enterprisePackageCostCents(preview.output, packageId), costCents, 'Package Cost must be preserved.');
}
let plan;
try {
  await fs.mkdir(directory, { recursive: true });
  const user = await actor();
  plan = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!plan) {
    if (process.argv.includes('--apply')) throw new Error('Prepare the reviewed preview first.');
    const settings = await getPricingSettings();
    assert.equal(settings.localLineDiscountBp, 1000, '$10 must calculate to $9 without changing global discounts.');
    const token = await getLocalLineAccessToken(), units = await loadSquareMeasurementUnits();
    plan = { createdAt: new Date().toISOString(), targetHash: target(), actorId: user.userId, settingsId: settings.id, products: [] };
    const effectiveAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const productId of productIds) {
      const revision = await getApprovedEnterpriseRevision(productId);
      assert.ok(revision && ['active', 'approved'].includes(revision.status), 'Existing reviewed pricing is required.');
      assert.equal(revision.input.pricingUnit, 'lb'); assert.equal(revision.output.packages.length, 1);
      const packageId = revision.output.packages[0].packageId;
      const [[product]] = await pool.query(`SELECT p.name,m.local_line_product_id AS remoteId,pm.local_line_package_id AS remotePackageId
        FROM products p JOIN local_line_product_meta m ON m.product_id=p.id
        JOIN local_line_package_meta pm ON pm.product_id=p.id AND pm.package_id=? WHERE p.id=?`, [packageId, productId]);
      assert.ok(product?.remoteId && product.remotePackageId, 'Explicit Local Line package mapping is required.');
      const [[link]] = await pool.query('SELECT id,square_item_id AS itemId,square_variation_id AS variationId,approved_at FROM square_variation_links WHERE product_id=? AND package_id=?', [productId, packageId]);
      assert.ok(link?.approved_at, 'An approved Square variation link is required.');
      const [variation] = (await batchRetrieveSquareObjects([link.variationId])).filter(row => row.id === link.variationId);
      assert.equal(variation?.item_variation_data?.item_id, link.itemId);
      const unit = planSquareUnit('each', variation, units);
      assert.deepEqual(unit.issues, [], 'Tracked inventory, unknown units or conversions must be reviewed first.');
      const remote = await fetchLocalLineProduct(product.remoteId, token);
      assert.equal(remote.charge_type, 'package');
      const remotePackage = remote.packages.find(row => Number(row.id) === Number(product.remotePackageId));
      const costCents = enterprisePackageCostCents(revision.output, packageId);
      assert.equal(Math.round(Number(remotePackage?.unit_price) * 100), costCents, 'Live vendor package Cost must match its approved starting point.');
      assert.ok(remotePackage.price_list_entries.length);
      assert.ok(remotePackage.price_list_entries.every(row => Number(row.adjustment_type) === 3 && Math.round(Number(row.adjustment_value) * 100) === 900 && !row.on_sale_toggle), 'Current FF basket prices must be $9 with no sale.');
      const input = structuredClone(revision.input);
      input.pricingUnit = 'each'; input.squareOverride = '10.00'; input.csaOverride = null;
      input.priceEffectiveAt = effectiveAt;
      input.overrideNote = `User 2026-11-11: $10 per bag in Square; $9 FF Package Price; one bag is one each. Supersedes per-lb retail. Preserve approved package Cost from revision ${revision.id}; no economic Cost change.`;
      input.packages = input.packages.map(pkg => ({ ...pkg, quantity: 1 }));
      input.purchaseCosts.push({ enterpriseId: input.retailEnterpriseId, cost: (costCents / 100).toFixed(2), effectiveAt,
        documentationRef: `Unit conversion only: existing approved package Cost ${costCents} cents, confirmed against Local Line package ${product.remotePackageId}; prior revision ${revision.id} retained. One bag replaces the prior reviewed average-weight pricing unit.` });
      const preview = await previewEnterprisePricing(productId, input);
      assertTarget(preview, packageId, costCents);
      plan.products.push({ productId, name: product.name, packageId, remoteId: product.remoteId, remotePackageId: product.remotePackageId,
        squareItemId: link.itemId, squareVariationId: link.variationId, beforeRevision: revision, beforeSquare: variation,
        beforeLocalLine: remote, costCents, preview, status: 'reviewed' });
    }
    await save(plan);
  }
  assert.equal(plan.targetHash, target(), 'Publication account/database changed.');
  assert.equal(plan.actorId, user.userId);
  if (process.argv.includes('--apply')) for (const row of plan.products) {
    if (row.status === 'confirmed') continue;
    await actor();
    if (!row.revisionId) {
      const [[state]] = await pool.query('SELECT s.latest_revision_id AS id,r.input_json AS inputJson FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id WHERE s.product_id=?', [row.productId]);
      if (Number(state.id) !== row.beforeRevision.id) {
        assert.ok(same(parse(state.inputJson), row.preview.input), 'Local pricing changed after review.');
        row.revisionId = Number(state.id); // Recover a committed local save before another write.
      } else {
        const saved = await saveEnterprisePricingDraft(row.productId, row.preview.input, row.beforeRevision.id, user);
        assertTarget(saved, row.packageId, row.costCents); row.revisionId = saved.revisionId;
      }
      row.status = 'saved'; await save(plan);
    }
    const [[current]] = await pool.query('SELECT status FROM enterprise_pricing_revisions WHERE id=?', [row.revisionId]);
    if (['pending', 'local-preview'].includes(current.status)) await approveEnterprisePricingRevision(row.revisionId, user);
    if (!row.auditId) {
      const audit = await createProductSyncAudit({ platforms: ['localline', 'square'], productIds: [row.productId], productScope: 'selected', vendorGroup: 'all',
        enterpriseRevisionId: row.revisionId, publicationScope: 'enterprise-selected-prices', productEditorSync: true, incoming: false }, user);
      row.auditId = audit.id; await save(plan);
    }
    let audit;
    for (let i = 0; i < 300; i++) {
      audit = await getProductSyncAudit(row.auditId); if (audit.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(audit.status, 'completed', audit.error || 'Audit incomplete.');
    const actions = (await listProductSyncActions(row.auditId, { direction: 'outgoing', pageSize: 100 })).rows;
    assert.equal(actions.length, 2); assert.ok(actions.every(a => ['changed', 'synced'].includes(a.status)), JSON.stringify(actions.map(a => ({ platform: a.platform, status: a.status, message: a.message }))));
    row.actionIds = actions.map(a => a.id); row.comparison = actions.map(a => ({ platform: a.platform, status: a.status, display: a.display })); await save(plan);
    if (!row.releaseId) {
      const existing = await productSyncActionRelease(row.auditId, row.actionIds[0]);
      const release = existing || await createProductSyncRelease({ auditId: row.auditId, actionIds: row.actionIds, localWorkerOnly: true,
        name: `${row.name} — $10/bag Square, $9 FF, each` }, user);
      row.releaseId = release.id; await save(plan);
    }
    const release = await runProductSyncRelease(row.releaseId, { user, allowFuture: true });
    row.release = release; row.status = release.status === 'completed' ? 'confirmed' : 'attention'; await save(plan);
    assert.equal(release.status, 'completed', JSON.stringify(release.actions.map(a => ({ platform: a.platform, status: a.status, message: a.message }))));
    const saved = (await readSavedEnterprisePricing(pool, [row.productId])).get(row.productId);
    assertTarget(saved, row.packageId, row.costCents);
    console.log(JSON.stringify({ product: row.name, status: row.status, revisionId: row.revisionId, auditId: row.auditId, releaseId: row.releaseId, square: '$10 per bag / each', ffPackage: '$9' }));
  }
  console.log(JSON.stringify({ receipt: file.pathname, products: plan.products.map(row => ({ name: row.name, status: row.status, squareCents: row.preview.output.packages[0].squareVariationCents,
    ffPackageCents: row.preview.output.packages[0].localLineRegularCents, unit: row.preview.input.pricingUnit, packageCostCents: row.costCents })) }, null, 2));
} finally { await pool.end(); }
