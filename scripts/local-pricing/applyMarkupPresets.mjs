// Local-only campaign: version settings, preserve pricing history, and never publish.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from './env.mjs';
import { markupPresetAssignment, REQUESTED_MARKUPS } from './markupPresetPlan.mjs';
installLocalEnvironment(); assertLocalDatabase(); installLoopbackNetworkGuard();
const { getPool } = await import('../../apps/api/db.js');
const { getPricingSettings, getEnterprisePricingProduct, previewEnterprisePricing, saveEnterprisePricingDraft } = await import('../../apps/api/lib/enterprisePricingService.js');
const { calculateEnterprisePricing } = await import('../../apps/api/lib/enterprisePricingEngine.js');
const { readMigrationCatalog } = await import('../../apps/api/lib/enterprisePricingMigration.js');
const { deriveLegacyPricingEvidence } = await import('../../apps/api/lib/legacyPricingEvidence.js');
const pool = getPool();
const apply = process.argv.includes('--apply');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reportPath = new URL(`../../.local-pricing/markup-presets-${Date.now()}-${apply ? 'apply' : 'preview'}.json`, import.meta.url);
const report = { database: process.env.STORE_DB_DATABASE, createdAt: new Date().toISOString(), apply, externalPublications: 0, products: [], excluded: [], errors: [] };
const writeReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
try {
  const current = await getPricingSettings();
  const { id: oldSettingsId, ...oldSettings } = current;
  const proposed = { ...oldSettings, markupBp: { ...oldSettings.markupBp, ...REQUESTED_MARKUPS } };
  report.oldSettings = current; report.newSettings = proposed;
  const [[user]] = await pool.query("SELECT id FROM users WHERE username='local.admin'");
  if (!user) throw new Error('Local administrator is missing.');
  const [pending] = await pool.query("SELECT id FROM enterprise_pricing_settings_versions WHERE status='pending'");
  if (pending.length) throw new Error('An existing settings proposal must be resolved first.');
  const catalog = await readMigrationCatalog(pool);
  const [states] = await pool.query(`SELECT s.product_id AS productId,r.input_json AS inputJson,r.output_json AS outputJson
    FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id`);
  const latestByProduct = new Map(states.map(row => [Number(row.productId), { input:parse(row.inputJson), output:parse(row.outputJson) }]));
  // Verify that excluded products' prices and revision pointers survive this operation unchanged.
  const excludedIds = catalog.filter(r => /deposit|membership/i.test(r.product.name) || /^membership$/i.test(r.product.categoryName || '')).map(r => r.product.id);
  const excludedSnapshot = async () => {
    const [states] = excludedIds.length ? await pool.query(`SELECT p.id,s.latest_revision_id,s.active_revision_id,b.price AS buyPrice,b.revision AS buyRevision
      FROM products p LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id
      LEFT JOIN enterprise_pricing_buy_price_drafts b ON b.product_id=p.id WHERE p.id IN (?) ORDER BY p.id`, [excludedIds]) : [[]];
    const records = (await readMigrationCatalog(pool)).filter(r => excludedIds.includes(r.product.id));
    return hash({ states, records });
  };
  const excludedBefore = await excludedSnapshot();
  for (const record of catalog) {
    if (excludedIds.includes(record.product.id)) { report.excluded.push({ id: record.product.id, name: record.product.name }); continue; }
    const latest = latestByProduct.get(Number(record.product.id));
    const evidence = deriveLegacyPricingEvidence(record);
    const target = markupPresetAssignment({ ...record.product, input: latest?.input, output: latest?.output,
      sourceMarkupBp: evidence?.markupPercent == null ? null : Math.round(evidence.markupPercent * 100) });
    if (!target) continue;
    const detail = await getEnterprisePricingProduct(record.product.id);
    const entry = { id: record.product.id, name: record.product.name, vendor: record.product.vendorName, target,
      expectedRevisionId: detail.latest?.id || null, expectedBuyPriceRevision: detail.buyPrice?.revision || 0,
      before: detail.latest, status: 'planned' };
    report.products.push(entry);
    if (detail.latest && !['local-preview','active'].includes(detail.latest.status)) throw new Error(`${record.product.name}: resolve ${detail.latest.status} pricing before bulk repricing.`);
    const input = { ...structuredClone(detail.suggestedInput), markupCategory: target, customMarkupBp: null, priceEffectiveAt: new Date().toISOString() };
    try {
      const checked = await previewEnterprisePricing(record.product.id, input);
      const cost = checked.input.purchaseCosts.filter(row => Number(row.enterpriseId) === Number(checked.input.retailEnterpriseId) && row.effectiveAt <= checked.input.priceEffectiveAt)
        .sort((a,b) => b.effectiveAt.localeCompare(a.effectiveAt))[0];
      entry.input = checked.input;
      entry.after = { ...calculateEnterprisePricing({ ...checked.input, buyFromPrice: cost.cost }, proposed), wholesale: checked.output.wholesale };
      if (detail.latest?.input.markupCategory === target && detail.latest.input.customMarkupBp == null
          && JSON.stringify(detail.latest.output) === JSON.stringify(entry.after)) entry.status = 'unchanged';
    } catch (error) {
      if (detail.latest) throw new Error(`${record.product.name}: ${error.message}`);
      entry.status = 'needs-inputs'; entry.reason = error.message;
    }
  }
  writeReport();
  if (apply) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [active] = await connection.query("SELECT id FROM enterprise_pricing_settings_versions WHERE status='active' FOR UPDATE");
      if (active.length !== 1 || Number(active[0].id) !== oldSettingsId) throw new Error('Settings changed during preparation. Run preview again.');
      let settingsId = oldSettingsId;
      if (JSON.stringify(oldSettings) !== JSON.stringify(proposed)) {
        await connection.query("UPDATE enterprise_pricing_settings_versions SET status='superseded' WHERE id=?", [oldSettingsId]);
        const [inserted] = await connection.query(`INSERT INTO enterprise_pricing_settings_versions (status,settings_json,created_by,created_at)
          VALUES ('active',?,?,UTC_TIMESTAMP())`, [JSON.stringify(proposed),user.id]);
        settingsId = Number(inserted.insertId);
      }
      // No approval is invented: this activates only local test settings, with its actor and this report.
      report.settingsVersionId = settingsId;
      for (const entry of report.products.filter(row => row.status === 'needs-inputs')) {
        await connection.query('SELECT id FROM products WHERE id=? FOR UPDATE', [entry.id]);
        const [state] = await connection.query('SELECT latest_revision_id FROM enterprise_pricing_product_state WHERE product_id=? FOR UPDATE', [entry.id]);
        if (state[0]?.latest_revision_id) throw new Error(`${entry.name}: pricing was created during preparation.`);
        await connection.query(`INSERT INTO enterprise_pricing_markup_assignments (product_id,markup_category,assigned_by,assigned_at)
          VALUES (?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE markup_category=VALUES(markup_category),assigned_by=VALUES(assigned_by),assigned_at=VALUES(assigned_at)`, [entry.id,entry.target,user.id]);
        entry.assignmentSaved = true;
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    writeReport();
    for (const entry of report.products.filter(row => row.status === 'planned')) {
      try {
        const result = await saveEnterprisePricingDraft(entry.id, entry.input, entry.expectedRevisionId, { userId: user.id }, entry.expectedBuyPriceRevision);
        entry.status = 'saved'; entry.revisionId = result.revisionId;
        const verified = await getEnterprisePricingProduct(entry.id);
        if (verified.active?.id !== result.revisionId || verified.latest.input.markupCategory !== entry.target
            || verified.latest.input.customMarkupBp != null || verified.latest.output.appliedMarkupBp !== REQUESTED_MARKUPS[entry.target]) throw new Error('Local revision verification failed.');
      } catch (error) { entry.status = 'failed'; entry.error = error.message; report.errors.push({ id:entry.id, error:error.message }); }
      writeReport();
    }
    if (excludedBefore !== await excludedSnapshot()) throw new Error('Excluded deposit or membership data changed during the operation.');
    report.excludedVerifiedUnchanged = true;
  }
  report.summary = { assigned: report.products.length, byPreset: Object.fromEntries(Object.keys(REQUESTED_MARKUPS).map(key=>[key,report.products.filter(r=>r.target===key).length])),
    saved: report.products.filter(r=>r.status==='saved').length, unchanged: report.products.filter(r=>r.status==='unchanged').length,
    needsInputs: report.products.filter(r=>r.status==='needs-inputs').length, excluded:report.excluded.length, errors:report.errors.length };
  writeReport();
  console.log(JSON.stringify({ ...report.summary, settingsVersionId: report.settingsVersionId, externalPublications:0, report:reportPath.pathname },null,2));
  if (report.errors.length) process.exitCode=1;
} catch (error) { report.errors.push({ error:error.message }); writeReport(); console.error(error.message); process.exitCode=1; }
finally { await pool.end(); }
