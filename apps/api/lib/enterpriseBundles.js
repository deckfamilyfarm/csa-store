import { readProductSales, salePrice } from './enterpriseProductSales.js';
import { promotionIsActive } from './enterprisePromotionsCore.js';
import { getPool } from '../db.js';
import { ensureEnterprisePricingSchema } from './enterprisePricingSchema.js';
import { fingerprint } from './productSyncCore.js';
import { normalizeBundle, calculateBundle, observedBundlePrices } from './enterpriseBundlesCore.js';
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const failure = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const positiveId = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) failure('Invalid bundle ID.'); return n; };

export async function bundleCatalog(db = getPool()) {
  const [rows] = await db.query(`SELECT p.id AS productId,p.name,p.is_deleted AS deleted,v.name AS vendorName,k.id AS packageId,k.name AS packageName,
    k.track_inventory AS packageTracked,k.inventory AS packageStock,p.track_inventory AS productTracked,p.inventory AS productStock,
    k.num_of_items AS packageQuantity,k.track_type AS trackType,
    s.latest_revision_id AS latestId,s.active_revision_id AS revisionId,r.output_json AS outputJson
    FROM packages k JOIN products p ON p.id=k.product_id LEFT JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id
    WHERE LOWER(COALESCE(c.name,'')) <> 'membership'
      AND NOT EXISTS (SELECT 1 FROM enterprise_bundle_legacy_products b WHERE b.product_id=p.id)`);
  const [promotions] = await db.query("SELECT id,status,input_json AS inputJson,output_json AS outputJson,localline_status AS channelStatus FROM enterprise_promotions WHERE status IN ('approved','scheduled','active','partial','cancelling') OR (status='pending' AND localline_status='active')");
  const desiredSales = await readProductSales(db, rows.map(r=>Number(r.productId)));
  const now = Date.now();
  return rows.map(row => {
    const output = parse(row.outputJson), pkg = output?.packages?.find(p => Number(p.packageId) === row.packageId);
    let priceCents = pkg?.localLineSaleCents ?? null, promotionId = null, promotionRegularCents = null;
    let blocker = row.deleted ? `${row.name} has been deleted.` : !row.vendorName?.trim() ? `${row.name} needs a vendor.`
      : !pkg ? `${row.name} needs a local FF package price.` : row.latestId !== row.revisionId ? `${row.name} has unapproved pricing changes.` : null;
    const sales = promotions.filter(sale => {
      const input = parse(sale.inputJson);
      return input?.packageIds?.includes(row.packageId) && input.channels?.includes('localline') &&
        promotionIsActive(input, now);
    });
    const desired = desiredSales.get(Number(row.productId));
    if (desired && pkg) { priceCents = salePrice(pkg.localLineRegularCents, Number(desired.discount_bp)); promotionId=Number(desired.discount_bp)>0?desired.promotion_id:null; promotionRegularCents=promotionId?pkg.localLineRegularCents:null;
      const published=promotions.find(p=>Number(p.id)===Number(desired.promotion_id));
      if(Number(desired.discount_bp)>0 && (published?.channelStatus!=='active'|| !(published?.status==='active'||(published?.status==='pending'&&Number(parse(published.inputJson).regularRevisionId)===Number(row.revisionId))))) blocker=`${row.name}: publish its saved sale before publishing this bundle.`;
      if(Number(desired.discount_bp)===0 && sales.some(p=>p.channelStatus==='active')) blocker=`${row.name}: finish removing its channel sale before publishing this bundle.`;
    }
    else if (sales.length) {
      const sale = sales[0], saleOutput = parse(sale.outputJson), prices = saleOutput?.localLinePrices || [];
      const entry = prices.find(p => p.packageId === row.packageId);
      if (sales.length !== 1 || sale.status !== 'active' || sale.channelStatus !== 'active' || !Number.isSafeInteger(entry?.saleCents) ||
        !Number.isSafeInteger(entry?.regularCents) || entry.regularCents !== pkg?.localLineRegularCents || entry.saleCents < 0 || entry.saleCents >= entry.regularCents) blocker = `${row.name}: verify its promotion before pricing this bundle.`;
      else { priceCents = entry.saleCents; promotionId = sale.id; promotionRegularCents = entry.regularCents; }
    }
    // Unknown, untracked or weight-based stock remains unknown; never infer
    // component capacity from on-farm availability or pounds.
    const packageStock = row.packageTracked && row.packageStock != null ? Number(row.packageStock) : null;
    const productStock = row.productTracked && row.productStock != null && row.trackType === 'package' ? Number(row.productStock) : null;
    return { productId: row.productId, packageId: row.packageId, name: row.name, vendorName: row.vendorName, packageName: row.packageName,
      deleted: Boolean(row.deleted), revisionId: row.revisionId, priceCents, promotionId, promotionRegularCents, blocker,
      stockResource: packageStock != null ? `package:${row.packageId}` : productStock != null ? `product:${row.productId}` : null,
      availableStock: packageStock ?? productStock, stockUnitsPerPackage: 1 };
  });
}

