import { activeLocalLinePriceListIds } from "./localLinePricingLists.js";
import crypto from "node:crypto";
import { getPool } from "../db.js";
import { ensureEnterprisePricingSchema } from "./enterprisePricingSchema.js";
import { buildSquarePromotionCatalogObjects, localLineSaleMatches, localLineSalePatch, promotionEndTime, normalizePromotion, promotionPrices, promotionsOverlap } from "./enterprisePromotionsCore.js";
import { fetchSquare, getSquareConfig, loadSquareMeasurementUnits, squareLocationPriceIssue } from "./squareStoreSync.js";
import { planSquareUnit } from "./squarePricingUnits.js";
import { fetchLocalLineProduct, patchLocalLineProduct, loadLocalLineSyncContext, verifyReviewedLocalLineVendor } from "../localLine.js";
import { getLocalLineAccessToken } from "../localLineAuth.js";
import { getDb } from "../db.js";
import { requireProductVendor } from "./productVendor.js";

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const actor = user => Number(user?.userId || user?.adminId);
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function view(row) {
  return { id: Number(row.id), status: row.status, input: parse(row.input_json), output: parse(row.output_json),
    editorId: Number(row.editor_id), approverId: row.approver_id ? Number(row.approver_id) : null,
    squareStatus: row.square_status, localLineStatus: row.localline_status,
    error: row.last_error, createdAt: row.created_at, approvedAt: row.approved_at };
}

export async function listEnterprisePromotions() {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query("SELECT * FROM enterprise_promotions ORDER BY id DESC LIMIT 100");
  return rows.map(view);
}

export async function getEnterprisePromotion(promotionId) {
  await ensureEnterprisePricingSchema();
  if (!validId(promotionId)) fail("Promotion ID is invalid.");
  const [rows] = await getPool().query("SELECT * FROM enterprise_promotions WHERE id=?", [promotionId]);
  if (!rows.length) fail("Promotion was not found.", 404);
  return view(rows[0]);
}

async function frozenPromotion(promotion, connection = getPool()) {
  const ids = promotion.packageIds;
  const [packages] = await connection.query(`SELECT p.id AS packageId, p.product_id AS productId, p.name AS packageName,
    s.active_revision_id AS activeRevisionId, r.status AS pricingStatus, r.input_json AS pricingInput, r.output_json AS pricingOutput,
    lm.local_line_package_id AS localLinePackageId, pm.local_line_product_id AS localLineProductId,
    l.square_variation_id AS squareVariationId
    FROM packages p LEFT JOIN enterprise_pricing_product_state s ON s.product_id=p.product_id
    LEFT JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id
    LEFT JOIN local_line_package_meta lm ON lm.package_id=p.id
    LEFT JOIN local_line_product_meta pm ON pm.product_id=p.product_id
    LEFT JOIN square_variation_links l ON l.package_id=p.id AND l.approved_at IS NOT NULL
    WHERE p.id IN (?)`, [ids]);
  if (packages.length !== ids.length) fail("One or more packages were not found or have duplicate Square links.", 409);
  const frozen = packages.map(pkg => {
    if (!pkg.activeRevisionId || (process.env.CSA_LOCAL_ONLY !== "true" && pkg.pricingStatus !== "active")) fail(`${pkg.packageName}: approve and verify regular enterprise pricing first.`, 409);
    const input = parse(pkg.pricingInput), output = parse(pkg.pricingOutput);
    const regular = output.packages.find(row => Number(row.packageId) === Number(pkg.packageId));
    if (!regular) fail(`${pkg.packageName}: approved package price is missing.`, 409);
    if (promotion.channels.includes("localline") && (!pkg.localLineProductId || !pkg.localLinePackageId)) fail(`${pkg.packageName}: Local Line package mapping is missing.`, 409);
    if (promotion.channels.includes("square") && (!input.squareEnabled || !pkg.squareVariationId)) fail(`${pkg.packageName}: Square eligibility or approved variation mapping is missing.`, 409);
    return { packageId: Number(pkg.packageId), productId: Number(pkg.productId), packageName: pkg.packageName,
      activeRevisionId: Number(pkg.activeRevisionId), localLinePackageId: pkg.localLinePackageId,
      localLineProductId: pkg.localLineProductId, squareVariationId: pkg.squareVariationId,
      localLineRegularCents: regular.localLineRegularCents, squareRegularCents: regular.squareVariationCents,
      pricingUnit: input.pricingUnit };
  });
  return { packages: frozen, localLinePrices: promotionPrices(frozen, promotion.endSale ? 0 : promotion.discountBp) };
}

