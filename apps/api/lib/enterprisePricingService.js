import { getPool } from "../db.js";
import { calculateEnterprisePricing, scaledInteger, roundRatio, DEFAULT_PRICING_SETTINGS } from "./enterprisePricingEngine.js";
import { ensureEnterprisePricingSchema } from "./enterprisePricingSchema.js";
import { computeProductPricingSnapshot } from "./productPricing.js";
import { deriveLegacyPricingEvidence } from "./legacyPricingEvidence.js";
import { pricingUtcDate as validDate } from "./enterprisePricingDates.js";

const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
const id = (value, label = "ID") => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  return number;
};
const failure = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const actorId = user => id(user?.userId || user?.adminId, "User ID");

export async function getPricingSettings() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query("SELECT * FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1");
  const value = parse(rows[0].settings_json);
  return { ...DEFAULT_PRICING_SETTINGS, ...value,
    markupBp: { ...DEFAULT_PRICING_SETTINGS.markupBp, ...(value.markupBp || {}) },
    squareDefaults: { ...DEFAULT_PRICING_SETTINGS.squareDefaults, ...(value.squareDefaults || {}) },
    id: Number(rows[0].id) };
}

function validateSettings(value) {
  if (!value || typeof value !== "object") failure("Pricing settings are required.");
  const localLineDiscountBp = Number(value.localLineDiscountBp);
  const squareIncrementCents = Number(value.squareIncrementCents);
  if (!Number.isSafeInteger(localLineDiscountBp) || localLineDiscountBp < 0 || localLineDiscountBp > 10000) failure("Local Line discount must be between 0% and 100%.");
  if (!Number.isSafeInteger(squareIncrementCents) || squareIncrementCents < 1 || squareIncrementCents > 10000) failure("Square rounding increment is invalid.");
  const markupBp = {};
  for (const key of ["highlyPerishable", "perishable", "shelfStable"]) {
    const amount = Number(value.markupBp?.[key]);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000) failure(`${key} markup is invalid.`);
    markupBp[key] = amount;
  }
  const squareDefaults = Object.fromEntries(["deck", "hyland", "creamyCow", "other"].map(key => [key, value.squareDefaults?.[key] === true]));
  return { localLineDiscountBp, squareIncrementCents, markupBp, squareDefaults,
    requireDifferentApprover: value.requireDifferentApprover !== false };
}

export async function getPricingSettingsDraft() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query("SELECT * FROM enterprise_pricing_settings_versions WHERE status='pending' ORDER BY id DESC LIMIT 1");
  return rows.length ? { id: Number(rows[0].id), settings: parse(rows[0].settings_json), editorId: rows[0].created_by, createdAt: rows[0].created_at } : null;
}

async function settingsImpact(proposed, connection = getPool()) {
  const [rows] = await connection.query(`SELECT p.id, p.name, r.input_json AS inputJson, r.output_json AS outputJson
    FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id
    JOIN products p ON p.id=s.product_id ORDER BY p.name, p.id`);
  return rows.map(row => {
    const input = parse(row.inputJson);
    const costs = input.purchaseCosts || [];
    const cost = priceAt(costs, input.retailEnterpriseId, input.priceEffectiveAt);
    if (!cost) return { productId: row.id, product: row.name, blocked: "Validated purchase cost is missing." };
    const before = parse(row.outputJson);
    try {
      const after = calculateEnterprisePricing({ ...input, buyFromPrice: cost.cost }, proposed);
      return { productId: row.id, product: row.name, before: { square: before.squareUnitCents, csa: before.csaUnitCents },
        after: { square: after.squareUnitCents, csa: after.csaUnitCents },
        squareOverride: Boolean(input.squareOverride), csaOverride: Boolean(input.csaOverride),
        changed: before.squareUnitCents !== after.squareUnitCents || before.csaUnitCents !== after.csaUnitCents ||
          JSON.stringify(before.packages) !== JSON.stringify(after.packages) };
    } catch (error) {
      return { productId: row.id, product: row.name, blocked: error.message,
        squareOverride: Boolean(input.squareOverride), csaOverride: Boolean(input.csaOverride) };
    }
  }).filter(row => row.blocked || row.changed);
}

export async function previewPricingSettings(value) {
  await ensureEnterprisePricingSchema();
  const settings = validateSettings(value);
  return { settings, affected: await settingsImpact(settings) };
}