async function evaluate(input, db = getPool()) {
  const clean = normalizeBundle(input);
  const [vendors] = await db.query('SELECT id,name FROM vendors WHERE id=?', [clean.vendorId]);
  if (!vendors[0]?.name?.trim()) failure('Choose an existing named vendor.');
  const catalog = await bundleCatalog(db);
  const output = calculateBundle(clean, catalog);
  return { input: clean, output, vendorName: vendors[0].name, pricingHash: fingerprint({ input: clean, output }) };
}

export async function listBundles() {
  await ensureEnterprisePricingSchema();
  const db = getPool(), [rows] = await db.query('SELECT * FROM enterprise_bundles ORDER BY name,id');
  const catalog = await bundleCatalog(db);
  const [vendors] = await db.query('SELECT id,name FROM vendors WHERE TRIM(COALESCE(name,\'\'))<>\'\' ORDER BY name');
  return { localOnly: process.env.CSA_LOCAL_ONLY === 'true', rows: rows.map(row => bundleView(row, catalog, vendors)), vendors,
    catalog: catalog.filter(row => !row.deleted) };
}
function bundleView(row, catalog, vendors) {
  const input = parse(row.input_json), source = parse(row.source_json), output = calculateBundle(input, catalog);
  const remotePrices = observedBundlePrices(source), pricesDiffer = remotePrices.length !== 3 || remotePrices.some(p => p.priceCents !== output.priceCents);
  return { id: row.id, type: 'bundle', remoteBoxId: row.remote_box_id, revision: row.revision, editedBy: row.edited_by, input, output,
    vendorName: vendors.find(v => v.id === input.vendorId)?.name || '', remotePrices,
    pricingHash: fingerprint({ input, output }), updatedAt: row.updated_at,
    status: output.blockers.length ? 'needs-input' : pricesDiffer || source.name !== input.name || Boolean(source.visible) !== input.visible ? 'needs-sync' : 'matches',
    remoteCapturedAt: row.remote_captured_at,
    publicationBlocker: !row.remote_box_id ? 'This bundle is saved locally. A Local Line box must be created and linked before publishing.' : process.env.CSA_LOCAL_ONLY === 'true' ? 'Channel access is disabled in isolated local mode.' : null };
}
export async function getBundle(id) {
  const result = await listBundles(), row = result.rows.find(r => r.id === positiveId(id));
  if (!row) failure('Bundle not found.', 404);
  const [history] = await getPool().query('SELECT revision,actor_id AS actorId,created_at AS createdAt FROM enterprise_bundle_revisions WHERE bundle_id=? ORDER BY revision DESC LIMIT 20', [row.id]);
  const [[publication]]=await getPool().query('SELECT id FROM enterprise_bundle_publications WHERE bundle_id=? ORDER BY id DESC LIMIT 1',[id]);
  return { ...row, history, latestPublicationId: publication?.id || null };
}
export async function previewBundle(input) {
  await ensureEnterprisePricingSchema();
  return evaluate(input);
}
export async function createBundle(body, user) {
  await ensureEnterprisePricingSchema();
  const actor = positiveId(user?.userId ?? user?.id), key = String(body?.creationKey || '');
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(key)) failure('A creation request key is required.');
  const db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    const [existing] = await db.query('SELECT id,edited_by AS actor FROM enterprise_bundles WHERE creation_key=?', [key]);
    if (existing.length) {
      if (Number(existing[0].actor) !== actor) failure('This creation request belongs to another editor.', 403);
      await db.commit(); return getBundle(existing[0].id);
    }
    const normalized = normalizeBundle(body.input), ids = normalized.components.map(c => c.packageId).sort((a,b) => a-b);
    await db.query('SELECT p.id FROM products p JOIN packages k ON k.product_id=p.id WHERE k.id IN (?) ORDER BY p.id FOR UPDATE', [ids]);
    const result = await evaluate(normalized, db);
    if (body.pricingHash !== result.pricingHash) failure('Component prices changed. Review the refreshed preview before creating the bundle.', 409);
    if (result.output.blockers.length) failure(result.output.blockers.join(' '));
    const [created] = await db.query(`INSERT INTO enterprise_bundles
      (creation_key,remote_box_id,name,input_json,source_json,revision,edited_by,remote_captured_at,created_at,updated_at)
      VALUES (?,NULL,?,?,'{}',1,?,NULL,UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [key,result.input.name,JSON.stringify(result.input),actor]);
    await db.query(`INSERT INTO enterprise_bundle_revisions (bundle_id,revision,input_json,output_json,actor_id,created_at)
      VALUES (?,1,?,?,?,UTC_TIMESTAMP())`, [created.insertId,JSON.stringify(result.input),JSON.stringify(result.output),actor]);
    await db.commit(); return { id: created.insertId, revision: 1, remoteBoxId: null, remotePrices: [], ...result };
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}

export async function saveBundle(id, body, user) {
  await ensureEnterprisePricingSchema();
  const actor = Number(user?.userId ?? user?.id); if (!Number.isSafeInteger(actor) || actor <= 0) failure('An authenticated editor is required.', 403);
  const bundleId = positiveId(id), expected = Number(body?.expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 1 || typeof body.pricingHash !== 'string') failure('Refresh the bundle before saving.');
  const db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query('SELECT * FROM enterprise_bundles WHERE id=? FOR UPDATE', [bundleId]);
    if (!rows.length) failure('Bundle not found.', 404);
    if (rows[0].revision !== expected) failure('This bundle was edited elsewhere. Reload and review before saving.', 409);
    // Serialize with ordinary component-price saves, including prices changed
    // while this editor was open. Only the server calculates the frozen output.
    const normalized = normalizeBundle(body.input), ids = normalized.components.map(c => c.packageId).sort((a,b)=>a-b);
    await db.query('SELECT p.id FROM products p JOIN packages k ON k.product_id=p.id WHERE k.id IN (?) ORDER BY p.id FOR UPDATE', [ids]);
    const result = await evaluate(normalized, db);
    if (body.pricingHash !== result.pricingHash) failure('Component prices or inventory changed. Review the refreshed preview before saving.', 409);
    const revision = expected + 1;
    await db.query('UPDATE enterprise_bundles SET name=?,input_json=?,revision=?,edited_by=?,updated_at=UTC_TIMESTAMP() WHERE id=?',
      [result.input.name, JSON.stringify(result.input), revision, actor, bundleId]);
    await db.query('INSERT INTO enterprise_bundle_revisions (bundle_id,revision,input_json,output_json,actor_id,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())',
      [bundleId,revision,JSON.stringify(result.input),JSON.stringify(result.output),actor]);
    await db.commit();
    return { id: bundleId, revision, ...result };
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}

// Bootstrap the isolated clone from a captured, read-only Local Line export.
// Native box IDs are authoritative here; duplicate legacy product names are not
// used as publication mappings. Re-imports never overwrite an editor's work.
export async function importLocalBundles(snapshot, user) {
  if (process.env.CSA_LOCAL_ONLY !== 'true') failure('Bundle snapshot import is restricted to isolated local mode.', 403);
  await ensureEnterprisePricingSchema();
  const actor = positiveId(user?.userId ?? user?.id), db = await getPool().getConnection();
  try {
    await db.beginTransaction();
    const [vendors] = await db.query('SELECT id,name FROM vendors');
    const [links] = await db.query('SELECT package_id,local_line_package_id FROM local_line_package_meta');
    const [productLinks] = await db.query('SELECT product_id,local_line_product_id FROM local_line_product_meta');
    const imported = [], skipped = [];
    for (const remoteId of snapshot.legacyProductIds || []) {
      const matches = productLinks.filter(l => Number(l.local_line_product_id) === Number(remoteId));
      if (matches.length !== 1) failure(`Legacy bundle product ${remoteId} needs a unique local mapping.`);
      await db.query("INSERT IGNORE INTO enterprise_bundle_legacy_products (product_id,remote_product_id,reason,created_at) VALUES (?,?,'Local Line product endpoint identifies this record as a box',UTC_TIMESTAMP())",[matches[0].product_id,remoteId]);
    }
    for (const source of snapshot.boxes) {
      const boxId = positiveId(source.id);
      const [existing] = await db.query('SELECT id FROM enterprise_bundles WHERE remote_box_id=?', [boxId]);
      if (existing.length) { skipped.push(boxId); continue; }
      const vendor = snapshot.vendors.find(v => Number(v.id) === Number(source.vendor));
      const matches = vendors.filter(v => v.name?.trim().toLowerCase() === vendor?.name?.trim().toLowerCase());
      if (matches.length !== 1) failure(`${source.name}: vendor needs a unique local match.`);
      const components = (source.box_contents || []).flatMap(c => c.content_product_packages || []).map(c => {
        if (c.swaps?.length) failure(`${source.name}: review component substitutions before import.`);
        const candidates = links.filter(l => Number(l.local_line_package_id) === Number(c.product_package));
        if (candidates.length !== 1) failure(`${source.name}: package ${c.product_package} needs a unique mapping.`);
        return { packageId: candidates[0].package_id, quantity: c.quantity };
      });
      const input = { name: source.name, description: source.description || '', vendorId: matches[0].id, buyPrice: Number(source.price).toFixed(2),
        discountPercent: 5, visible: Boolean(source.visible), images: (source.images || []).map(i => i.full), components,
        inventoryMode: !source.track_inventory ? 'untracked' : source.inventory_type === 'dynamic' ? 'components' : 'separate', stock: source.inventory };
      const result = await evaluate(input, db);
      if (result.output.blockers.length) failure(`${source.name}: ${result.output.blockers.join(' ')}`);
      const [inserted] = await db.query(`INSERT INTO enterprise_bundles
        (remote_box_id,name,input_json,source_json,revision,edited_by,remote_captured_at,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
      [boxId,input.name,JSON.stringify(result.input),JSON.stringify(source),actor,new Date(snapshot.capturedAt)]);
      await db.query('INSERT INTO enterprise_bundle_revisions (bundle_id,revision,input_json,output_json,actor_id,created_at) VALUES (?,1,?,?,?,UTC_TIMESTAMP())',
        [inserted.insertId,JSON.stringify(result.input),JSON.stringify(result.output),actor]);
      imported.push({ id: inserted.insertId, remoteBoxId: boxId, name: input.name, priceCents: result.output.priceCents });
    }
    await db.commit(); return { imported, skipped, externalWrites: 0 };
  } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}
