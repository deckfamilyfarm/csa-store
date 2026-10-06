import crypto from "node:crypto";
import { ensureSquareSyncSchema, getPool } from "../db.js";
import { withSyncLock } from "./productSyncSchema.js";
import { getCustomerFacingSaleDiscount, resolvePricingProfile } from "./productPricing.js";
import { computeSquareRetailPackagePrice, fetchSquare, getSquareConfig, listSquareCatalogItems,
  loadPackagesByProduct, upsertReturnedSquareObjects } from "./squareStoreSync.js";

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let schemaPromise;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureSquareSyncSchema();
    await getPool().query(`CREATE TABLE IF NOT EXISTS square_product_creations (
      product_id INT PRIMARY KEY, id CHAR(36) NOT NULL UNIQUE, status VARCHAR(24) NOT NULL,
      preview_json LONGTEXT NOT NULL, request_json LONGTEXT NOT NULL, target_hash CHAR(64) NOT NULL,
      result_json LONGTEXT, last_error TEXT, created_by INT, approved_by INT,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function targetHash() {
  const config = getSquareConfig();
  if (!config.accessToken) throw fail("Square is not configured.", 400);
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

// The same retail resolver used for Square price updates also sets initial prices.
export function buildSquareCreationPreview(source, packages, metaByPackageId = new Map()) {
  if (!source || source.isDeleted || normalize(source.categoryName) === "membership") throw fail("This product is not eligible for Square creation.", 400);
  if (!source.vendorId || !source.vendorName?.trim()) throw fail("Choose a valid vendor before creating the Square item.", 400);
  if (!source.productName?.trim() || !packages.length) throw fail("A product name and at least one package are required.", 400);
  const profile = resolvePricingProfile({
    profile: source.profile, product: { id: source.productId, name: source.productName }, packages,
    packageMetaByPackageId: metaByPackageId, vendor: source.vendor
  });
  if (profile.usesSourcePricing && (source.profile?.sourceUnitPrice == null || source.profile.sourceUnitPrice === "")) throw fail("Set the product’s Retail Price before creating it in Square.", 400);
  const variations = [...packages].sort((a, b) => a.id - b.id).map(pkg => {
    const price = computeSquareRetailPackagePrice({ ...profile, saleDiscount: getCustomerFacingSaleDiscount(profile) }, pkg);
    const amount = price.price == null ? null : Math.round(price.price * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw fail(`A valid retail price is required for ${pkg.name || "this package"}.`, 400);
    return { packageId: Number(pkg.id), name: String(pkg.name || "Regular").trim() || "Regular",
      sku: String(pkg.packageCode || "").trim(), amount, currency: getSquareConfig().currency, priceBasis: price.basis };
  });
  if (new Set(variations.map(row => normalize(row.name))).size !== variations.length) throw fail("Give each package a distinct name before creating Square variations.", 400);
  return { productId: Number(source.productId), productName: source.productName.trim(), vendorName: source.vendorName,
    environment: getSquareConfig().environment, presentAtAllLocations: true, variations };
}

export function squareCreationRequest(preview, id) {
  const availability = { present_at_all_locations: true };
  const itemId = `#product-${preview.productId}`;
  return { idempotency_key: id, object: { type: "ITEM", id: itemId, ...availability, item_data: {
    name: preview.productName, product_type: "REGULAR",
    variations: preview.variations.map(row => ({ type: "ITEM_VARIATION", id: `#package-${row.packageId}`, ...availability,
      item_variation_data: { item_id: itemId, name: row.name, ...(row.sku ? { sku: row.sku } : {}),
        pricing_type: "FIXED_PRICING", price_money: { amount: row.amount, currency: row.currency } } }))
  } } };
}