export async function savePricingSettingsDraft(value, user) {
  const preview = await previewPricingSettings(value);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [pending] = await connection.query("SELECT id FROM enterprise_pricing_settings_versions WHERE status='pending' FOR UPDATE");
    if (pending.length) failure("Review or reject the existing settings proposal first.", 409);
    const [result] = await connection.query(`INSERT INTO enterprise_pricing_settings_versions
      (status, settings_json, created_by, created_at) VALUES ('pending', ?, ?, UTC_TIMESTAMP())`, [JSON.stringify(preview.settings), actorId(user)]);
    await connection.commit();
    return { id: Number(result.insertId), ...preview };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function approvePricingSettingsDraft(draftId, user) {
  await ensureEnterprisePricingSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT * FROM enterprise_pricing_settings_versions WHERE id=? FOR UPDATE", [id(draftId, "Settings version")]);
    if (!rows.length || rows[0].status !== "pending") failure("Settings proposal is no longer pending.", 409);
    const existing = await getPricingSettings();
    if (existing.requireDifferentApprover && actorId(user) === Number(rows[0].created_by)) failure("A different pricing administrator must approve this settings change.", 403);
    const settings = validateSettings(parse(rows[0].settings_json));
    const [unfinished] = await connection.query(`SELECT r.id FROM enterprise_pricing_product_state s
      JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
      WHERE r.status IN ('pending','approved','partial') LIMIT 1`);
    if (unfinished.length) failure("Resolve pending and partially published product pricing before activating new global settings.", 409);
    const [activeRows] = await connection.query(`SELECT s.product_id AS productId, s.latest_revision_id AS latestRevisionId,
      s.active_revision_id AS activeRevisionId, r.input_json AS inputJson, latest.status AS latestStatus
      FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id
      LEFT JOIN enterprise_pricing_revisions latest ON latest.id=s.latest_revision_id FOR UPDATE`);
    if (activeRows.some(row => Number(row.latestRevisionId) !== Number(row.activeRevisionId) && row.latestStatus !== "rejected")) failure("Resolve existing product proposals before changing global pricing rules.", 409);
    const affected = await settingsImpact(settings, connection);
    if (affected.some(row => row.blocked)) failure("Resolve missing purchase costs before approving settings.", 409);
    await connection.query("UPDATE enterprise_pricing_settings_versions SET status='superseded' WHERE status='active'");
    await connection.query("UPDATE enterprise_pricing_settings_versions SET status='active', approved_by=?, approved_at=UTC_TIMESTAMP() WHERE id=?", [actorId(user), draftId]);
    for (const row of activeRows.filter(row => affected.some(item => item.productId === row.productId))) {
      const input = parse(row.inputJson);
      const cost = priceAt(input.purchaseCosts, input.retailEnterpriseId, input.priceEffectiveAt);
      const output = calculateEnterprisePricing({ ...input, buyFromPrice: cost.cost }, settings);
      output.wholesale = parse((await connection.query("SELECT output_json AS outputJson FROM enterprise_pricing_revisions WHERE id=?", [row.activeRevisionId]))[0][0].outputJson).wholesale || [];
      const [result] = await connection.query(`INSERT INTO enterprise_pricing_revisions
        (product_id, settings_version_id, status, input_json, output_json, editor_id, created_at)
        VALUES (?, ?, 'pending', ?, ?, ?, UTC_TIMESTAMP())`, [row.productId, draftId, JSON.stringify(input), JSON.stringify(output), Number(rows[0].created_by)]);
      await connection.query("UPDATE enterprise_pricing_product_state SET latest_revision_id=?, updated_at=UTC_TIMESTAMP() WHERE product_id=?", [Number(result.insertId), row.productId]);
    }
    await connection.commit();
    return { id: Number(draftId), status: "active", pendingProductCount: affected.length };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function listPricingEnterprises() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query("SELECT id, code, name FROM enterprise_pricing_enterprises ORDER BY id");
  return rows;
}

async function productRecord(productId, connection = getPool()) {
  const [rows] = await connection.query(`SELECT p.id, p.name, p.vendor_id AS vendorId, p.category_id AS categoryId,
    v.name AS vendorName, c.name AS categoryName, p.is_deleted AS isDeleted,
    (SELECT COUNT(*) FROM square_variation_links l WHERE l.product_id=p.id AND l.approved_at IS NOT NULL) AS approvedSquareLinks,
    (SELECT local_line_product_id FROM local_line_product_meta m WHERE m.product_id=p.id LIMIT 1) AS localLineProductId
    FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?`, [productId]);
  if (!rows.length || Number(rows[0].isDeleted)) failure("Product was not found.", 404);
  if (!rows[0].vendorId || !String(rows[0].vendorName || "").trim()) failure("A named vendor is required before pricing this product.");
  return rows[0];
}

async function packagesFor(productId, connection = getPool()) {
  const [rows] = await connection.query(`SELECT p.id AS packageId, p.name, p.price, p.num_of_items AS quantity,
    m.avg_package_weight AS cachedWeight, m.local_line_package_id AS localLinePackageId
    FROM packages p LEFT JOIN local_line_package_meta m ON m.package_id=p.id
    WHERE p.product_id=? ORDER BY p.id`, [productId]);
  return rows;
}

async function revisionFor(productId, which = "latest", connection = getPool()) {
  const column = which === "active" ? "active_revision_id" : "latest_revision_id";
  const [rows] = await connection.query(`SELECT r.* FROM enterprise_pricing_product_state s
    JOIN enterprise_pricing_revisions r ON r.id=s.${column} WHERE s.product_id=?`, [productId]);
  return rows.length ? revisionView(rows[0]) : null;
}

function revisionView(row) {
  return {
    id: Number(row.id), productId: Number(row.product_id), settingsVersionId: Number(row.settings_version_id),
    status: row.status, input: parse(row.input_json), output: parse(row.output_json),
    editorId: Number(row.editor_id), approverId: row.approver_id ? Number(row.approver_id) : null,
    createdAt: row.created_at, approvedAt: row.approved_at, activeAt: row.active_at
  };
}

export async function listEnterprisePricingProducts({ search = "", vendorId = null, status = "", pricingUnit = "", markupCategory = "", square = "", sort = "name", sortDirection = "asc", limit = 100, offset = 0 } = {}) {
  await ensureEnterprisePricingSchema();
  const where = ["COALESCE(p.is_deleted, 0)=0", "LOWER(COALESCE(c.name,'')) <> 'membership'"];
  const params = [];
  if (search) { where.push("(p.name LIKE ? OR v.name LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  if (vendorId) { where.push("p.vendor_id=?"); params.push(id(vendorId, "Vendor ID")); }
  if (["lb", "each"].includes(pricingUnit)) { where.push("JSON_UNQUOTE(JSON_EXTRACT(r.input_json, '$.pricingUnit'))=?"); params.push(pricingUnit); }
  if (["highlyPerishable", "perishable", "shelfStable", "custom"].includes(markupCategory)) { where.push("JSON_UNQUOTE(JSON_EXTRACT(r.input_json, '$.markupCategory'))=?"); params.push(markupCategory); }
  if (["enabled", "disabled"].includes(square)) where.push(`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.input_json, '$.squareEnabled')), 'false')='${square === "enabled" ? "true" : "false"}'`);
  if (status === "unresolved") where.push("s.latest_revision_id IS NULL");
  else if (["pending", "approved", "active", "rejected", "partial", "local-preview"].includes(status)) { where.push("r.status=?"); params.push(status); }
  const from = `FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id
    LEFT JOIN enterprise_pricing_buy_price_drafts bp ON bp.product_id=p.id
    LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
    LEFT JOIN users editor ON editor.id=r.editor_id LEFT JOIN users approver ON approver.id=r.approver_id
    WHERE ${where.join(" AND ")}`;
  const [count] = await getPool().query(`SELECT COUNT(*) AS total ${from}`, params);
  // Keep sorting in SQL so it applies to every filtered product, not only the current page.
  const sortExpressions = {
    name: "p.name", vendor: "v.name", status: "COALESCE(r.status, 'unresolved')",
    unit: "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.input_json, '$.pricingUnit')), pp.unit_of_measure)",
    buyFrom: "COALESCE(bp.price * 10000, CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.buyFromTenThousandths')) AS SIGNED))",
    markup: "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.appliedMarkupBp')) AS SIGNED)",
    square: "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.squareUnitCents')) AS SIGNED)",
    csa: "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.csaUnitCents')) AS SIGNED)",
    llPackage: "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.packages[0].localLineRegularCents')) AS SIGNED)",
    wholesale: "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.output_json, '$.wholesale[0].priceCents')) AS SIGNED)",
    sale: `(SELECT MIN(ep.status) FROM enterprise_promotions ep JOIN packages sale_pkg ON sale_pkg.product_id=p.id
      WHERE ep.status IN ('approved','scheduled','active','partial','cancelling')
      AND JSON_CONTAINS(ep.input_json, CAST(sale_pkg.id AS CHAR), '$.packageIds'))`
  };
  const sortExpression = Object.hasOwn(sortExpressions, sort) ? sortExpressions[sort] : sortExpressions.name;
  const order = `${sortExpression} ${sortDirection === "desc" ? "DESC" : "ASC"}, p.name ASC, p.id ASC`;
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const [rows] = await getPool().query(`SELECT p.id, p.name, v.name AS vendorName, p.vendor_id AS vendorId,
    pp.unit_of_measure AS legacyPricingUnit, pp.source_unit_price AS legacyRetailUnitPrice,
    bp.price AS buyPrice, bp.revision AS buyPriceRevision, bp.purchasing_enterprise_id AS buyPriceEnterpriseId,
    s.latest_revision_id AS latestRevisionId, s.active_revision_id AS activeRevisionId,
    r.status, r.input_json AS inputJson, r.output_json AS outputJson,
    r.editor_id AS editorId, r.approver_id AS approverId, editor.username AS editorName, approver.username AS approverName,
    (SELECT COUNT(*) FROM square_variation_links l WHERE l.product_id=p.id AND l.approved_at IS NOT NULL) AS approvedSquareLinks
    ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, safeLimit, safeOffset]);
  const [vendors] = await getPool().query("SELECT DISTINCT v.id, v.name FROM products p JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE COALESCE(p.is_deleted,0)=0 AND LOWER(COALESCE(c.name,''))<>'membership' ORDER BY v.name");
  const productIds = rows.map(row => Number(row.id));
  const [packageRows] = productIds.length ? await getPool().query("SELECT id, product_id AS productId, name, price FROM packages WHERE product_id IN (?)", [productIds]) : [[]];
  let sampleEvidence = new Map();
  if (process.env.CSA_LOCAL_ONLY === "true" && productIds.length) {
    try {
      const [samples] = await getPool().query(`SELECT local_product_id AS productId,
        source_snapshot_json AS snapshotJson, sampled_at AS sampledAt
        FROM local_pricing_sample_sources WHERE local_product_id IN (?)`, [productIds]);
      sampleEvidence = new Map(samples.map(row => [Number(row.productId),
        deriveLegacyPricingEvidence(parse(row.snapshotJson), row.sampledAt)]));
    } catch (error) {
      if (error.code !== "ER_NO_SUCH_TABLE" && error.code !== "ER_BAD_FIELD_ERROR") throw error;
    }
  }
  const packageProducts = new Map(packageRows.map(row => [Number(row.id), Number(row.productId)]));
  if (productIds.length) {
    const [migratedSources] = await getPool().query(`SELECT product_id AS productId, source_json AS sourceJson,
      created_at AS capturedAt FROM enterprise_pricing_migration_rows
      WHERE product_id IN (?) AND status<>'rolled-back' ORDER BY id`, [productIds]);
    for (const source of migratedSources) sampleEvidence.set(Number(source.productId),
      deriveLegacyPricingEvidence(parse(source.sourceJson), source.capturedAt));
  }
  const revisionIds = rows.map(row => Number(row.latestRevisionId)).filter(Boolean);
  const [publicationRows] = revisionIds.length ? await getPool().query(
    "SELECT revision_id AS revisionId, platform, status FROM enterprise_pricing_publications WHERE revision_id IN (?)", [revisionIds]
  ) : [[]];
  const publicationsByRevision = new Map();
  for (const publication of publicationRows) {
    const revisionId = Number(publication.revisionId);
    if (!publicationsByRevision.has(revisionId)) publicationsByRevision.set(revisionId, []);
    publicationsByRevision.get(revisionId).push({ platform: publication.platform, status: publication.status });
  }
  const [saleRows] = productIds.length ? await getPool().query("SELECT status, input_json AS inputJson FROM enterprise_promotions WHERE status IN ('approved','scheduled','active','partial','cancelling')") : [[]];
  const saleByProduct = new Map();
  for (const sale of saleRows) for (const packageId of parse(sale.inputJson)?.packageIds || []) {
    const productId = packageProducts.get(Number(packageId));
    if (productId && (!saleByProduct.has(productId) || sale.status < saleByProduct.get(productId))) saleByProduct.set(productId, sale.status);
  }
  return { rows: rows.map(row => ({
    id: Number(row.id), name: row.name, vendorId: row.vendorId, vendorName: row.vendorName,
    status: row.status || "unresolved", latestRevisionId: row.latestRevisionId, activeRevisionId: row.activeRevisionId,
    editorId: row.editorId, approverId: row.approverId, editorName: row.editorName, approverName: row.approverName,
    saleStatus: saleByProduct.get(Number(row.id)) || null,
    approvedSquareLinks: Number(row.approvedSquareLinks), input: parse(row.inputJson), output: parse(row.outputJson),
    buyPrice: row.buyPrice == null ? null : { cents: Math.round(Number(row.buyPrice) * 100),
      revision: Number(row.buyPriceRevision), enterpriseId: Number(row.buyPriceEnterpriseId) },
    publications: publicationsByRevision.get(Number(row.latestRevisionId)) || [],
    sourceEvidence: sampleEvidence.get(Number(row.id)) || null,
    legacy: { pricingUnit: row.legacyPricingUnit === "lbs" ? "lb" : row.legacyPricingUnit || null,
      retailUnitPrice: row.legacyRetailUnitPrice,
      packages: packageRows.filter(pkg => Number(pkg.productId) === Number(row.id))
        .map(pkg => ({ name: pkg.name, storedPrice: pkg.price })) }
  })), total: Number(count[0].total), limit: safeLimit, offset: safeOffset, vendors,
    enterprises: await listPricingEnterprises() };
}

export async function enterprisePricingSummary() {
  await ensureEnterprisePricingSchema();
  const [statuses] = await getPool().query(`SELECT COALESCE(r.status, 'unresolved') AS status, COUNT(*) AS total
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
    WHERE COALESCE(p.is_deleted, 0)=0 AND LOWER(COALESCE(c.name,''))<>'membership'
    GROUP BY COALESCE(r.status, 'unresolved')`);
  const [problems] = await getPool().query(`SELECT status, COUNT(DISTINCT revision_id) AS total
    FROM enterprise_pricing_publications WHERE status IN ('blocked','failed','partial') GROUP BY status`);
  const [latest] = await getPool().query("SELECT MAX(verified_at) AS latestVerifiedAt FROM enterprise_pricing_publications WHERE status='verified'");
  const [sales] = await getPool().query(`SELECT status, COUNT(*) AS total FROM enterprise_promotions
    WHERE status IN ('pending','approved','scheduled','active','partial','cancelling') GROUP BY status`);
  return { byStatus: Object.fromEntries(statuses.map(row => [row.status, Number(row.total)])),
    problems: Object.fromEntries(problems.map(row => [row.status, Number(row.total)])),
    sales: Object.fromEntries(sales.map(row => [row.status, Number(row.total)])),
    lastVerifiedAt: latest[0]?.latestVerifiedAt || null, localOnly: process.env.CSA_LOCAL_ONLY === "true" };
}

export async function getEnterprisePricingProduct(productId) {
  await ensureEnterprisePricingSchema();
  const product = await productRecord(id(productId, "Product ID"));
  const [packages, latest, active, enterprises, settings] = await Promise.all([
    packagesFor(product.id), revisionFor(product.id), revisionFor(product.id, "active"), listPricingEnterprises(), getPricingSettings()
  ]);
  const [buyPriceRows] = await getPool().query(`SELECT purchasing_enterprise_id AS enterpriseId, price,
    revision FROM enterprise_pricing_buy_price_drafts WHERE product_id=?`, [product.id]);
  const buyPrice = buyPriceRows[0] ? { enterpriseId: Number(buyPriceRows[0].enterpriseId),
    cents: Math.round(Number(buyPriceRows[0].price) * 100), revision: Number(buyPriceRows[0].revision) } : null;
  const [publicationRows] = latest ? await getPool().query("SELECT platform, status, audit_id AS auditId, release_id AS releaseId, verified_at AS verifiedAt FROM enterprise_pricing_publications WHERE revision_id=?", [latest.id]) : [[]];
  const [profileRows] = await getPool().query(`SELECT unit_of_measure AS pricingUnit,
    source_unit_price AS retailUnitPrice, min_weight AS minWeight, max_weight AS maxWeight,
    avg_weight_override AS avgWeightOverride FROM product_pricing_profiles WHERE product_id=?`, [product.id]);
  const legacyProfile = profileRows[0] || null;
  let sourceEvidence = null;
  if (process.env.CSA_LOCAL_ONLY === "true") {
    try {
      const [samples] = await getPool().query(`SELECT source_snapshot_json AS snapshotJson,
        sampled_at AS sampledAt FROM local_pricing_sample_sources WHERE local_product_id=?`, [product.id]);
      if (samples.length) sourceEvidence = deriveLegacyPricingEvidence(parse(samples[0].snapshotJson), samples[0].sampledAt);
    } catch (error) {
      if (error.code !== "ER_NO_SUCH_TABLE" && error.code !== "ER_BAD_FIELD_ERROR") throw error;
    }
  }
  const positiveWeight = value => Number(value) > 0 ? value : null;
  const [migratedSources] = await getPool().query(`SELECT source_json AS sourceJson, created_at AS capturedAt
    FROM enterprise_pricing_migration_rows WHERE product_id=? AND status<>'rolled-back' ORDER BY id DESC LIMIT 1`, [product.id]);
  if (migratedSources.length) sourceEvidence = deriveLegacyPricingEvidence(parse(migratedSources[0].sourceJson), migratedSources[0].capturedAt);
  const ffcsa = enterprises.find(row => row.code === "ffcsa");
  const vendorName = String(product.vendorName || "").toLowerCase();
  const squareGroup = vendorName.includes("hyland") ? "hyland" : vendorName.includes("deck family farm") ? "deck"
    : vendorName.includes("creamy cow") ? "creamyCow" : "other";
  const suggestedSquareEnabled = Boolean(settings.squareDefaults[squareGroup]) && Number(product.approvedSquareLinks) > 0;
  const suggestedInput = latest?.input ? structuredClone(latest.input) : {
      retailEnterpriseId: ffcsa?.id,
      pricingUnit: legacyProfile?.pricingUnit === "lbs" ? "lb" : legacyProfile?.pricingUnit === "each" ? "each" : null,
      markupCategory: "custom", customMarkupBp: sourceEvidence?.markupPercent == null
        ? null : Math.round(sourceEvidence.markupPercent * 100),
      squareEnabled: suggestedSquareEnabled, squareOverride: null, csaOverride: null, overrideNote: "", saleBp: 0,
      purchaseCosts: [], wholesale: [], packages: packages.map(pkg => ({
        packageId: Number(pkg.packageId), quantity: Number(pkg.quantity) || 1,
        cachedWeight: positiveWeight(pkg.cachedWeight), minWeight: positiveWeight(legacyProfile?.minWeight),
        maxWeight: positiveWeight(legacyProfile?.maxWeight),
        avgWeightOverride: positiveWeight(legacyProfile?.avgWeightOverride)
      }))
    };
  if (buyPrice && Number(suggestedInput.retailEnterpriseId) === buyPrice.enterpriseId) {
    const rows = suggestedInput.purchaseCosts || [];
    const index = rows.findLastIndex(row => Number(row.enterpriseId) === buyPrice.enterpriseId);
    const cost = { enterpriseId: buyPrice.enterpriseId, cost: (buyPrice.cents / 100).toFixed(2),
      effectiveAt: index >= 0 ? rows[index].effectiveAt : new Date().toISOString().slice(0, 10),
      documentationRef: index >= 0 ? rows[index].documentationRef || "" : "" };
    suggestedInput.purchaseCosts = index >= 0 ? rows.map((row, i) => i === index ? cost : row) : [...rows, cost];
  }
  return {
    product, packages, legacyProfile, sourceEvidence, latest, active, enterprises, settings, publications: publicationRows,
    buyPrice, suggestedInput,
    suggestedSquareEnabled
  };
}

export async function saveEnterpriseBuyPrice(productId, value, expectedRevision, user) {
  await ensureEnterprisePricingSchema();
  const productIdNumber = id(productId, "Product ID");
  const cents = scaledInteger(value, 2, "Buy Price");
  if (cents <= 0) failure("Buy Price must be greater than zero.");
  const expected = Number(expectedRevision ?? 0);
  if (!Number.isSafeInteger(expected) || expected < 0) failure("Buy Price revision is invalid.");
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await productRecord(productIdNumber, connection);
    const [latest] = await connection.query(`SELECT r.status, r.input_json AS inputJson
      FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
      WHERE s.product_id=? FOR UPDATE`, [productIdNumber]);
    if (["approved", "partial"].includes(latest[0]?.status)) failure("Finish or resolve the approved publication before editing Buy Price.", 409);
    const [existing] = await connection.query(`SELECT revision, purchasing_enterprise_id AS enterpriseId
      FROM enterprise_pricing_buy_price_drafts WHERE product_id=? FOR UPDATE`, [productIdNumber]);
    if (Number(existing[0]?.revision || 0) !== expected) failure("Buy Price changed since you opened it. Refresh and review.", 409);
    const [enterprise] = await connection.query("SELECT id FROM enterprise_pricing_enterprises WHERE code='ffcsa'");
    const enterpriseId = Number(existing[0]?.enterpriseId || parse(latest[0]?.inputJson)?.retailEnterpriseId || enterprise[0]?.id);
    if (!enterpriseId) failure("A retail purchasing enterprise is required.");
    if (existing.length) await connection.query(`UPDATE enterprise_pricing_buy_price_drafts
      SET price=?, revision=revision+1, edited_by=?, updated_at=UTC_TIMESTAMP() WHERE product_id=?`,
    [(cents / 100).toFixed(2), actorId(user), productIdNumber]);
    else await connection.query(`INSERT INTO enterprise_pricing_buy_price_drafts
      (product_id,purchasing_enterprise_id,price,revision,edited_by,updated_at)
      VALUES (?,?,?,1,?,UTC_TIMESTAMP())`,
    [productIdNumber, enterpriseId, (cents / 100).toFixed(2), actorId(user)]);
    await connection.commit();
    return { cents, revision: expected + 1, enterpriseId };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

function priceAt(costs, enterpriseId, at) {
  return costs.filter(row => Number(row.enterpriseId) === Number(enterpriseId) && row.effectiveAt <= at)
    .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0] || null;
}

function normalizeInput(input, product, packageRows, enterprises, settings) {
  if (!input || typeof input !== "object" || Array.isArray(input)) failure("Pricing inputs are required.");
  if (String(product.categoryName || "").toLowerCase() === "membership" || /deposit/i.test(product.name)) failure("Membership and deposit pricing remain in the existing workflow until their replacement rules are reviewed.");
  const enterpriseIds = new Set(enterprises.map(row => Number(row.id)));
  const retailEnterpriseId = id(input.retailEnterpriseId, "Retail purchasing enterprise");
  if (!enterpriseIds.has(retailEnterpriseId)) failure("Retail purchasing enterprise was not found.");
  const effectiveAt = validDate(input.priceEffectiveAt || new Date().toISOString(), "Price effective date");
  const purchaseCosts = (input.purchaseCosts || []).map(row => {
    const enterpriseId = id(row.enterpriseId, "Purchasing enterprise");
    if (!enterpriseIds.has(enterpriseId)) failure("A purchasing enterprise was not found.");
    const cost = scaledInteger(row.cost, 2, "Buy Price");
    if (cost <= 0) failure("Purchase cost must be greater than zero.");
    return { enterpriseId, cost: (cost / 100).toFixed(2), effectiveAt: validDate(row.effectiveAt || effectiveAt, "Cost effective date"), documentationRef: String(row.documentationRef || "").slice(0, 2048) };
  });
  const costKeys = purchaseCosts.map(row => `${row.enterpriseId}:${row.effectiveAt}`);
  if (new Set(costKeys).size !== costKeys.length) failure("A purchasing enterprise has duplicate cost dates.");
  const retailCost = priceAt(purchaseCosts, retailEnterpriseId, effectiveAt);
  if (!retailCost) failure("Enter a Buy Price for the selected retail enterprise and effective date.");
  if (!Array.isArray(input.packages) || input.packages.length !== packageRows.length) failure("Include every current package in the pricing proposal.");
  const required = new Set(packageRows.map(row => Number(row.packageId)));
  const seen = new Set();
  const packages = input.packages.map(row => {
    const packageId = id(row.packageId, "Package ID");
    if (!required.has(packageId) || seen.has(packageId)) failure("Package list changed or contains duplicates. Refresh and review it.");
    seen.add(packageId);
    return { packageId, quantity: row.quantity ?? 1,
      minWeight: row.minWeight || null, maxWeight: row.maxWeight || null,
      avgWeightOverride: row.avgWeightOverride || null, cachedWeight: row.cachedWeight || null };
  });
  const pricingUnit = input.pricingUnit;
  if (pricingUnit === "lb" && packages.some(row => !row.minWeight && !row.maxWeight && !row.avgWeightOverride && !row.cachedWeight)) failure("Every per-pound package needs a reviewed weight.");
  const wholesale = (input.wholesale || []).map(row => {
    const sellingEnterpriseId = id(row.sellingEnterpriseId, "Wholesale selling enterprise");
    if (!enterpriseIds.has(sellingEnterpriseId)) failure("Wholesale selling enterprise was not found.");
    if (!["fixed", "markup"].includes(row.mode)) failure("Wholesale pricing must be fixed or cost-plus.");
    const costEnterpriseId = row.mode === "markup" ? id(row.costEnterpriseId || sellingEnterpriseId, "Wholesale cost enterprise") : null;
    if (costEnterpriseId && !enterpriseIds.has(costEnterpriseId)) failure("Wholesale cost enterprise was not found.");
    return { sellingEnterpriseId, mode: row.mode, fixedPrice: row.mode === "fixed" ? row.fixedPrice : null,
      markupBp: row.mode === "markup" ? row.markupBp : null, costEnterpriseId };
  });
  if (new Set(wholesale.map(row => row.sellingEnterpriseId)).size !== wholesale.length) failure("A selling enterprise has duplicate wholesale prices.");
  const clean = {
    retailEnterpriseId, priceEffectiveAt: effectiveAt, pricingUnit,
    markupCategory: input.markupCategory, customMarkupBp: input.customMarkupBp ?? null,
    squareEnabled: input.squareEnabled === true, squareOverride: input.squareOverride || null,
    csaOverride: input.csaOverride || null, overrideNote: String(input.overrideNote || "").slice(0, 2000),
    saleBp: input.saleBp ?? 0, purchaseCosts, packages, wholesale
  };
  if (Number(clean.saleBp) !== 0) failure("Create a separately approved promotion for sale pricing.");
  const output = calculateEnterprisePricing({ ...clean, buyFromPrice: retailCost.cost }, settings);
  output.wholesale = wholesale.map(row => {
    if (row.mode === "fixed") return { sellingEnterpriseId: row.sellingEnterpriseId, mode: row.mode, priceCents: scaledInteger(row.fixedPrice, 2, "Wholesale price") };
    const costRow = priceAt(purchaseCosts, row.costEnterpriseId, effectiveAt);
    if (!costRow) failure("A cost-plus wholesale price needs a validated cost for its selling enterprise.");
    const markupBp = Number(row.markupBp);
    if (!Number.isSafeInteger(markupBp) || markupBp < 0 || markupBp > 100000) failure("Wholesale markup is invalid.");
    return { sellingEnterpriseId: row.sellingEnterpriseId, mode: row.mode,
      costEnterpriseId: row.costEnterpriseId, markupBp,
      priceCents: roundRatio(BigInt(scaledInteger(costRow.cost, 4)) * BigInt(10000 + markupBp), 1000000n) };
  });
  return { clean, output };
}

export async function previewEnterprisePricing(productId, input) {
  await ensureEnterprisePricingSchema();
  const [product, packages, enterprises, settings] = await Promise.all([
    productRecord(id(productId, "Product ID")), packagesFor(id(productId, "Product ID")), listPricingEnterprises(), getPricingSettings()
  ]);
  const { clean, output } = normalizeInput(input, product, packages, enterprises, settings);
  return { input: clean, output, settingsVersionId: settings.id };
}

export async function saveEnterprisePricingDraft(productId, input, expectedLatestRevisionId, user, expectedBuyPriceRevision = null) {
  const preview = await previewEnterprisePricing(productId, input);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("SELECT id FROM products WHERE id=? FOR UPDATE", [productId]);
    const [state] = await connection.query("SELECT latest_revision_id AS latestRevisionId FROM enterprise_pricing_product_state WHERE product_id=? FOR UPDATE", [productId]);
    const current = Number(state[0]?.latestRevisionId || 0);
    if (current !== Number(expectedLatestRevisionId || 0)) failure("Pricing changed since you opened it. Refresh and review before saving.", 409);
    const [buyDraft] = await connection.query(`SELECT revision FROM enterprise_pricing_buy_price_drafts
      WHERE product_id=? FOR UPDATE`, [productId]);
    if (expectedBuyPriceRevision !== null && Number(buyDraft[0]?.revision || 0) !== Number(expectedBuyPriceRevision)) {
      failure("Buy Price changed since you opened this proposal. Refresh and review.", 409);
    }
    const retailCost = priceAt(preview.input.purchaseCosts, preview.input.retailEnterpriseId, preview.input.priceEffectiveAt);
    await connection.query(`INSERT INTO enterprise_pricing_buy_price_drafts
      (product_id,purchasing_enterprise_id,price,revision,edited_by,updated_at)
      VALUES (?,?,?,?,?,UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE purchasing_enterprise_id=VALUES(purchasing_enterprise_id),
        price=VALUES(price), revision=revision+1, edited_by=VALUES(edited_by), updated_at=VALUES(updated_at)`,
    [productId, preview.input.retailEnterpriseId, retailCost.cost,
      Number(buyDraft[0]?.revision || 0) + 1, actorId(user)]);
    const [result] = await connection.query(`INSERT INTO enterprise_pricing_revisions
      (product_id, settings_version_id, status, input_json, output_json, editor_id, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, UTC_TIMESTAMP())`,
      [productId, preview.settingsVersionId, JSON.stringify(preview.input), JSON.stringify(preview.output), actorId(user)]);
    const revisionId = Number(result.insertId);
    await connection.query(`INSERT INTO enterprise_pricing_product_state (product_id, latest_revision_id, updated_at)
      VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE latest_revision_id=VALUES(latest_revision_id), updated_at=VALUES(updated_at)`, [productId, revisionId]);
    await connection.commit();
    return { revisionId, status: "pending", ...preview };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function approveEnterprisePricingRevision(revisionId, user) {
  await ensureEnterprisePricingSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT * FROM enterprise_pricing_revisions WHERE id=? FOR UPDATE", [id(revisionId, "Revision ID")]);
    if (!rows.length) failure("Pricing revision was not found.", 404);
    const revision = revisionView(rows[0]);
    const [state] = await connection.query("SELECT latest_revision_id AS latestRevisionId FROM enterprise_pricing_product_state WHERE product_id=? FOR UPDATE", [revision.productId]);
    if (Number(state[0]?.latestRevisionId) !== revision.id || revision.status !== "pending") failure("This pricing revision is no longer pending. Refresh and review it.", 409);
    const [buyDraft] = await connection.query(`SELECT purchasing_enterprise_id AS enterpriseId, price
      FROM enterprise_pricing_buy_price_drafts WHERE product_id=? FOR UPDATE`, [revision.productId]);
    const approvedCost = priceAt(revision.input.purchaseCosts, revision.input.retailEnterpriseId, revision.input.priceEffectiveAt);
    if (buyDraft.length && (Number(buyDraft[0].enterpriseId) !== Number(revision.input.retailEnterpriseId)
      || !approvedCost || scaledInteger(buyDraft[0].price, 4, "Buy Price") !== scaledInteger(approvedCost.cost, 4, "Buy Price"))) {
      failure("Buy Price changed after this proposal was saved. Save a new proposal before approval.", 409);
    }
    if (Date.parse(`${revision.input.priceEffectiveAt.replace(" ", "T")}Z`) > Date.now()) failure("Future effective pricing cannot publish early. Review this proposal on its effective date.", 409);
    const [unfinishedReleases] = await connection.query(`SELECT ra.id FROM product_sync_release_actions ra
      JOIN product_sync_actions a ON a.id=ra.action_id JOIN product_sync_releases r ON r.id=ra.release_id
      WHERE a.product_id=? AND r.status<>'cancelled' AND ra.status IN ('pending','working','failed','held') LIMIT 1`, [revision.productId]);
    if (unfinishedReleases.length) failure("Resolve the previous publication result before approving another price revision.", 409);
    const [scheduledLegacy] = await connection.query(`SELECT i.id FROM pricelist_change_items i
      JOIN pricelist_change_batches b ON b.id=i.batch_id
      WHERE i.product_id=? AND b.status IN ('scheduled','running') AND i.status IN ('pending','local_applied') LIMIT 1`, [revision.productId]);
    if (scheduledLegacy.length) failure("Resolve the existing scheduled legacy price release before approving enterprise pricing.", 409);
    const settings = await getPricingSettings();
    if (settings.requireDifferentApprover && actorId(user) === revision.editorId) failure("A different pricing publisher must approve this change.", 403);
    if (Number(settings.id) !== revision.settingsVersionId) failure("Pricing settings changed. Recalculate and save a new proposal.", 409);
    await productRecord(revision.productId, connection);
    const [legacySales] = await connection.query(`SELECT COALESCE(ps.on_sale, pp.on_sale, 0) AS onSale,
      pp.customer_price_overrides_json AS customerOverrides
      FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id
      LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id WHERE p.id=?`, [revision.productId]);
    if (Number(legacySales[0]?.onSale)) failure("This product has an active legacy sale. Reconcile its promotion before migrating the regular price.", 409);
    if (legacySales[0]?.customerOverrides && (parse(legacySales[0].customerOverrides)?.length || 0) > 0) failure("This product has basket-specific price overrides. Review and reconcile them before using one price for all four baskets.", 409);
    const packageRows = await packagesFor(revision.productId, connection);
    if (packageRows.length !== revision.input.packages.length || packageRows.some(row => !revision.input.packages.some(pkg => pkg.packageId === Number(row.packageId)))) failure("Packages changed. Recalculate and review pricing.", 409);
    const [promotions] = await connection.query("SELECT id, input_json AS inputJson FROM enterprise_promotions WHERE status IN ('approved','scheduled','active','partial','cancelling') FOR UPDATE");
    const packageIds = new Set(packageRows.map(row => Number(row.packageId)));
    const overlappingSale = promotions.find(row => (parse(row.inputJson)?.packageIds || []).some(packageId => packageIds.has(Number(packageId))));
    if (overlappingSale) failure(`Sale ${overlappingSale.id} uses this product. Finish or cancel the sale before approving a new regular price.`, 409);
    const [previous] = await connection.query(`SELECT r.output_json AS outputJson FROM enterprise_pricing_product_state s
      JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id WHERE s.product_id=?`, [revision.productId]);
    const old = previous.length ? parse(previous[0].outputJson) : null;
    const squareChanged = revision.input.squareEnabled && (!old || old.squareUnitCents !== revision.output.squareUnitCents || JSON.stringify(old.packages.map(pkg => pkg.squareVariationCents)) !== JSON.stringify(revision.output.packages.map(pkg => pkg.squareVariationCents)));
    const localLineChanged = !old || JSON.stringify(old.packages.map(pkg => [pkg.localLineRegularCents, pkg.localLineSaleCents])) !== JSON.stringify(revision.output.packages.map(pkg => [pkg.localLineRegularCents, pkg.localLineSaleCents]));
    await connection.query("UPDATE enterprise_pricing_revisions SET status='approved', approver_id=?, approved_at=UTC_TIMESTAMP() WHERE id=?", [actorId(user), revision.id]);
    for (const row of revision.input.purchaseCosts) await connection.query(`INSERT IGNORE INTO enterprise_purchase_cost_history
      (product_id, purchasing_enterprise_id, cost, effective_at, documentation_ref, revision_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`, [revision.productId, row.enterpriseId, row.cost, row.effectiveAt, row.documentationRef, revision.id]);
    for (const row of revision.output.wholesale) await connection.query(`INSERT IGNORE INTO enterprise_wholesale_price_history
      (product_id, selling_enterprise_id, mode, price_cents, markup_bp, cost_enterprise_id, revision_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`, [revision.productId, row.sellingEnterpriseId, row.mode, row.priceCents, row.markupBp ?? null, row.costEnterpriseId ?? null, revision.id]);
    for (const [platform, changed] of [["localline", localLineChanged], ["square", squareChanged]]) if (changed) {
      await connection.query(`INSERT INTO enterprise_pricing_publications (revision_id, platform, status, frozen_json, updated_at)
        VALUES (?, ?, 'pending', ?, UTC_TIMESTAMP())`, [revision.id, platform, JSON.stringify({ input: revision.input, output: revision.output, settingsVersionId: revision.settingsVersionId })]);
    }
    if (!localLineChanged && !squareChanged) {
      await connection.query("UPDATE enterprise_pricing_product_state SET active_revision_id=?, migrated_at=COALESCE(migrated_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE product_id=?", [revision.id, revision.productId]);
      await connection.query("UPDATE enterprise_pricing_revisions SET status='active', active_at=UTC_TIMESTAMP() WHERE id=?", [revision.id]);
    }
    await connection.commit();
    return { revisionId: revision.id, status: localLineChanged || squareChanged ? "approved" : "active", destinations: [localLineChanged ? "localline" : null, squareChanged ? "square" : null].filter(Boolean) };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function activateEnterprisePricingLocally(revisionId, user) {
  if (process.env.CSA_LOCAL_ONLY !== "true") failure("Local preview is unavailable outside isolated local mode.", 403);
  await ensureEnterprisePricingSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`SELECT r.* FROM enterprise_pricing_revisions r
      JOIN enterprise_pricing_product_state s ON s.latest_revision_id=r.id
      WHERE r.id=? FOR UPDATE`, [id(revisionId)]);
    if (!rows.length || rows[0].status !== "pending") failure("Only the latest pending proposal can be applied locally.", 409);
    const revision = revisionView(rows[0]);
    const preview = await previewEnterprisePricing(revision.productId, revision.input);
    if (preview.settingsVersionId !== revision.settingsVersionId || JSON.stringify(preview.output) !== JSON.stringify(revision.output)) {
      failure("Pricing inputs or settings changed. Save a new proposal.", 409);
    }
    const [[buy]] = await connection.query("SELECT price FROM enterprise_pricing_buy_price_drafts WHERE product_id=? FOR UPDATE", [revision.productId]);
    if (buy && scaledInteger(buy.price, 4) !== revision.output.buyFromTenThousandths) failure("Buy Price changed. Save a new proposal.", 409);
    await connection.query("UPDATE enterprise_pricing_revisions SET status='local-preview',active_at=UTC_TIMESTAMP() WHERE id=?", [revision.id]);
    await connection.query("UPDATE enterprise_pricing_product_state SET active_revision_id=?,updated_at=UTC_TIMESTAMP() WHERE product_id=?", [revision.id, revision.productId]);
    await connection.commit();
    return { revisionId: revision.id, status: "local-preview", actorId: actorId(user), remotePublications: 0 };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function rejectEnterprisePricingRevision(revisionId, reason, user) {
  await ensureEnterprisePricingSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`SELECT r.id, r.product_id AS productId, r.status,
      s.latest_revision_id AS latestRevisionId FROM enterprise_pricing_revisions r
      JOIN enterprise_pricing_product_state s ON s.product_id=r.product_id WHERE r.id=? FOR UPDATE`, [id(revisionId, "Revision ID")]);
    if (!rows.length || Number(rows[0].latestRevisionId) !== Number(revisionId) || rows[0].status !== "pending") failure("Only the latest pending proposal can be rejected.", 409);
    const note = String(reason || "").trim();
    if (!note) failure("Provide a short reason for rejecting this proposal.");
    await connection.query("UPDATE enterprise_pricing_revisions SET status='rejected', approver_id=?, rejected_at=UTC_TIMESTAMP() WHERE id=?", [actorId(user), revisionId]);
    await connection.query(`INSERT INTO enterprise_pricing_publications (revision_id, platform, status, frozen_json, result_json, updated_at)
      VALUES (?, 'review', 'rejected', '{}', ?, UTC_TIMESTAMP())`, [revisionId, JSON.stringify({ reason: note })]);
    await connection.commit();
    return { revisionId: Number(revisionId), status: "rejected", reason: note };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function listEnterprisePricingReview() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query(`SELECT r.*, p.name AS productName, v.name AS vendorName,
    s.active_revision_id AS activeRevisionId FROM enterprise_pricing_revisions r
    JOIN enterprise_pricing_product_state s ON s.latest_revision_id=r.id
    JOIN products p ON p.id=r.product_id LEFT JOIN vendors v ON v.id=p.vendor_id
    WHERE r.status IN ('pending','approved','partial') ORDER BY r.created_at DESC, r.id DESC LIMIT 250`);
  const ids = rows.map(row => Number(row.id));
  const [publications] = ids.length ? await getPool().query("SELECT revision_id AS revisionId, platform, status, audit_id AS auditId, release_id AS releaseId FROM enterprise_pricing_publications WHERE revision_id IN (?)", [ids]) : [[]];
  return rows.map(row => ({ ...revisionView(row), productName: row.productName, vendorName: row.vendorName,
    activeRevisionId: row.activeRevisionId, publications: publications.filter(item => Number(item.revisionId) === Number(row.id)) }));
}

export async function getApprovedEnterpriseRevision(productId, revisionId = null) {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query(`SELECT r.*, s.latest_revision_id AS latestRevisionId
    FROM enterprise_pricing_revisions r JOIN enterprise_pricing_product_state s ON s.product_id=r.product_id
    WHERE r.product_id=? ${revisionId ? "AND r.id=?" : "AND r.id=s.latest_revision_id"}
    LIMIT 1`, revisionId ? [productId, revisionId] : [productId]);
  if (!rows.length) return null;
  const row = rows[0];
  if (Number(row.latestRevisionId) !== Number(row.id) || !["approved", "partial", "active"].includes(row.status)) return null;
  return revisionView(row);
}

export async function enterpriseRevisionMarker(productId, revisionId) {
  const revision = await getApprovedEnterpriseRevision(productId, revisionId);
  if (!revision) return null;
  const [sales] = await getPool().query("SELECT input_json AS inputJson FROM enterprise_promotions WHERE status IN ('approved','scheduled','active','partial','cancelling')");
  const packageIds = new Set(revision.input.packages.map(pkg => Number(pkg.packageId)));
  if (sales.some(row => (parse(row.inputJson)?.packageIds || []).some(packageId => packageIds.has(Number(packageId))))) return null;
  return revision.id;
}

async function activateIfVerified(revisionId, connection) {
  const [rows] = await connection.query("SELECT platform, status FROM enterprise_pricing_publications WHERE revision_id=?", [revisionId]);
  if (!rows.length || rows.some(row => row.status !== "verified")) {
    if (rows.some(row => row.status === "verified") && rows.some(row => row.status !== "verified")) {
      await connection.query("UPDATE enterprise_pricing_revisions SET status='partial' WHERE id=? AND status IN ('approved','partial')", [revisionId]);
    }
    return false;
  }
  const [revisionRows] = await connection.query("SELECT product_id AS productId FROM enterprise_pricing_revisions WHERE id=?", [revisionId]);
  if (!revisionRows.length) return false;
  const productId = revisionRows[0].productId;
  const [state] = await connection.query("SELECT latest_revision_id AS latestRevisionId FROM enterprise_pricing_product_state WHERE product_id=?", [productId]);
  if (Number(state[0]?.latestRevisionId) !== Number(revisionId)) return false;
  await connection.query("UPDATE enterprise_pricing_product_state SET active_revision_id=?, migrated_at=COALESCE(migrated_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE product_id=?", [revisionId, productId]);
  await connection.query("UPDATE enterprise_pricing_revisions SET status='active', active_at=COALESCE(active_at, UTC_TIMESTAMP()) WHERE id=?", [revisionId]);
  return true;
}

export async function recordEnterpriseAuditResult(auditId, revisionId, connection = getPool()) {
  if (!revisionId) return;
  const [actions] = await connection.query("SELECT platform, status FROM product_sync_actions WHERE audit_id=? AND direction='outgoing'", [auditId]);
  for (const platform of ["localline", "square"]) {
    const rows = actions.filter(row => row.platform === platform);
    if (!rows.length) continue;
    const status = rows.every(row => row.status === "synced") ? "verified"
      : rows.some(row => ["blocked", "review", "held"].includes(row.status)) ? "blocked" : "audited";
    await connection.query(`UPDATE enterprise_pricing_publications SET status=?, audit_id=?,
      verified_at=IF(?='verified', UTC_TIMESTAMP(), verified_at), updated_at=UTC_TIMESTAMP()
      WHERE revision_id=? AND platform=? AND status<>'verified'`, [status, auditId, status, revisionId, platform]);
  }
  await activateIfVerified(revisionId, connection);
}

export async function recordEnterpriseReleaseResult(release, connection = getPool()) {
  const ids = [...new Set(release.actions.map(action => action.enterpriseRevisionId).filter(Boolean))];
  for (const revisionId of ids) {
    const [auditActions] = await connection.query(`SELECT a.id, a.platform, a.status AS auditStatus, ra.status AS releaseStatus
      FROM product_sync_actions a LEFT JOIN product_sync_release_actions ra ON ra.action_id=a.id
      WHERE a.audit_id=? AND a.direction='outgoing' AND a.product_id=?`,
      [release.auditId, release.actions.find(action => action.enterpriseRevisionId === revisionId).productId]);
    for (const platform of ["localline", "square"]) {
      const rows = auditActions.filter(row => row.platform === platform);
      if (!rows.length) continue;
      const verified = rows.every(row => row.auditStatus === "synced" || row.releaseStatus === "completed");
      const partial = rows.some(row => row.releaseStatus === "completed");
      const status = verified ? "verified" : partial ? "partial" : rows.some(row => ["failed", "held"].includes(row.releaseStatus)) ? "failed" : "publishing";
      await connection.query(`UPDATE enterprise_pricing_publications SET status=?, release_id=?,
        verified_at=IF(?='verified', UTC_TIMESTAMP(), verified_at), updated_at=UTC_TIMESTAMP()
        WHERE revision_id=? AND platform=?`, [status, release.id, status, revisionId, platform]);
    }
    await activateIfVerified(revisionId, connection);
  }
}

export async function assertLegacyPricingPublicationAllowed(productIds = []) {
  await ensureEnterprisePricingSchema();
  const ids = [...new Set(productIds.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) return;
  const [rows] = await getPool().query(`SELECT p.name FROM enterprise_pricing_product_state s
    JOIN products p ON p.id=s.product_id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
    WHERE s.product_id IN (?) AND (s.active_revision_id IS NOT NULL OR r.status IN ('approved','partial')) LIMIT 1`, [ids]);
  if (rows.length) failure(`${rows[0].name} uses enterprise pricing. Review its current pricing revision instead of publishing legacy formula fields.`, 409);
}

export async function assertNoMigratedLegacySquarePublication() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query(`SELECT p.name FROM enterprise_pricing_product_state s
    JOIN products p ON p.id=s.product_id WHERE s.active_revision_id IS NOT NULL LIMIT 1`);
  if (rows.length) failure("A migrated product exists. Audit selected unmigrated packages instead of applying all legacy Square prices.", 409);
}

export async function enterprisePricingMigrationReport({ limit = 1000 } = {}) {
  await ensureEnterprisePricingSchema();
  const [migrationRows] = await getPool().query(`SELECT m.product_id AS productId,m.plan_json AS planJson,
    r.output_json AS outputJson FROM enterprise_pricing_migration_rows m
    LEFT JOIN enterprise_pricing_product_state s ON s.product_id=m.product_id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
    WHERE m.status<>'rolled-back' ORDER BY m.product_id LIMIT ?`, [Math.min(5000, Math.max(1, Number(limit) || 1000))]);
  if (migrationRows.length) return migrationRows.flatMap(row => {
    const plan = parse(row.planJson), output = parse(row.outputJson);
    const comparisons = plan.comparisons.length ? plan.comparisons : [{ packageId: 0, package: "", currentLocalLine: [], currentSquare: [] }];
    return comparisons.map(pkg => {
      const proposed = output?.packages?.find(item => item.packageId === pkg.packageId)?.localLineRegularCents ?? null;
      const current = pkg.currentLocalLine.find(price => price.basket === "Guest Basket")?.cents ?? pkg.currentLocalCents ?? null;
      const difference = proposed == null || current == null ? null : (proposed - current) / 100;
      return { productId: Number(row.productId), product: plan.product, vendor: plan.vendor, packageId: pkg.packageId, package: pkg.package,
        currentLocalPrice: pkg.currentLocalCents == null ? null : pkg.currentLocalCents / 100,
        currentRemote: { localLine: pkg.currentLocalLine.filter(price => price.cents != null).map(price => ({ list: price.basket, price: price.cents / 100 })),
          square: pkg.currentSquare.filter(price => price.cents != null).map(price => price.cents / 100) },
        proposedPrice: proposed == null ? null : proposed / 100, difference,
        differencePercent: difference == null || !current ? null : Number((difference * 10000 / current).toFixed(2)),
        explanation: [...plan.blockers, ...plan.reviewReasons].join(" "),
        basketConflict: new Set(pkg.currentLocalLine.map(price => price.cents)).size > 1,
        action: plan.action === "preserve-special" ? "preserve" : proposed == null ? "hold" : difference === 0 ? "preserve" : "review" };
    });
  });
  const products = (await listEnterprisePricingProducts({ limit })).rows;
  const report = [];
  const [cacheTables] = await getPool().query(`SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='local_line_price_list_entries'`);
  const hasLocalLineCache = cacheTables.length > 0;
  for (const product of products) {
    const detail = await getEnterprisePricingProduct(product.id);
    const [profileRows] = await getPool().query(`SELECT * FROM product_pricing_profiles WHERE product_id=?`, [product.id]);
    const [vendorRows] = await getPool().query("SELECT * FROM vendors WHERE id=?", [detail.product.vendorId]);
    const camel = row => row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()), value])) : null;
    const profile = camel(profileRows[0]);
    const vendor = camel(vendorRows[0]);
    const legacyPackages = detail.packages.map(pkg => ({ id: Number(pkg.packageId), name: pkg.name, price: pkg.price, numOfItems: pkg.quantity, visible: 1 }));
    const packageMetaByPackageId = new Map(detail.packages.map(pkg => [Number(pkg.packageId), { avgPackageWeight: pkg.cachedWeight, numOfItems: pkg.quantity }]));
    const legacy = computeProductPricingSnapshot({ product: detail.product, packages: legacyPackages, packageMetaByPackageId, vendor, profile });
    const [localLine] = hasLocalLineCache ? await getPool().query(`SELECT package_id AS packageId, price_list_name AS listName, final_price_cache AS price
      FROM local_line_price_list_entries WHERE product_id=? AND final_price_cache IS NOT NULL`, [product.id]) : [[]];
    const [square] = await getPool().query(`SELECT l.package_id AS packageId, v.price_amount AS amount
      FROM square_variation_links l JOIN square_catalog_variations v ON v.square_variation_id=l.square_variation_id
      WHERE l.product_id=? AND l.approved_at IS NOT NULL`, [product.id]);
    const remoteLists = new Map();
    for (const row of localLine) { if (!remoteLists.has(row.packageId)) remoteLists.set(row.packageId, []); remoteLists.get(row.packageId).push({ list: row.listName, price: Number(row.price) }); }
    const proposed = detail.latest?.output;
    const legacyById = new Map(legacy.packageRows.map(row => [Number(row.id), row]));
    for (const pkg of detail.packages) {
      const current = legacyById.get(Number(pkg.packageId));
      const proposedRow = proposed?.packages.find(row => row.packageId === Number(pkg.packageId));
      const legacyPrice = current?.customerPrices?.guest?.final ?? Number(pkg.price);
      const proposedPrice = proposedRow?.localLineRegularCents == null ? null : proposedRow.localLineRegularCents / 100;
      const baskets = remoteLists.get(pkg.packageId) || [];
      const difference = proposedPrice == null || legacyPrice == null ? null : Number((proposedPrice - legacyPrice).toFixed(2));
      report.push({ productId: product.id, product: product.name, vendor: product.vendorName,
        packageId: Number(pkg.packageId), package: pkg.name, currentLocalPrice: legacyPrice,
        currentRemote: { localLine: baskets, square: square.filter(row => Number(row.packageId) === Number(pkg.packageId)).map(row => Number(row.amount) / 100) },
        proposedPrice, difference, differencePercent: difference == null || !legacyPrice ? null : Number((difference / legacyPrice * 100).toFixed(2)),
        explanation: proposed ? "Buy Price and markup calculation" : "Buy Price, unit, and markup require review",
        basketConflict: new Set(baskets.map(row => row.price)).size > 1,
        action: !proposed ? "hold" : difference === 0 && new Set(baskets.map(row => row.price)).size <= 1 ? "preserve" : "review" });
    }
  }
  return report;
}
