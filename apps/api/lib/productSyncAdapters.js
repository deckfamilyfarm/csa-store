import crypto from "node:crypto";
import { getDb, getPool } from "../db.js";
import { getLocalLineAccessToken } from "../localLineAuth.js";
import {
  loadLocalLineSyncContext, stageLocalLineContext, buildLocalLinePricePayload, buildLocalLineCreatePayload,
  buildInventoryPayload, fetchLocalLineProduct, patchLocalLineProduct, createLocalLineProduct,
  fetchLocalLineProductUnits, createLocalLineProductImage, upsertLocalLineProductMeta
} from "../localLine.js";
import {
  loadApprovedSquarePricingRows, loadPackagesByProduct, buildSquarePriceAuditRow,
  buildVariationUpdateObject, batchRetrieveSquareObjects, pushReviewedSquareVariation, upsertReturnedSquareObjects
} from "./squareStoreSync.js";
import { same, preflight } from "./productSyncCore.js";
import { parseJson } from "./productSyncSchema.js";

const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row?.[key] ?? null]));
const number = value => value == null ? null : Number(value);
const normalized = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  value != null && !["name", "description", "unitOfMeasure", "packageCode", "unit", "trackType", "chargeType"].includes(key) && Number.isFinite(Number(value)) ? Number(value) : value]));
const sortById = rows => rows.slice().sort((a, b) => Number(a.id ?? a.packageId) - Number(b.id ?? b.packageId));
export function localLineInputs(context, includeInventory = true, includeVisibility = true) {
  return {
    categoryName: context.categoryName || "",
    product: normalized(pick(context.product, ["id", "name", "description", ...(includeVisibility ? ["visible"] : []), ...(includeInventory ? ["trackInventory", "inventory"] : []), "vendorId", "categoryId", "isDeleted"])),
    vendor: normalized(pick(context.vendor, ["id", "name", "sourceMultiplier", "priceListMarkup", "guestMarkup", "memberMarkup"])),
    profile: normalized(pick(context.profile, ["unitOfMeasure", "sourceUnitPrice", "minWeight", "maxWeight", "avgWeightOverride", "sourceMultiplier", "guestMarkup", "memberMarkup", "herdShareMarkup", "snapMarkup"])),
    sale: { onSale: Number(context.sale?.onSale ?? context.profile?.onSale ?? 0), saleDiscount: Number(context.sale?.saleDiscount ?? context.profile?.saleDiscount ?? 0) },
    packages: sortById(context.packages).map(row => normalized(pick(row, ["id", "name", "price", "unit", "numOfItems", "packageCode", "trackType", "chargeType", "visible", "trackInventory", "inventory"]))),
    weights: sortById(context.packages).map(pkg => {
      const meta = context.packageMeta.find(row => Number(row.packageId) === Number(pkg.id));
      return { packageId: Number(pkg.id), avgPackageWeight: number(meta?.avgPackageWeight), numOfItems: number(meta?.numOfItems) };
    }),
    imageUrls: context.imageUrls,
    config: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^LL_(PRICE_LIST_|MARKUP_|DAIRY_)/.test(key)).sort())
  };
}
export function localLineMapping(context) {
  return { productId: context.remoteId, packages: sortById(context.packages).map(pkg => ({
    packageId: Number(pkg.id), remoteId: Number(context.packageMeta.find(meta => Number(meta.packageId) === Number(pkg.id))?.localLinePackageId) || Number(pkg.id)
  })) };
}
function imagesOf(remote) {
  return (remote?.images || []).map((img, index) => ({ product_image: Number(img.product_image?.id ?? img.product_image ?? img.id), priority_order: Number(img.priority_order ?? index) })).sort((a, b) => a.priority_order - b.priority_order);
}
const numericFields = new Set(["unit_price", "package_price", "package_unit_price", "inventory_per_unit", "set_inventory", "adjustment_type", "adjustment_value", "calculated_value", "strikethrough_display_value", "max_units_per_order", "product_price_list_entry", "price_list"]);
const booleanFields = new Set(["visible", "track_inventory", "package_codes_enabled", "on_sale", "on_sale_toggle", "adjustment"]);
// The Backoffice v2 schema marks on_sale/package prices as derived read-only values;
// calculated_value and UI flags are not writable API fields. Confirm the inputs that produce them.
// https://localline.ca/swagger/backoffice/v2?format=openapi
const transientFields = new Set(["checked", "notSubmitted", "edited", "dirty", "base_price_used", "calculated_value", "on_sale", "package_price", "package_unit_price"]);
// Project precisely the reviewed PATCH fields, ignoring unrelated remote edits and API display helpers.
export function localLineProjection(remote, payload, desired = false) {
  if (!remote) return null;
  const result = {};
  for (const [key, expected] of Object.entries(payload)) {
    if (expected === undefined || transientFields.has(key)) continue;
    if (key === "packages") {
      result.packages = expected.map(pkg => localLineProjection(desired ? pkg : remote.packages?.find(row => Number(row.id) === Number(pkg.id)), pkg, desired));
    } else if (key === "price_list_entries") {
      result.price_list_entries = expected.map(entry => localLineProjection(desired ? entry : remote.price_list_entries?.find(row => Number(row.price_list_id ?? row.price_list) === Number(entry.price_list)), entry, desired));
    } else {
      let value = desired ? expected : remote[key];
      if (!desired && key === "set_inventory") value = remote.inventory ?? remote.current_inventory;
      if (!desired && ["package_price", "package_unit_price"].includes(key)) value = remote[key] ?? remote.unit_price;
      if (!desired && key === "price_list") value = remote.price_list_id ?? remote.price_list;
      if (!desired && key === "product_price_list_entry") value = remote.product_price_list_entry ?? remote.id;
      if (numericFields.has(key) || key === "id") value = number(value);
      if (booleanFields.has(key)) value = Boolean(value);
      result[key] = value ?? null;
    }
  }
  return result;
}
export const squareProjection = object => object ? {
  id: object.id, deleted: Boolean(object.is_deleted), itemId: object.item_variation_data?.item_id,
  pricingType: object.item_variation_data?.pricing_type,
  amount: number(object.item_variation_data?.price_money?.amount), currency: object.item_variation_data?.price_money?.currency
} : null;
function squareInputs(row, packages, audit) {
  return {
    productId: Number(row.productId), packageId: Number(row.packageId), vendorName: row.vendorName,
    productName: row.productName, categoryName: row.categoryName,
    sourceUnitPrice: audit.priceBasis === "vendor-retail-price" ? number(row.sourceUnitPrice) : null,
    packagePrice: audit.priceBasis === "local-package-price" ? number(packages.find(pkg => Number(pkg.id) === Number(row.packageId))?.price) : null,
    onSale: Number(row.saleOnSale ?? row.profileOnSale ?? 0), saleDiscount: Number(row.saleSaleDiscount ?? row.profileSaleDiscount ?? 0),
    priceBasis: audit.priceBasis, configuredCurrency: process.env.SQUARE_CURRENCY || "USD"
  };
}
const squareMapping = row => row ? pick(row, ["linkId", "squareItemId", "squareVariationId", "linkApprovedAt"]) : null;
export async function prepareSquareActions({ productIds = [], staged = {}, includeAllProducts = false } = {}) {
  const rows = (await loadApprovedSquarePricingRows([], { includeAllProducts: true })).filter(row =>
    (!productIds.length || productIds.includes(Number(row.productId))) &&
    (includeAllProducts || /deck family farm/i.test(row.vendorName || "")));
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct([...new Set(rows.map(row => Number(row.productId)))]);
  return rows.map(row => {
    const changes = staged[row.productId] || {};
    const next = { ...row, saleOnSale: changes.onSale ?? row.saleOnSale, saleSaleDiscount: changes.saleDiscount ?? row.saleSaleDiscount };
    const before = buildSquarePriceAuditRow(row, packagesByProductId, metaByPackageId);
    const audit = buildSquarePriceAuditRow(next, packagesByProductId, metaByPackageId);
    const remote = parseJson(row.squareRawJson);
    let desired = null;
    try {
      desired = remote && audit.status !== "blocked" ? squareProjection(buildVariationUpdateObject(remote, audit.proposedAmount, audit.currency)) : null;
    } catch (error) { audit.status = "blocked"; audit.message = error.message; }
    return {
      direction: "outgoing", platform: "square", kind: "price", productId: Number(row.productId), productName: row.productName,
      packageId: Number(row.packageId), packageName: audit.packageName, vendorName: row.vendorName,
      status: audit.status, message: audit.message, staged: changes,
      localBefore: squareInputs(row, packagesByProductId.get(Number(row.productId)) || [], before),
      localAfter: squareInputs(next, packagesByProductId.get(Number(row.productId)) || [], audit),
      mapping: squareMapping(row), remoteBefore: squareProjection(remote), desired,
      payload: { amount: audit.proposedAmount, currency: audit.currency },
      display: { current: { price: audit.remotePrice, currency: audit.currency }, proposed: { price: audit.proposedPrice, currency: audit.currency }, basis: audit.priceBasis }
    };
  });
}
export async function prepareLocalLineAction(product, staged = {}, { onRefresh } = {}) {
  if (process.env.LOCALLINE_TEST === "true" || process.env.LOCALLINE_UPDATE_PRICES === "false") throw new Error("Local Line publishing is disabled by server configuration.");
  const context = await loadLocalLineSyncContext(getDb(), product.id);
  if (!context.remoteId) {
    const [attempts] = await getPool().query(`SELECT ra.checkpoint_json FROM product_sync_release_actions ra
      JOIN product_sync_actions a ON a.id=ra.action_id WHERE a.product_id=? AND a.platform='localline' AND ra.checkpoint_json IS NOT NULL`, [product.id]);
    if (attempts.some(row => parseJson(row.checkpoint_json)?.createAttempted)) throw new Error("A previous Local Line creation needs reconciliation. Check and link the created product before approving another creation.");
  }
  if (context.categoryName?.trim().toLowerCase() === "membership" || context.product.isDeleted) throw new Error("Membership and deleted products are excluded from product sync.");
  const next = stageLocalLineContext(context, staged);
  const includeInventory = !context.remoteId || ["inventory", "trackInventory"].some(key => Object.hasOwn(staged, key));
  const token = await getLocalLineAccessToken();
  const remote = context.remoteId ? await fetchLocalLineProduct(context.remoteId, token) : null;
  // A pricing/image approval should not freeze visibility when no visibility change was reviewed.
  const includeVisibility = !remote || Object.hasOwn(staged, "visible") || Boolean(remote.visible) !== Boolean(next.product.visible);
  if (remote?.is_deleted) throw new Error("The Local Line product was deleted. Review its link first.");
  if (remote) await onRefresh?.();
  // Cache only: never overwrite products, packages, sales, formulas, or approved package links.
  if (remote) await upsertLocalLineProductMeta(getDb(), product.id, context.remoteId, { rawJson: JSON.stringify(remote), lastSyncedAt: new Date() });
  let payload, createPayload = null;
  if (remote) {
    payload = { ...buildLocalLinePricePayload(next, remote, next.sale), ...buildInventoryPayload({
      ...(includeInventory ? { inventory: next.product.inventory, trackInventory: next.product.trackInventory } : {}),
      ...(includeVisibility ? { visible: next.product.visible } : {})
    }) };
  } else {
    createPayload = buildLocalLineCreatePayload(next, await fetchLocalLineProductUnits(token));
    const fake = { packages: next.packages.map(pkg => ({ id: Number(pkg.id), price_list_entries: createPayload.product_price_list_entries.map(entry => ({ price_list: entry.price_list, product_price_list_entry: -entry.price_list, adjustment_type: 2 })) })) };
    payload = { ...buildLocalLinePricePayload({ ...next, packageMeta: [] }, fake, next.sale), ...buildInventoryPayload(next.product) };
  }
  const [receipts] = await getPool().query("SELECT * FROM product_sync_image_receipts WHERE product_id = ?", [product.id]);
  const receipt = receipts[0];
  const imageSources = next.imageUrls;
  const imagesMatch = !imageSources.length || (receipt && same(parseJson(receipt.sources_json), imageSources) && same(parseJson(receipt.remote_json), imagesOf(remote)));
  const action = {
    direction: "outgoing", platform: "localline", kind: remote ? "update" : "create", productId: Number(product.id), productName: product.name,
    vendorName: product.vendorName, staged, includeInventory, includeVisibility, mapping: localLineMapping(context),
    localBefore: localLineInputs(context, includeInventory, includeVisibility), localAfter: localLineInputs(next, includeInventory, includeVisibility),
    payload, createPayload, imageSources: imagesMatch ? [] : imageSources,
    remoteBefore: remote ? { fields: localLineProjection(remote, payload), images: imageSources.length && !imagesMatch ? imagesOf(remote) : null } : null,
    desired: { fields: localLineProjection(payload, payload, true), images: imageSources.length && !imagesMatch ? { sources: imageSources } : null }
  };
  action.status = same(action.remoteBefore, action.desired) ? "synced" : "changed";
  action.message = remote ? "" : "Create a new Local Line product, then set the reviewed package prices and images.";
  action.display = { current: action.remoteBefore, proposed: { ...action.desired, ...(createPayload ? { create: createPayload } : {}) } };
  return action;
}
export async function inspectAction(action, saveCheckpoint = async () => {}) {
  const checkpoint = action.checkpoint || {};
  if (action.platform === "square") {
    const row = (await loadApprovedSquarePricingRows([action.packageId], { includeAllProducts: true }))[0];
    const objects = await batchRetrieveSquareObjects([action.mapping.squareVariationId]);
    const remote = objects.find(obj => obj.id === action.mapping.squareVariationId) || null;
    let local = null;
    if (row) {
      const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct([action.productId]);
      const audit = buildSquarePriceAuditRow(row, packagesByProductId, metaByPackageId);
      local = squareInputs(row, packagesByProductId.get(action.productId) || [], audit);
    }
    return { local, mapping: squareMapping(row), remote: squareProjection(remote), desired: action.desired, object: remote };
  }
  if (action.kind === "create" && checkpoint.remoteId && !checkpoint.createdMapping) {
    await finishCreatedLink(action, checkpoint, await getLocalLineAccessToken(), saveCheckpoint);
  }
  const context = await loadLocalLineSyncContext(getDb(), action.productId);
  let mapping = localLineMapping(context);
  const ownedCreate = action.kind === "create" && checkpoint.remoteId && Number(context.remoteId) === Number(checkpoint.remoteId);
  if (ownedCreate && same(mapping, checkpoint.createdMapping)) mapping = action.mapping;
  if (checkpoint.createAttempted && !checkpoint.remoteId) {
    throw Object.assign(new Error("Local Line creation has an uncertain outcome. Check and link the remote product, then audit again; creation will not be resent."), { hold: true });
  }
  const remoteId = checkpoint.remoteId || context.remoteId;
  const remote = remoteId ? await fetchLocalLineProduct(remoteId, await getLocalLineAccessToken()) : null;
  if (remote?.is_deleted) throw Object.assign(new Error("The Local Line product was deleted. Review its link first."), { hold: true });
  const payload = checkpoint.payload || action.payload;
  const approvedImages = checkpoint.images?.length === action.imageSources.length ? checkpoint.images : null;
  return {
    local: localLineInputs(context, action.includeInventory !== false, action.includeVisibility !== false), mapping,
    remote: remote ? { fields: localLineProjection(remote, payload), images: action.imageSources.length ? imagesOf(remote) : null } : null,
    desired: { fields: localLineProjection(payload, payload, true), images: action.imageSources.length ? approvedImages || { sources: action.imageSources } : null },
    resumeBaseline: ownedCreate ? checkpoint.remoteBefore : undefined,
    object: remote, remoteId
  };
}
function bindCreatedPayload(action, created) {
  if (!Array.isArray(created.packages) || created.packages.length !== action.payload.packages.length) throw Object.assign(new Error("Created Local Line packages need manual match review."), { hold: true });
  const payload = structuredClone(action.payload);
  payload.packages = payload.packages.map(pkg => {
    const matches = created.packages.filter(row => row.name === pkg.name);
    if (matches.length !== 1) throw Object.assign(new Error("Created Local Line package names are ambiguous. Review matches."), { hold: true });
    const remote = matches[0];
    return { ...pkg, id: Number(remote.id), price_list_entries: pkg.price_list_entries.map(entry => {
      const live = remote.price_list_entries?.find(item => Number(item.price_list_id ?? item.price_list) === Number(entry.price_list))
        || created.product_price_list_entries?.find(item => Number(item.price_list_id ?? item.price_list) === Number(entry.price_list));
      if (!live) throw Object.assign(new Error("Created price-list membership needs review."), { hold: true });
      return { ...entry, product_price_list_entry: Number(live.product_price_list_entry ?? live.id) };
    }) };
  });
  return payload;
}
async function finishCreatedLink(action, checkpoint, token, saveCheckpoint) {
  const created = await fetchLocalLineProduct(checkpoint.remoteId, token);
  const payload = bindCreatedPayload(action, created);
  const context = await loadLocalLineSyncContext(getDb(), action.productId);
  if (context.remoteId && Number(context.remoteId) !== checkpoint.remoteId) {
    throw Object.assign(new Error("The Local Line match changed after creation. Review the confirmed remote product."), { hold: true });
  }
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("SELECT id FROM products WHERE id=? FOR UPDATE", [action.productId]);
    await connection.query(`INSERT INTO local_line_product_meta (product_id, local_line_product_id, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE local_line_product_id=VALUES(local_line_product_id), raw_json=VALUES(raw_json), updated_at=VALUES(updated_at)`, [action.productId, checkpoint.remoteId, JSON.stringify(created)]);
    for (let i = 0; i < action.payload.packages.length; i += 1) {
      const localPackageId = action.payload.packages[i].id;
      const remotePackageId = payload.packages[i].id;
      if (!context.packages.some(pkg => Number(pkg.id) === Number(localPackageId))) continue;
      const existingLink = context.packageMeta.find(meta => Number(meta.packageId) === Number(localPackageId));
      const originalLink = action.mapping.packages.find(pkg => pkg.packageId === Number(localPackageId));
      if (Number(existingLink?.localLinePackageId) > 0 && ![originalLink?.remoteId, remotePackageId].includes(Number(existingLink.localLinePackageId))) {
        throw Object.assign(new Error("A Local Line package match changed after creation. Review it before retrying."), { hold: true });
      }
      await connection.query(`INSERT INTO local_line_package_meta (package_id, product_id, local_line_package_id, created_at, updated_at)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE local_line_package_id=VALUES(local_line_package_id), updated_at=VALUES(updated_at)`, [localPackageId, action.productId, remotePackageId]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  checkpoint.payload = payload;
  checkpoint.createdMapping = localLineMapping(await loadLocalLineSyncContext(getDb(), action.productId));
  checkpoint.remoteBefore = checkpoint.createdProduct?.packages ? { fields: localLineProjection(checkpoint.createdProduct, payload), images: action.imageSources.length ? imagesOf(checkpoint.createdProduct) : null } : null;
  await saveCheckpoint(checkpoint);
}
export async function executeAction(action, current, saveCheckpoint) {
  if (action.platform === "square") {
    const checkpoint = action.checkpoint || {};
    // Preserve the exact request body and key across uncertain responses.
    if (!checkpoint.request) {
      checkpoint.request = buildVariationUpdateObject(current.object, action.payload.amount, action.payload.currency);
      checkpoint.idempotencyKey = crypto.randomUUID();
      await saveCheckpoint(checkpoint);
    }
    try {
      const result = await pushReviewedSquareVariation(checkpoint.request, checkpoint.idempotencyKey);
      if (result.objects?.length) await upsertReturnedSquareObjects(getPool(), result.objects, new Date());
    } catch (error) {
      if (error.remoteRejected) {
        // A definitive rejection permits a new versioned request after the next preflight.
        delete checkpoint.request;
        delete checkpoint.idempotencyKey;
        await saveCheckpoint(checkpoint);
      }
      throw error;
    }
    return;
  }
  if (process.env.LOCALLINE_TEST === "true" || process.env.LOCALLINE_UPDATE_PRICES === "false") throw new Error("Local Line publishing is disabled by server configuration.");
  const token = await getLocalLineAccessToken();
  const checkpoint = action.checkpoint || {};
  let remoteId = current.remoteId;
  let payload = checkpoint.payload || action.payload;
  if (action.kind === "create" && !checkpoint.remoteId) {
    if (checkpoint.createAttempted) throw Object.assign(new Error("Check the uncertain Local Line creation before reviewing again."), { hold: true });
    checkpoint.createAttempted = true;
    await saveCheckpoint(checkpoint);
    let created;
    try { created = await createLocalLineProduct(token, action.createPayload); }
    catch (error) {
      if (error.remoteRejected) { checkpoint.createAttempted = false; await saveCheckpoint(checkpoint); }
      else error.hold = true;
      throw error;
    }
    if (!(Number(created?.id) > 0)) throw Object.assign(new Error("Local Line did not confirm a new product id; inspect it before retrying."), { hold: true });
    checkpoint.remoteId = Number(created.id);
    checkpoint.createdProduct = created;
    // Save the remote id before any further calls. A retry can never issue another POST.
    await saveCheckpoint(checkpoint);
    remoteId = checkpoint.remoteId;
    await upsertLocalLineProductMeta(getDb(), action.productId, remoteId, { rawJson: JSON.stringify(created) });
  }
  if (action.kind === "create" && !checkpoint.createdMapping) {
    await finishCreatedLink(action, checkpoint, token, saveCheckpoint);
    remoteId = checkpoint.remoteId;
    payload = checkpoint.payload;
    current = await inspectAction(action, saveCheckpoint);
    const check = preflight(action, current, true);
    if (check.status === "held") throw Object.assign(new Error(check.message), { hold: true });
  }
  if (!same(current.remote?.fields, localLineProjection(payload, payload, true))) await patchLocalLineProduct(remoteId, token, payload);
  if (action.imageSources.length) {
    checkpoint.images ||= [];
    for (let i = checkpoint.images.length; i < action.imageSources.length; i += 1) {
      const response = await fetch(action.imageSources[i]);
      if (!response.ok) throw new Error(`Unable to read approved image ${i + 1}.`);
      const uploaded = await createLocalLineProductImage(token, Buffer.from(await response.arrayBuffer()), `product-${action.productId}-${i + 1}.jpg`, response.headers.get("content-type") || "image/jpeg");
      if (!(Number(uploaded?.id) > 0)) throw new Error("Local Line did not confirm the image upload.");
      checkpoint.images.push({ priority_order: i, product_image: Number(uploaded.id) });
      await saveCheckpoint(checkpoint);
    }
    await patchLocalLineProduct(remoteId, token, { images: checkpoint.images });
    const confirmed = await fetchLocalLineProduct(remoteId, token);
    if (!same(imagesOf(confirmed), checkpoint.images)) throw new Error("Local Line image confirmation is incomplete.");
    await getPool().query(`INSERT INTO product_sync_image_receipts (product_id, sources_json, remote_json) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE sources_json=VALUES(sources_json), remote_json=VALUES(remote_json)`, [action.productId, JSON.stringify(action.imageSources), JSON.stringify(checkpoint.images)]);
  }
}