async function checkOverlaps(promotion, excludeId = null, connection = getPool()) {
  const [rows] = await connection.query("SELECT id, status, input_json AS inputJson FROM enterprise_promotions WHERE status IN ('pending','approved','scheduled','active','partial','cancelling')");
  const overlapping = rows.find(row => (row.status !== 'pending' || parse(row.inputJson)?.localProductId) && !promotion.supersedes?.includes(Number(row.id)) && Number(row.id) !== Number(excludeId) && promotionsOverlap(promotion, parse(row.inputJson)));
  if (overlapping) fail(`Promotion ${overlapping.id} overlaps these packages and channels. Review or cancel it first.`, 409);
}

export async function previewEnterprisePromotion(input) {
  await ensureEnterprisePricingSchema();
  const promotion = normalizePromotion(input);
  await checkOverlaps(promotion);
  return { input: promotion, output: await frozenPromotion(promotion) };
}

export async function saveEnterprisePromotionDraft(input, user) {
  const preview = await previewEnterprisePromotion(input);
  const [result] = await getPool().query(`INSERT INTO enterprise_promotions
    (status, input_json, output_json, editor_id, created_at, updated_at)
    VALUES ('pending', ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [JSON.stringify(preview.input), JSON.stringify(preview.output), actor(user)]);
  await getPool().query(`INSERT INTO enterprise_promotion_events (promotion_id, event, actor_id, details_json, created_at)
    VALUES (?, 'drafted', ?, ?, UTC_TIMESTAMP())`, [result.insertId, actor(user), JSON.stringify(preview)]);
  return { id: Number(result.insertId), status: "pending", ...preview };
}

export async function approveEnterprisePromotion(promotionId, user) {
  await ensureEnterprisePricingSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT * FROM enterprise_promotions WHERE id=? FOR UPDATE", [promotionId]);
    if (!rows.length || rows[0].status !== "pending") fail("Promotion is no longer pending.", 409);
    const row = rows[0], input = parse(row.input_json), original = parse(row.output_json);
    if(input.localProductId) {
      const [states]=await connection.query('SELECT promotion_id FROM enterprise_product_sales WHERE product_id=? FOR UPDATE',[input.localProductId]);
      if(Number(states[0]?.promotion_id)!==Number(promotionId)) fail('The local sale changed. Review its latest version.',409);
      if(input.channels.includes('square') && !input.squareLocationIds?.length) fail('Configure the Square sale locations before approval.',409);
    }
    const productIds = input.localProductId ? [input.localProductId] : [...new Set(original.packages.map(pkg => Number(pkg.productId)))];
    const [pricingStates] = await connection.query(`SELECT s.product_id AS productId, s.latest_revision_id AS latestRevisionId,
      s.active_revision_id AS activeRevisionId, r.status AS latestStatus
      FROM enterprise_pricing_product_state s LEFT JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
      WHERE s.product_id IN (?) FOR UPDATE`, [productIds]);
    if (pricingStates.length !== productIds.length || pricingStates.some(state =>
      Number(state.latestRevisionId) !== Number(state.activeRevisionId) && state.latestStatus !== "rejected")) {
      fail("Resolve pending regular pricing before approving this sale.", 409);
    }
    const [unfinished] = await connection.query(`SELECT ra.id FROM product_sync_release_actions ra
      JOIN product_sync_actions a ON a.id=ra.action_id
      WHERE a.product_id IN (?) AND ra.status IN ('pending','working','failed','held') LIMIT 1`, [productIds]);
    if (unfinished.length) fail("Resolve the existing price publication before approving this sale.", 409);
    const [settings] = await connection.query("SELECT settings_json AS settingsJson FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1");
    if (parse(settings[0].settingsJson).requireDifferentApprover !== false && actor(user) === Number(row.editor_id)) fail("A different publisher must approve this promotion.", 403);
    if (promotionEndTime(input) <= Date.now()) fail("Promotion has already expired. Save a new proposal.", 409);
    await checkOverlaps(input, promotionId, connection);
    const refreshed = await frozenPromotion(input, connection);
    if(input.localProductId && refreshed.packages.some(p=>Number(p.activeRevisionId)!==Number(input.regularRevisionId))) fail('Regular pricing changed. Save the sale again before approval.',409);
    if (!input.localProductId && JSON.stringify(original) !== JSON.stringify(refreshed)) fail("Regular prices or mappings changed. Save a new promotion proposal.", 409);
    if(input.localProductId) await connection.query('UPDATE enterprise_promotions SET output_json=? WHERE id=?',[JSON.stringify(refreshed),promotionId]);
    const squareObjects = !input.endSale && input.channels.includes("square")
      ? buildSquarePromotionCatalogObjects(promotionId, input, refreshed.packages.map(pkg => pkg.squareVariationId)) : [];
    const squareRequest = squareObjects.length ? { idempotency_key: crypto.randomUUID(), batches: [{ objects: squareObjects }] } : null;
    await connection.query(`UPDATE enterprise_promotions SET status='approved', approver_id=?, approved_at=UTC_TIMESTAMP(),
      square_request_key=?, square_request_json=?, square_status=?, localline_status=?, updated_at=UTC_TIMESTAMP() WHERE id=?`,
      [actor(user), squareRequest?.idempotency_key || null, squareRequest ? JSON.stringify(squareRequest) : null,
        squareRequest ? "pending" : "excluded", input.channels.includes("localline") ? "pending" : "excluded", promotionId]);
    await connection.query(`INSERT INTO enterprise_promotion_events (promotion_id, event, actor_id, details_json, created_at)
      VALUES (?, 'approved', ?, ?, UTC_TIMESTAMP())`, [promotionId, actor(user), JSON.stringify({ input, output: refreshed })]);
    await connection.commit();
    return { id: Number(promotionId), status: "approved", squareObjects: squareObjects.length };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function lockedPromotion(promotionId, fn) {
  await ensureEnterprisePricingSchema();
  if (!validId(promotionId)) fail("Promotion ID is invalid.");
  const connection = await getPool().getConnection();
  const lock = `csa-enterprise-promotion-${promotionId}`;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    if (Number(rows[0]?.acquired) !== 1) fail("This sale is being published by another process. Check its status shortly.", 409);
    const [promotions] = await connection.query("SELECT * FROM enterprise_promotions WHERE id=?", [promotionId]);
    if (!promotions.length) fail("Promotion was not found.", 404);
    return await fn(promotions[0], connection);
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lock]).catch(() => {});
    connection.release();
  }
}

async function event(connection, promotionId, name, user, details) {
  await connection.query(`INSERT INTO enterprise_promotion_events (promotion_id, event, actor_id, details_json, created_at)
    VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`, [promotionId, name, user ? actor(user) : null, JSON.stringify(details),]);
}

async function assertFrozenPromotion(row, connection, checkConflicts = true) {
  const input = parse(row.input_json);
  if (checkConflicts) await checkOverlaps(input, row.id, connection);
  const current = await frozenPromotion(input, connection);
  if (JSON.stringify(current) !== JSON.stringify(parse(row.output_json))) fail("Regular prices or mappings changed. Review the sale again.", 409);
  return { input, output: current };
}

function squarePublicationAllowed() {
  if (process.env.CSA_LOCAL_ONLY === "true") fail("Remote promotion publishing is disabled in the local-only workspace.", 409);
  if (!process.env.SQUARE_ACCESS_TOKEN) fail("Square publishing is not configured on this server.", 409);
  const hostname = new URL(getSquareConfig().baseUrl).hostname;
  const sandbox = hostname === "connect.squareupsandbox.com" || hostname.endsWith(".test") || ["localhost", "127.0.0.1"].includes(hostname);
  if (!sandbox && process.env.SQUARE_PROMOTION_POS_VERIFIED !== "true") {
    fail("Square automatic discounts need a verified farmers-market POS pilot before production publication.", 409);
  }
}

async function checkExternalSquareRules(input) {
  const [finished] = await getPool().query("SELECT id, square_receipt_json AS receiptJson FROM enterprise_promotions WHERE status IN ('expired','cancelled') AND square_receipt_json IS NOT NULL");
  const managedFinishedRules = new Set(finished.map(row => parse(row.receiptJson)?.id_mappings?.find(item => item.client_object_id === `#csa-promo-${row.id}-rule`)?.object_id).filter(Boolean));
  let cursor = null;
  do {
    const query = new URLSearchParams({ types: "PRICING_RULE" });
    if (cursor) query.set("cursor", cursor);
    const result = await fetchSquare(`/v2/catalog/list?${query}`);
    for (const rule of result.objects || []) {
      if (rule.is_deleted || rule.pricing_rule_data?.application_mode !== "AUTOMATIC") continue;
      if (managedFinishedRules.has(rule.id)) continue;
      const locations = rule.present_at_all_locations ? input.squareLocationIds : rule.present_at_location_ids || [];
      if (locations.some(id => input.squareLocationIds.includes(id))) fail("An existing Square automatic discount applies at a selected location. Review stacking in Square before publishing this sale.", 409);
    }
    cursor = result.cursor || null;
  } while (cursor);
}

async function preflightSquareVariations(output) {
  const ids = [...new Set(output.packages.map(pkg => String(pkg.squareVariationId)))];
  const [result, units] = await Promise.all([
    fetchSquare("/v2/catalog/batch-retrieve", { method: "POST", body: JSON.stringify({ object_ids: ids }) }),
    loadSquareMeasurementUnits()
  ]);
  for (const pkg of output.packages) {
    const variation = (result.objects || []).find(row => row.id === pkg.squareVariationId);
    if (!variation || variation.is_deleted || variation.type !== "ITEM_VARIATION") fail(`${pkg.packageName}: approved Square variation is missing or deleted.`, 409);
    if (variation.item_variation_data?.pricing_type !== "FIXED_PRICING") fail(`${pkg.packageName}: Square variation pricing type changed.`, 409);
    if (Number(variation.item_variation_data?.price_money?.amount) !== Number(pkg.squareRegularCents)) fail(`${pkg.packageName}: regular Square price drifted. Review it before publishing this discount.`, 409);
    const locationIssue = squareLocationPriceIssue(variation);
    if (locationIssue) fail(locationIssue, 409);
    const unit = planSquareUnit(pkg.pricingUnit, variation, units);
    if (unit.issues.length || unit.changed) fail(`${pkg.packageName}: Square selling unit changed or needs review. ${unit.issues.join(" ")}`, 409);
  }
}

// The frozen request and idempotency key survive a lost response. Retrying sends
// the identical Square batch and then retrieves every created catalog object.
export async function publishEnterpriseSquarePromotion(promotionId, user) {
  return lockedPromotion(promotionId, async (row, connection) => {
    if (!["approved", "scheduled", "partial"].includes(row.status)) fail("Approve the sale before publishing.", 409);
    if (row.square_status === "excluded") fail("This sale does not include Square.", 409);
    if (row.square_status === "verified") return view(row);
    squarePublicationAllowed();
    const { input, output } = await assertFrozenPromotion(row, connection);
    if (promotionEndTime(input) <= Date.now()) fail("This sale has ended; its Square discount cannot be published.", 409);
    if (input.channels.includes("localline")) await preflightLocalLinePromotion(output, row.localline_status !== "pending");
    await preflightSquareVariations(output);
    const request = parse(row.square_request_json);
    if (!request?.idempotency_key || !request?.batches?.[0]?.objects?.length) fail("Approved Square discount request is missing.", 409);
    if (!row.square_receipt_json && !["uncertain", "sending", "confirming"].includes(row.square_status)) await checkExternalSquareRules(input);
    await connection.query("UPDATE enterprise_promotions SET square_status='sending', updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
    let receipt = parse(row.square_receipt_json);
    try {
      if (!receipt) {
        receipt = await fetchSquare("/v2/catalog/batch-upsert", { method: "POST", body: JSON.stringify(request) });
        await connection.query("UPDATE enterprise_promotions SET square_receipt_json=?, square_status='confirming', updated_at=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(receipt), promotionId]);
      }
      const objects = request.batches[0].objects;
      const mappings = new Map((receipt.id_mappings || []).map(item => [item.client_object_id, item.object_id]));
      const ids = objects.map(object => mappings.get(object.id) || receipt.objects?.find(item => item.id === object.id)?.id);
      if (ids.some(id => !id)) fail("Square did not return all managed discount object IDs. Inspect the saved receipt before retrying.", 409);
      const confirmed = await fetchSquare("/v2/catalog/batch-retrieve", { method: "POST", body: JSON.stringify({ object_ids: ids, include_related_objects: false }) });
      if (ids.some(id => !(confirmed.objects || []).some(object => object.id === id && !object.is_deleted))) fail("Square has not confirmed every sale rule object yet.", 409);
      await connection.query("UPDATE enterprise_promotions SET square_status='verified', status='scheduled', last_error=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
      await event(connection, promotionId, "square_verified", user, { ids, requestKey: request.idempotency_key });
      return getEnterprisePromotion(promotionId);
    } catch (error) {
      await connection.query("UPDATE enterprise_promotions SET square_status='uncertain', status='partial', last_error=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [error.message, promotionId]);
      await event(connection, promotionId, "square_uncertain", user, { error: error.message });
      throw error;
    }
  });
}

function priceListIds() {
  return activeLocalLinePriceListIds();
}

async function preflightLocalLinePromotion(output, allowAppliedSale = false) {
  if (process.env.LOCALLINE_TEST === "true" || process.env.LOCALLINE_UPDATE_PRICES === "false" || !process.env.LL_USERNAME || !process.env.LL_PASSWORD) {
    fail("Local Line sale publishing is disabled on this server.", 409);
  }
  const listIds = priceListIds();
  const token = await getLocalLineAccessToken();
  const byProduct = new Map();
  for (const pkg of output.packages) {
    if (!byProduct.has(pkg.productId)) byProduct.set(pkg.productId, []);
    const prices = output.localLinePrices.find(item => item.packageId === pkg.packageId);
    byProduct.get(pkg.productId).push({ ...pkg, regularCents: prices.regularCents, saleCents: prices.saleCents });
  }
  for (const [productId, selected] of byProduct) {
    const context = await loadLocalLineSyncContext(getDb(), productId);
    requireProductVendor(context.product, context.vendor);
    if (Number(context.remoteId) !== Number(selected[0].localLineProductId)) fail("Local Line product mapping changed. Review the sale again.", 409);
    const remote = await fetchLocalLineProduct(context.remoteId, token);
    await verifyReviewedLocalLineVendor(context, Number(remote.vendor?.id ?? remote.vendor), token);
    for (const pkg of selected) {
      if (!localLineSaleMatches(remote, [pkg], listIds, false) && !(allowAppliedSale && localLineSaleMatches(remote, [pkg], listIds, true))) {
        fail(`${pkg.packageName}: Local Line regular price or basket mapping changed. Review it before publishing the sale.`, 409);
      }
    }
  }
}

export async function publishEnterpriseLocalLinePromotion(promotionId, user = null, now = new Date(), forceRestore = false) {
  return lockedPromotion(promotionId, async (row, connection) => {
    if (!["approved", "scheduled", "active", "partial", "cancelling"].includes(row.status)) fail("Approve the sale before publishing.", 409);
    if (row.localline_status === "excluded") fail("This sale does not include Local Line.", 409);
    if (process.env.CSA_LOCAL_ONLY === "true" || process.env.LOCALLINE_TEST === "true" || process.env.LOCALLINE_UPDATE_PRICES === "false" || !process.env.LL_USERNAME || !process.env.LL_PASSWORD) {
      fail("Local Line sale publishing is disabled on this server.", 409);
    }
    const { input, output } = await assertFrozenPromotion(row, connection, !forceRestore);
    const nowMs = now.getTime();
    if (!forceRestore && nowMs < Date.parse(input.startAt)) {
      await connection.query("UPDATE enterprise_promotions SET status='scheduled', updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
      return getEnterprisePromotion(promotionId);
    }
    const saleActive = !forceRestore && nowMs < promotionEndTime(input);
    if (saleActive && row.square_status !== "excluded" && row.square_status !== "verified") {
      fail("Square automatic discount must be verified before the Local Line sale begins.", 409);
    }
    if (!saleActive && row.localline_status === "pending") {
      await connection.query("UPDATE enterprise_promotions SET status=?, localline_status='restored', updated_at=UTC_TIMESTAMP() WHERE id=?", [forceRestore ? "cancelled" : "expired", promotionId]);
      return getEnterprisePromotion(promotionId);
    }
    const listIds = priceListIds();
    const token = await getLocalLineAccessToken();
    const byProduct = new Map();
    for (const pkg of output.packages) {
      if (!byProduct.has(pkg.productId)) byProduct.set(pkg.productId, []);
      const prices = output.localLinePrices.find(item => item.packageId === pkg.packageId);
      byProduct.get(pkg.productId).push({ ...pkg, regularCents: prices.regularCents, saleCents: prices.saleCents });
    }
    try {
      for (const [productId, selected] of byProduct) {
        const context = await loadLocalLineSyncContext(getDb(), productId);
        requireProductVendor(context.product, context.vendor);
        if (Number(context.remoteId) !== Number(selected[0].localLineProductId)) fail("Local Line product mapping changed. Review the sale again.", 409);
        const remote = await fetchLocalLineProduct(context.remoteId, token);
        const remoteVendor = Number(remote.vendor?.id ?? remote.vendor);
        await verifyReviewedLocalLineVendor(context, remoteVendor, token);
        for (const pkg of selected) {
          if (!localLineSaleMatches(remote, [pkg], listIds, false) && !localLineSaleMatches(remote, [pkg], listIds, true)) {
            fail(`${pkg.packageName}: Local Line price changed outside this approved sale. Review it before retrying.`, 409);
          }
        }
        if (!localLineSaleMatches(remote, selected, listIds, saleActive)) {
          const payload = localLineSalePatch(remote, selected, listIds, saleActive);
          await patchLocalLineProduct(context.remoteId, token, payload);
          const confirmed = await fetchLocalLineProduct(context.remoteId, token);
          if (!localLineSaleMatches(confirmed, selected, listIds, saleActive)) fail("Local Line did not confirm all three active sale basket prices. Review the remote product before retrying.", 409);
        }
      }
      const status = saleActive ? "active" : forceRestore ? "cancelled" : "expired";
      const localLineStatus = saleActive ? "active" : "restored";
      await connection.query("UPDATE enterprise_promotions SET status=?, localline_status=?, last_error=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?", [status, localLineStatus, promotionId]);
      await event(connection, promotionId, saleActive ? "localline_activated" : "localline_restored", user, { packageIds: input.packageIds });
      return getEnterprisePromotion(promotionId);
    } catch (error) {
      // Keep the stop intent durable. A failed restore must retry turning the
      // sale off, never return to the ordinary activation path in the runner.
      await connection.query("UPDATE enterprise_promotions SET status=?, localline_status='uncertain', last_error=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [forceRestore ? "cancelling" : "partial", error.message, promotionId]);
      await event(connection, promotionId, "localline_uncertain", user, { error: error.message });
      throw error;
    }
  });
}

export async function publishEnterprisePromotion(promotionId, user = null, now = new Date()) {
  const promotion=await getEnterprisePromotion(promotionId);
  if(!promotion.input.localProductId) return publishPromotion(promotionId,user,now);
  const db=await getPool().getConnection(), lock=`csa-product-sale-${promotion.input.localProductId}`;
  let acquired=false;
  try {
    const [held]=await db.query('SELECT GET_LOCK(?,0) AS acquired',[lock]);
    acquired=Number(held[0].acquired)===1;
    if(!acquired) fail('This product sale is being saved or published. Try again shortly.',409);
    return await publishPromotion(promotionId,user,now);
  } finally {if(acquired) await db.query('SELECT RELEASE_LOCK(?)',[lock]);db.release();}
}
async function publishPromotion(promotionId, user = null, now = new Date()) {
  const promotion = await getEnterprisePromotion(promotionId);
  if (promotion.status === "cancelling") return cancelEnterprisePromotion(promotionId, user);
  if(promotion.input.localProductId) {
    if(!['approved','scheduled','active','partial'].includes(promotion.status)) fail('Approve the sale before publishing.',409);
    const [states]=await getPool().query('SELECT promotion_id FROM enterprise_product_sales WHERE product_id=?',[promotion.input.localProductId]);
    if(Number(states[0]?.promotion_id)!==Number(promotionId)) fail('The local sale changed. Review its latest version.',409);
    // Validate both destinations before retiring the old managed sale.
    if(promotion.input.channels.includes('square')) { squarePublicationAllowed(); await preflightSquareVariations(promotion.output); }
    for(const previous of promotion.input.supersedes || []) {
      const old=await getEnterprisePromotion(previous);
      if(!['cancelled','expired'].includes(old.status) && old.input.channels.includes('localline')) await preflightLocalLinePromotion(old.output,true);
    }
    for(const previous of promotion.input.supersedes || []) await cancelEnterprisePromotion(previous,user);
    if(promotion.input.endSale) {
      await getPool().query("UPDATE enterprise_promotions SET status='cancelled',square_status='cancelled',localline_status='restored',updated_at=UTC_TIMESTAMP() WHERE id=?",[promotionId]);
      return getEnterprisePromotion(promotionId);
    }
  }
  if (promotion.input.channels.includes("square") && promotion.squareStatus !== "verified" && now.getTime() < promotionEndTime(promotion.input)) {
    await publishEnterpriseSquarePromotion(promotionId, user);
  }
  if (promotion.input.channels.includes("localline")) return publishEnterpriseLocalLinePromotion(promotionId, user, now);
  if (now.getTime() >= promotionEndTime(promotion.input) && promotion.squareStatus === "pending") {
    await getPool().query("UPDATE enterprise_promotions SET status='expired', square_status='expired', updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
    return getEnterprisePromotion(promotionId);
  }
  const status = now.getTime() >= promotionEndTime(promotion.input) ? "expired"
    : now.getTime() >= Date.parse(promotion.input.startAt) ? "active" : "scheduled";
  await getPool().query("UPDATE enterprise_promotions SET status=?, updated_at=UTC_TIMESTAMP() WHERE id=? AND square_status='verified'", [status, promotionId]);
  return getEnterprisePromotion(promotionId);
}

export async function cancelEnterprisePromotion(promotionId, user) {
  const [desired]=await getPool().query('SELECT product_id FROM enterprise_product_sales WHERE promotion_id=?',[promotionId]);
  if(desired.length) fail('Set the product sale to 0% in Pricing, then publish that change.',409);
  const marked = await lockedPromotion(promotionId, async (row, connection) => {
    if (["cancelled", "expired"].includes(row.status)) return view(row);
    if (!["pending", "approved", "scheduled", "active", "partial", "cancelling"].includes(row.status)) fail("This sale cannot be cancelled.", 409);
    if (row.status === "pending") {
      await connection.query("UPDATE enterprise_promotions SET status='cancelled', cancelled_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
      await event(connection, promotionId, "cancelled", user, { beforeApproval: true });
      return getEnterprisePromotion(promotionId);
    }
    await connection.query("UPDATE enterprise_promotions SET status='cancelling', cancelled_at=COALESCE(cancelled_at, UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
    return getEnterprisePromotion(promotionId);
  });
  if (marked.status !== "cancelling") return marked;
  if (["verified", "uncertain"].includes(marked.squareStatus)) {
    await lockedPromotion(promotionId, async (row, connection) => {
      squarePublicationAllowed();
      const receipt = parse(row.square_receipt_json);
      const ruleClientId = `#csa-promo-${promotionId}-rule`;
      const ruleId = receipt?.id_mappings?.find(item => item.client_object_id === ruleClientId)?.object_id;
      if (!ruleId) fail("Managed Square rule ID is missing. Resolve its saved receipt before cancelling.", 409);
      try {
        try { await fetchSquare(`/v2/catalog/object/${encodeURIComponent(ruleId)}`, { method: "DELETE" }); }
        catch (error) { if (!/\(404\)/.test(error.message)) throw error; }
        const found = await fetchSquare("/v2/catalog/batch-retrieve", { method: "POST", body: JSON.stringify({ object_ids: [ruleId], include_deleted_objects: true }) });
        if ((found.objects || []).some(object => object.id === ruleId && !object.is_deleted)) fail("Square pricing rule is still active. Check it before restoring Local Line.", 409);
        await connection.query("UPDATE enterprise_promotions SET square_status='cancelled', updated_at=UTC_TIMESTAMP() WHERE id=?", [promotionId]);
        await event(connection, promotionId, "square_cancelled", user, { ruleId });
      } catch (error) {
        await connection.query("UPDATE enterprise_promotions SET square_status='uncertain', last_error=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [error.message, promotionId]);
        throw error;
      }
    });
  } else if (!["excluded", "cancelled", "pending"].includes(marked.squareStatus)) {
    fail("Square discount has an uncertain result. Confirm its catalog rule before restoring Local Line.", 409);
  }
  if (marked.localLineStatus === "excluded") {
    await getPool().query("UPDATE enterprise_promotions SET status='cancelled', cancelled_at=COALESCE(cancelled_at, UTC_TIMESTAMP()) WHERE id=?", [promotionId]);
    return getEnterprisePromotion(promotionId);
  }
  const restored = await publishEnterpriseLocalLinePromotion(promotionId, user, new Date(), true);
  if (restored.status === "cancelled") {
    await getPool().query("UPDATE enterprise_promotions SET status='cancelled', cancelled_at=COALESCE(cancelled_at, UTC_TIMESTAMP()) WHERE id=?", [promotionId]);
  }
  return getEnterprisePromotion(promotionId);
}

export async function runDueEnterprisePromotions(now = new Date()) {
  await ensureEnterprisePricingSchema();
  const [rows] = await getPool().query(`SELECT id FROM enterprise_promotions
    WHERE (status IN ('approved','scheduled','active','partial') AND JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.startAt')) <= ?)
       OR status='cancelling'
    ORDER BY id LIMIT 100`, [now.toISOString()]);
  const results = [];
  for (const row of rows) {
    try { results.push({ id: Number(row.id), status: (await publishEnterprisePromotion(row.id, null, now)).status }); }
    catch (error) { results.push({ id: Number(row.id), error: error.message }); }
  }
  return results;
}