async function loadPreview(productId) {
  const [[row]] = await getPool().query(`SELECT p.id AS productId, p.name AS productName, p.is_deleted AS isDeleted,
    p.vendor_id AS vendorId, v.name AS vendorName, c.name AS categoryName,
    v.price_list_markup AS vendorPriceListMarkup, v.source_multiplier AS vendorSourceMultiplier,
    v.guest_markup AS vendorGuestMarkup, v.member_markup AS vendorMemberMarkup,
    pp.unit_of_measure AS unitOfMeasure, pp.source_unit_price AS sourceUnitPrice,
    pp.min_weight AS minWeight, pp.max_weight AS maxWeight, pp.avg_weight_override AS avgWeightOverride,
    pp.source_multiplier AS sourceMultiplier, pp.guest_markup AS guestMarkup, pp.member_markup AS memberMarkup,
    pp.herd_share_markup AS herdShareMarkup, pp.snap_markup AS snapMarkup,
    COALESCE(ps.on_sale,pp.on_sale,0) AS onSale, COALESCE(ps.sale_discount,pp.sale_discount,0) AS saleDiscount
    FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id LEFT JOIN product_sales ps ON ps.product_id=p.id WHERE p.id=?`, [productId]);
  if (!row) throw fail("Product not found.", 404);
  const { packagesByProductId, metaByPackageId } = await loadPackagesByProduct([productId]);
  return buildSquareCreationPreview({ ...row, profile: row, vendor: { id: row.vendorId, name: row.vendorName,
    priceListMarkup: row.vendorPriceListMarkup, sourceMultiplier: row.vendorSourceMultiplier,
    guestMarkup: row.vendorGuestMarkup, memberMarkup: row.vendorMemberMarkup } }, packagesByProductId.get(productId) || [], metaByPackageId);
}
async function requireUnlinked(productId, connection = getPool()) {
  const [links] = await connection.query("SELECT package_id FROM square_variation_links WHERE product_id=?", [productId]);
  if (links.length) throw fail("This product already has a Square link. Use its existing Square item instead of creating another.");
}
async function requireNoDuplicate(preview) {
  const items = await listSquareCatalogItems();
  const skus = new Set(preview.variations.map(row => row.sku.toLowerCase()).filter(Boolean));
  const duplicate = items.find(item => !item.is_deleted && (normalize(item.item_data?.name) === normalize(preview.productName)
    || (item.item_data?.variations || []).some(row => !row.is_deleted && skus.has(String(row.item_variation_data?.sku || "").toLowerCase()))));
  if (duplicate) throw fail(`Square already contains “${duplicate.item_data?.name || preview.productName}” with this name or SKU. Refresh Square Catalog and link the existing variation.`);
}
function view(row) {
  const result = parse(row.result_json);
  return { id: row.id, status: row.status, ...parse(row.preview_json), error: row.last_error || "",
    squareItemId: result?.catalog_object?.id || null, resuming: ["sending", "created"].includes(row.status) };
}

export async function previewSquareProductCreation(productId, userId) {
  if (!Number.isSafeInteger(productId) || productId <= 0) throw fail("A valid product is required.", 400);
  await ensureSchema();
  // Serialize creates across products so two local products cannot race the same name/SKU check.
  return withSyncLock("square-product-create", async connection => {
    const [[saved]] = await connection.query("SELECT * FROM square_product_creations WHERE product_id=?", [productId]);
    // An uncertain or successful request always wins over a new preview, even after unlinking.
    if (saved && ["sending", "created", "completed"].includes(saved.status)) return view(saved);
    const target = targetHash();
    const preview = await loadPreview(productId);
    await requireUnlinked(productId);
    await requireNoDuplicate(preview);
    if (saved?.status === "draft" && saved.target_hash === target && JSON.stringify(parse(saved.preview_json)) === JSON.stringify(preview)) return view(saved);
    const id = crypto.randomUUID();
    const request = squareCreationRequest(preview, id);
    await connection.query(`INSERT INTO square_product_creations (product_id,id,status,preview_json,request_json,target_hash,created_by,created_at,updated_at)
      VALUES (?,?,'draft',?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE id=VALUES(id),status='draft',
      preview_json=VALUES(preview_json),request_json=VALUES(request_json),target_hash=VALUES(target_hash),result_json=NULL,last_error=NULL,
      created_by=VALUES(created_by),approved_by=NULL,created_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP()`,
    [productId, id, JSON.stringify(preview), JSON.stringify(request), target, userId || null]);
    return { id, status: "draft", ...preview, resuming: false };
  });
}

export function creationLinks(preview, result, confirmed) {
  const mappings = new Map((result.id_mappings || []).map(row => [row.client_object_id, row.object_id]));
  const itemId = mappings.get(`#product-${preview.productId}`);
  if (!itemId || confirmed?.id !== itemId || confirmed.type !== "ITEM" || confirmed.is_deleted
    || confirmed.item_data?.name !== preview.productName) throw fail("The created Square item needs review before links can be saved.");
  const variations = confirmed.item_data?.variations || [];
  // Older in-flight requests retain their approved location settings when retried.
  if (preview.presentAtAllLocations && [confirmed, ...variations].some(object =>
    object.present_at_all_locations !== true || object.absent_at_location_ids?.length)) {
    throw fail("Square has not confirmed availability at all locations. Review the item’s location settings before finishing its links.");
  }
  return preview.variations.map(row => {
    const variationId = mappings.get(`#package-${row.packageId}`);
    const remote = variations.find(variation => variation.id === variationId);
    const data = remote?.item_variation_data;
    if (!variationId || remote?.type !== "ITEM_VARIATION" || remote?.is_deleted || data?.item_id !== itemId || data?.name !== row.name
      || (data.sku || "") !== row.sku || data.pricing_type !== "FIXED_PRICING" || data.price_money?.amount !== row.amount || data.price_money?.currency !== row.currency) {
      throw fail("Square creation could not be confirmed. Retry to finish linking the same item.");
    }
    return { productId: preview.productId, packageId: row.packageId, itemId, variationId };
  });
}

