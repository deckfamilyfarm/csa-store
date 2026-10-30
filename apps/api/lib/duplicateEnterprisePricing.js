// A duplicate gets independent local pricing, never the source's approvals,
// publications, channel mappings, sales, or inventory.
export function duplicatePricingSnapshot(revision, sourcePackages, newPackages) {
  if (revision.input.packages.length !== sourcePackages.length || sourcePackages.length !== newPackages.length) throw new Error('Package definitions changed. Refresh before duplicating.');
  const mapping = new Map(sourcePackages.map((pkg, index) => [Number(pkg.id), Number(newPackages[index]?.id)]));
  const remap = packages => packages.map(pkg => {
    const packageId = mapping.get(Number(pkg.packageId));
    if (!packageId) throw new Error('Package definitions changed. Refresh before duplicating.');
    return { ...pkg, packageId };
  });
  const input = structuredClone(revision.input), output = structuredClone(revision.output);
  input.packages = remap(input.packages); input.saleBp = 0;
  output.packages = remap(output.packages).map(pkg => ({ ...pkg, localLineSaleCents: pkg.localLineRegularCents,
    localLineBasketCents: Object.fromEntries(['guest','herdShare','snap'].map(key => [key,pkg.localLineRegularCents])) }));
  output.saleBp = 0;
  return { input, output };
}
export async function copyEnterprisePricing(connection, sourceId, created, sourcePackages, user) {
  const [rows] = await connection.query(`SELECT r.* FROM enterprise_pricing_revisions r
    JOIN enterprise_pricing_product_state s ON s.latest_revision_id=r.id WHERE s.product_id=?`, [sourceId]);
  if (!rows.length) return;
  const actor = Number(user?.userId || user?.adminId);
  if (!Number.isSafeInteger(actor) || actor <= 0) throw new Error('An authenticated pricing editor is required.');
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
  const { input, output } = duplicatePricingSnapshot({ input: parse(rows[0].input_json), output: parse(rows[0].output_json) }, sourcePackages, created.packages);
  const [inserted] = await connection.query(`INSERT INTO enterprise_pricing_revisions
    (product_id,settings_version_id,status,input_json,output_json,editor_id,created_at,active_at)
    VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [created.productId,rows[0].settings_version_id,
      process.env.CSA_LOCAL_ONLY === 'true' ? 'local-preview' : 'pending',JSON.stringify(input),JSON.stringify(output),actor]);
  const revisionId = inserted.insertId;
  await connection.query(`INSERT INTO enterprise_pricing_product_state (product_id,latest_revision_id,active_revision_id,updated_at)
    VALUES (?,?,?,UTC_TIMESTAMP())`,[created.productId,revisionId,revisionId]);
  for (const cost of input.purchaseCosts) await connection.query(`INSERT INTO enterprise_purchase_cost_history
    (product_id,purchasing_enterprise_id,cost,effective_at,documentation_ref,revision_id,recorded_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())`,
    [created.productId,cost.enterpriseId,cost.cost,cost.effectiveAt,cost.documentationRef,revisionId]);
  for (const price of output.wholesale || []) await connection.query(`INSERT INTO enterprise_wholesale_price_history
    (product_id,selling_enterprise_id,mode,price_cents,markup_bp,cost_enterprise_id,revision_id,recorded_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
    [created.productId,price.sellingEnterpriseId,price.mode,price.priceCents,price.markupBp??null,price.costEnterpriseId??null,revisionId]);
}
