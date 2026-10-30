// Recover the latest check for each exact pricing revision, including interrupted
// checks and release receipts. Older revisions must never authorize newer prices.
export async function readPricingPublicationAttempts(pool, revisionIds) {
  if (!revisionIds.length) return new Set();
  const [rows] = await pool.query(`SELECT DISTINCT a.platform,
    JSON_UNQUOTE(JSON_EXTRACT(au.options_json,'$.enterpriseRevisionId')) AS revisionId
    FROM product_sync_actions a JOIN product_sync_audits au ON au.id=a.audit_id
    WHERE JSON_UNQUOTE(JSON_EXTRACT(au.options_json,'$.enterpriseRevisionId')) IN (?)
      AND (JSON_EXTRACT(au.options_json,'$.productEditorSync')=true
        OR EXISTS(SELECT 1 FROM product_sync_release_actions ra WHERE ra.action_id=a.id))`, [revisionIds.map(String)]);
  return new Set(rows.map(row=>`${row.revisionId}:${row.platform}`));
}

export async function readEnterpriseReviewChecks(pool, revisionIds) {
  if (!revisionIds.length) return new Map();
  const [audits] = await pool.query(`SELECT a.id,a.status,a.error_message AS error,
    JSON_UNQUOTE(JSON_EXTRACT(a.options_json,'$.enterpriseRevisionId')) AS revisionId
    FROM product_sync_audits a JOIN (
      SELECT MAX(id) AS id FROM product_sync_audits
      WHERE JSON_UNQUOTE(JSON_EXTRACT(options_json,'$.enterpriseRevisionId')) IN (?)
      GROUP BY JSON_UNQUOTE(JSON_EXTRACT(options_json,'$.enterpriseRevisionId'))
    ) latest ON latest.id=a.id`, [revisionIds.map(String)]);
  if (!audits.length) return new Map();
  const [actions] = await pool.query(`SELECT a.*,ra.release_id AS releaseId,ra.status AS releaseStatus,
    ra.message AS releaseMessage,r.status AS publicationStatus
    FROM product_sync_actions a LEFT JOIN product_sync_release_actions ra ON ra.action_id=a.id
    LEFT JOIN product_sync_releases r ON r.id=ra.release_id
    WHERE a.audit_id IN (?) AND a.direction='outgoing' ORDER BY a.id`, [audits.map(a => a.id)]);
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
  return new Map(audits.map(audit => [Number(audit.revisionId), {
    auditId: Number(audit.id), status: audit.status, error: audit.error,
    actions: actions.filter(a => Number(a.audit_id) === Number(audit.id)).map(a => {
      const data = parse(a.data_json) || {};
      return { id: Number(a.id), auditId: Number(a.audit_id), productId: Number(a.product_id),
        platform: a.platform, status: a.status, direction: a.direction, kind: data.kind,
        enterpriseRevisionId: data.enterpriseRevisionId, packageName: data.packageName,
        message: data.message, warnings: data.warnings, display: data.display,
        result: parse(a.result_json), released: Boolean(a.released_at), releaseId: a.releaseId,
        releaseStatus: a.releaseStatus, releaseMessage: a.releaseMessage, publicationStatus: a.publicationStatus };
    })
  }]));
}
