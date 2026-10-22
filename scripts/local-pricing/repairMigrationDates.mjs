// Repair the old host-timezone conversion only in untouched local migration revisions.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from './env.mjs';
import { pricingUtcDate } from '../../apps/api/lib/enterprisePricingDates.js';
installLocalEnvironment();
assertLocalDatabase();
installLoopbackNetworkGuard();
const { getPool } = await import('../../apps/api/db.js');
const { ensureEnterprisePricingSchema } = await import('../../apps/api/lib/enterprisePricingSchema.js');
const { previewEnterprisePricing } = await import('../../apps/api/lib/enterprisePricingService.js');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const pool = getPool();
let connection;
try {
  await ensureEnterprisePricingSchema();
  connection = await pool.getConnection();
  await connection.beginTransaction();
  const [rows] = await connection.query(`SELECT r.id, r.product_id, r.input_json, r.output_json, m.plan_json
    FROM enterprise_pricing_migration_rows m
    JOIN enterprise_pricing_revisions r ON r.id=m.revision_id
    JOIN enterprise_pricing_product_state s ON s.product_id=r.product_id AND s.latest_revision_id=r.id
    JOIN enterprise_pricing_buy_price_drafts b ON b.product_id=r.product_id AND b.revision=1
    WHERE r.status IN ('pending','local-preview') AND m.status<>'rolled-back'
      AND NOT EXISTS (SELECT 1 FROM enterprise_pricing_publications p WHERE p.revision_id=r.id)
    FOR UPDATE`);
  const repairs = [];
  for (const row of rows) {
    const before = parse(row.input_json), plan = parse(row.plan_json);
    const original = plan.input;
    if (!original || before.purchaseCosts.length !== original.purchaseCosts.length) continue;
    const after = structuredClone(before);
    after.priceEffectiveAt = pricingUtcDate(original.priceEffectiveAt, 'Migration date');
    after.purchaseCosts = before.purchaseCosts.map((cost, index) => ({ ...cost,
      effectiveAt: pricingUtcDate(original.purchaseCosts[index].effectiveAt, 'Migration cost date') }));
    if (isDeepStrictEqual(before, after)) continue;
    // The original import was run on the Mac in UTC-7. Refuse any other discrepancy.
    const shift = (a, b) => Date.parse(a.replace(' ', 'T') + 'Z') - Date.parse(b.replace(' ', 'T') + 'Z');
    if (shift(before.priceEffectiveAt, after.priceEffectiveAt) !== 7 * 3600000 ||
        before.purchaseCosts.some((cost, index) => shift(cost.effectiveAt, after.purchaseCosts[index].effectiveAt) !== 7 * 3600000)) continue;
    const preview = await previewEnterprisePricing(row.product_id, after);
    assert.deepEqual(preview.input, after);
    assert.deepEqual(preview.output, parse(row.output_json), `Price must stay unchanged for ${row.product_id}`);
    repairs.push({ revisionId: row.id, productId: row.product_id, before, after });
    await connection.query('UPDATE enterprise_pricing_revisions SET input_json=? WHERE id=?', [JSON.stringify(after), row.id]);
  }
  if (repairs.length) await fs.writeFile(new URL(`../../.local-pricing/date-repair-${Date.now()}.json`, import.meta.url),
    JSON.stringify({ database: process.env.STORE_DB_DATABASE, repairs }, null, 2), { mode: 0o600, flag: 'wx' });
  await connection.commit();
  console.log(`Corrected UTC dates in ${repairs.length} untouched local migration revisions. Prices unchanged.`);
} catch (error) { if (connection) await connection.rollback(); throw error; }
finally { connection?.release(); await pool.end(); }
