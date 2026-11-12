// Apply the user's reviewed image-only audit through durable Product Sync releases.
// --apply is explicit; uncertain releases are found by persisted action ID on retry.
import fs from 'node:fs/promises';
import { getPool } from '../db.js';
import { getProductSyncAudit, listProductSyncActions, createProductSyncRelease, runProductSyncRelease } from '../lib/productSync.js';

const auditId = Number(process.argv.find(arg => arg.startsWith('--audit-id='))?.split('=')[1]);
if (!Number.isSafeInteger(auditId) || auditId < 1) throw new Error('Provide --audit-id=ID for a completed, reviewed image-only audit.');
const pool = getPool();
const user = { adminRoles: ['square_push'] };
try {
  const audit = await getProductSyncAudit(auditId);
  if (!audit?.options.squareImagesOnly || !['completed', 'partial'].includes(audit.status)) throw new Error('A completed Square image review is required.');
  const rows = []; let page = 1, result;
  do {
    result = await listProductSyncActions(auditId, { status: 'all', page, pageSize: 100 });
    rows.push(...result.rows); page++;
  } while ((page - 1) * 100 < result.productCount);
  if (rows.some(row => row.platform !== 'square' || row.kind !== 'image')) throw new Error('This audit contains other publication types.');
  const [existing] = await pool.query(`SELECT DISTINCT ra.release_id AS id FROM product_sync_release_actions ra
    JOIN product_sync_actions a ON a.id=ra.action_id WHERE a.audit_id=?`, [auditId]);
  const [conflicts] = await pool.query(`SELECT DISTINCT a.product_id AS id FROM product_sync_release_actions ra
    JOIN product_sync_actions a ON a.id=ra.action_id JOIN product_sync_releases r ON r.id=ra.release_id
    WHERE a.audit_id<>? AND r.status<>'cancelled' AND ra.status IN ('pending','working','failed','held')
    UNION SELECT i.product_id AS id FROM pricelist_change_items i JOIN pricelist_change_batches b ON b.id=i.batch_id
    WHERE b.status IN ('scheduled','running') AND i.status IN ('pending','local_applied')`, [auditId]);
  const heldIds = new Set(conflicts.map(row => Number(row.id)));
  const eligible = rows.filter(row => row.status === 'changed' && !row.released && !heldIds.has(row.productId));
  console.log(JSON.stringify({ auditId, eligible: eligible.length, existingReleases: existing.map(row => row.id),
    heldByOtherReleases: rows.filter(row => heldIds.has(row.productId)).map(row => row.productName),
    apply: process.argv.includes('--apply') }));
  if (process.argv.includes('--apply')) {
    const releases = [];
    for (const release of existing) releases.push(await runProductSyncRelease(release.id, { user, allowFuture: true }));
    if (eligible.length) {
      const created = await createProductSyncRelease({ auditId, actionIds: eligible.map(row => row.id),
        name: 'Saved product photos — all Square locations', localWorkerOnly: true }, user);
      console.log(JSON.stringify({ releaseId: created.id, status: 'scheduled', updates: eligible.length }));
      releases.push(await runProductSyncRelease(created.id, { user, allowFuture: true }));
    }
    const directory = new URL(`../../../reports/square-product-images-${new Date().toISOString().slice(0, 10)}/`, import.meta.url);
    await fs.mkdir(directory, { recursive: true });
    const receipt = new URL(`audit-${auditId}-publication.json`, directory);
    await fs.writeFile(receipt, JSON.stringify({ auditId, releases, finishedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(JSON.stringify({ receipt: receipt.pathname, releases: releases.map(row => ({ id: row.id, status: row.status,
      completed: row.actions.filter(a => a.status === 'completed').length,
      unfinished: row.actions.filter(a => a.status !== 'completed').map(a => ({ productName: a.productName, status: a.status, message: a.message })) })) }, null, 2));
  }
} finally { await pool.end(); }
