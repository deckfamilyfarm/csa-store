import { getPool } from "../db.js";
import { ensureProductSyncSchema, isoUtc, parseJson } from "./productSyncSchema.js";
import { PRICELIST_PENDING_REMOTE_APPLY_SQL } from "./productWorkspaceFilters.js";

export function localLineMatchRow(row, packages = [], latest = null) {
  const remote = parseJson(row.rawJson, {});
  const action = latest ? parseJson(latest.data_json, {}) : null;
  const latestResult = latest ? parseJson(latest.result_json, {}) : null;
  const remotePackages = new Map((remote.packages || []).map(pkg => [Number(pkg.id), pkg]));
  return {
    id: Number(row.id), name: row.name, vendorName: row.vendorName || "", categoryName: row.categoryName,
    localLineProductId: Number(row.localLineProductId) || null,
    localLineName: remote.name || null, remoteDeleted: Boolean(remote.is_deleted),
    pending: Boolean(Number(row.pending)), cachedAt: isoUtc(row.cachedAt),
    lastCheckedAt: isoUtc(row.lastCheckedAt), lastPublishedAt: isoUtc(row.lastPublishedAt),
    latestComparison: action ? { id: Number(latest.id), auditId: Number(latest.audit_id), status: latest.status,
      checkedAt: isoUtc(latest.checkedAt), message: latestResult?.message || action.message || "", kind: action.kind } : null,
    publicationStatus: row.publicationStatus || null,
    packages: packages.map(pkg => {
      const linked = remotePackages.get(Number(pkg.localLinePackageId));
      return { id: Number(pkg.id), name: pkg.name, localLinePackageId: Number(pkg.localLinePackageId) || null,
        localLineName: linked?.name || pkg.localLineName || null, localPrice: pkg.price == null ? null : Number(pkg.price),
        localLinePrice: linked?.package_price ?? linked?.unit_price ?? null };
    })
  };
}

// Local reads only: opening the connection list never starts a remote sync.
export async function localLineMatches() {
  await ensureProductSyncSchema();
  const pool = getPool();
  const [rows] = await pool.query(`SELECT p.id, p.name, v.name AS vendorName, c.name AS categoryName,
    lm.local_line_product_id AS localLineProductId, lm.raw_json AS rawJson,
    ${PRICELIST_PENDING_REMOTE_APPLY_SQL} AS pending,
    DATE_FORMAT(lm.last_synced_at, '%Y-%m-%d %H:%i:%s') AS cachedAt,
    DATE_FORMAT(checks.checked_at, '%Y-%m-%d %H:%i:%s') AS lastCheckedAt,
    DATE_FORMAT(GREATEST(COALESCE(published.completed_at, '1970-01-01'), COALESCE(pp.remote_synced_at, '1970-01-01')), '%Y-%m-%d %H:%i:%s') AS lastPublishedAt,
    active.status AS publicationStatus
    FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN local_line_product_meta lm ON lm.product_id=p.id LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id
    LEFT JOIN (SELECT a.product_id, MAX(au.finished_at) AS checked_at FROM product_sync_actions a
      JOIN product_sync_audits au ON au.id=a.audit_id WHERE a.platform='localline' AND a.direction='outgoing'
      AND au.status IN ('completed','partial') AND JSON_UNQUOTE(JSON_EXTRACT(a.data_json,'$.kind'))='update'
      AND a.status IN ('changed','synced','applied','held') GROUP BY a.product_id) checks ON checks.product_id=p.id
    LEFT JOIN (SELECT a.product_id, MAX(ra.completed_at) AS completed_at FROM product_sync_release_actions ra
      JOIN product_sync_actions a ON a.id=ra.action_id WHERE a.platform='localline' AND ra.status='completed'
      GROUP BY a.product_id) published ON published.product_id=p.id
    LEFT JOIN (SELECT a.product_id, CASE WHEN SUM(ra.status='working')>0 THEN 'working'
      WHEN SUM(ra.status='pending')>0 THEN 'pending' ELSE 'attention' END AS status
      FROM product_sync_release_actions ra JOIN product_sync_actions a ON a.id=ra.action_id
      JOIN product_sync_releases r ON r.id=ra.release_id WHERE a.platform='localline' AND r.status<>'cancelled'
      AND ra.status IN ('pending','working','failed','held') GROUP BY a.product_id) active ON active.product_id=p.id
    WHERE COALESCE(p.is_deleted,0)=0 AND LOWER(TRIM(COALESCE(c.name,'')))<>'membership' ORDER BY p.name,p.id`);
  const [packages] = await pool.query(`SELECT p.id, p.product_id AS productId, p.name, p.price,
    lm.local_line_package_id AS localLinePackageId, lm.live_name AS localLineName
    FROM packages p LEFT JOIN local_line_package_meta lm ON lm.package_id=p.id ORDER BY p.product_id,p.id`);
  const [latest] = await pool.query(`SELECT a.*, DATE_FORMAT(au.finished_at,'%Y-%m-%d %H:%i:%s') AS checkedAt
    FROM product_sync_actions a JOIN product_sync_audits au ON au.id=a.audit_id
    JOIN (SELECT MAX(a.id) AS id FROM product_sync_actions a JOIN product_sync_audits au ON au.id=a.audit_id
      WHERE a.platform='localline' AND a.direction='outgoing' AND au.status IN ('completed','partial')
      GROUP BY a.product_id) newest ON newest.id=a.id`);
  const byProduct = new Map();
  for (const pkg of packages) { const id = Number(pkg.productId); if (!byProduct.has(id)) byProduct.set(id, []); byProduct.get(id).push(pkg); }
  const byAction = new Map(latest.map(row => [Number(row.product_id), row]));
  return { rows: rows.map(row => localLineMatchRow({ ...row, lastPublishedAt: row.lastPublishedAt?.startsWith('1970-01-01') ? null : row.lastPublishedAt }, byProduct.get(Number(row.id)), byAction.get(Number(row.id)))) };
}