export async function applySquareProductCreation(id, userId) {
  await ensureSchema();
  const [[lookup]] = await getPool().query("SELECT product_id FROM square_product_creations WHERE id=?", [id]);
  if (!lookup) throw fail("This preview has expired. Open Create in Square again.", 404);
  return withSyncLock("square-product-create", async connection => {
    const [[saved]] = await connection.query("SELECT * FROM square_product_creations WHERE id=?", [id]);
    if (!saved) throw fail("This preview has changed. Open Create in Square again.");
    if (saved.status === "completed") return view(saved);
    if (saved.target_hash !== targetHash()) throw fail("Square connection settings changed. Restore the original connection before retrying this request.");
    const preview = parse(saved.preview_json);
    const previouslyAttempted = saved.status !== "draft";
    try {
      if (saved.status === "rejected") throw fail("Square rejected this request. Open Create in Square again for a new preview.");
      if (saved.status === "draft") {
        if (JSON.stringify(await loadPreview(saved.product_id)) !== JSON.stringify(preview)) throw fail("Product details or creation settings changed. Open Create in Square again to review them.");
        await requireUnlinked(saved.product_id);
        await requireNoDuplicate(preview);
        await connection.query("UPDATE square_product_creations SET status='sending',approved_by=?,last_error=NULL,updated_at=UTC_TIMESTAMP() WHERE id=?", [userId || null, id]);
        saved.status = "sending";
      }
      let result = parse(saved.result_json);
      if (!result) {
        try {
          // Square guarantees safe retries with the same key and object:
          // https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object
          result = await fetchSquare("/v2/catalog/object", { method: "POST", body: saved.request_json, signal: AbortSignal.timeout(30000) });
          if (!result.catalog_object?.id) throw fail("Square did not confirm creation. Retry the same request to check its result.", 502);
        } catch (error) {
          if (error.remoteRejected && !previouslyAttempted) await connection.query("UPDATE square_product_creations SET status='rejected' WHERE id=?", [id]);
          throw error;
        }
        // Save the remote receipt before any confirmation/cache/link work. Never recreate it.
        await connection.query("UPDATE square_product_creations SET status='created',result_json=?,updated_at=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(result), id]);
      }
      const remote = await fetchSquare(`/v2/catalog/object/${encodeURIComponent(result.catalog_object.id)}`, { signal: AbortSignal.timeout(30000) });
      const links = creationLinks(preview, result, remote.object);
      await connection.beginTransaction();
      try {
        const [packages] = await connection.query("SELECT id FROM packages WHERE product_id=? FOR UPDATE", [saved.product_id]);
        const [existing] = await connection.query("SELECT package_id,square_variation_id FROM square_variation_links WHERE product_id=? FOR UPDATE", [saved.product_id]);
        if (links.some(link => !packages.some(pkg => Number(pkg.id) === link.packageId)
          || existing.some(row => Number(row.package_id) === link.packageId && row.square_variation_id !== link.variationId))) throw fail("Local packages or links changed. The Square item was created; review its links before continuing.");
        await upsertReturnedSquareObjects(connection, [remote.object], new Date());
        for (const link of links) {
          if (existing.some(row => Number(row.package_id) === link.packageId)) continue;
          await connection.query(`INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,
            approved_by_user_id,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
          [link.productId, link.packageId, link.itemId, link.variationId, userId || null]);
        }
        await connection.query("UPDATE square_product_creations SET status='completed',last_error=NULL,updated_at=UTC_TIMESTAMP() WHERE id=?", [id]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      return view({ ...saved, status: "completed", result_json: result, last_error: null });
    } catch (error) {
      await connection.query("UPDATE square_product_creations SET last_error=?,updated_at=UTC_TIMESTAMP() WHERE id=?", [error.message, id]);
      throw error;
    }
  });
}
