// One-time transition for already saved prices in the isolated local database.
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from './env.mjs';
installLocalEnvironment(); assertLocalDatabase(); installLoopbackNetworkGuard();
const { getPool } = await import('../../apps/api/db.js');
const { getEnterprisePricingProduct, saveEnterprisePricingDraft } = await import('../../apps/api/lib/enterprisePricingService.js');
const pool = getPool();
try {
  const [[user]] = await pool.query("SELECT id FROM users WHERE username='local.admin'");
  if (!user) throw new Error('Local test administrator is missing.');
  const [rows] = await pool.query(`SELECT r.product_id AS productId FROM enterprise_pricing_product_state s
    JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id WHERE r.status='pending'`);
  let activated = 0;
  const held = [];
  for (const row of rows) {
    try {
      const detail = await getEnterprisePricingProduct(row.productId);
      if (detail.latest.status !== 'pending') continue;
      await saveEnterprisePricingDraft(row.productId, { ...detail.suggestedInput, priceEffectiveAt: new Date().toISOString() },
        detail.latest.id, { userId: user.id }, detail.buyPrice?.revision || 0);
      activated++;
    } catch (error) { held.push({ productId: row.productId, reason: error.message }); }
  }
  console.log(JSON.stringify({ activated, held, externalPublications: 0 }));
} finally { await pool.end(); }
