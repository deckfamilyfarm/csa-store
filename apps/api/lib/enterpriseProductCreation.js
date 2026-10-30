import { productBasketFlags } from './productBasketEligibility.js';
import { createHash } from "node:crypto";
import { getPool } from "../db.js";
import { validateVendorAssignment } from "./productVendor.js";
import { getPricingSettings, listPricingEnterprises, normalizeInput, persistEnterprisePricingRevision } from "./enterprisePricingService.js";
import { roundRatio } from "./enterprisePricingEngine.js";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function prepare(body, db = getPool()) {
  const [settings, enterprises] = await Promise.all([getPricingSettings(), listPricingEnterprises()]);
  const vendor = await validateVendorAssignment(db, body?.product?.vendorId);
  const name = String(body.product.name || "").trim();
  if (!name || name.length > 255) fail("Enter a product name of 1–255 characters.");
  const categoryId = body.product.categoryId ? Number(body.product.categoryId) : null;
  let categoryName = "";
  if (categoryId !== null) {
    const [[category]] = await db.query("SELECT name FROM categories WHERE id=?", [categoryId]);
    if (!category) fail("Select an existing category.");
    categoryName = category.name;
  }
  const product = { name, vendorId: Number(vendor.id), vendorName: vendor.name, categoryId, categoryName,
    ...productBasketFlags(body.product, vendor.name), description: String(body.product.description || "") };
  if (Buffer.byteLength(product.description) > 60000) fail("The description is too long.");
  if (!Array.isArray(body.input?.packages) || !body.input.packages.length || body.input.packages.length > 100) fail("Add 1–100 packages.");
  const packages = body.input.packages.map(pkg => {
    const name = String(pkg.name || "").trim();
    if (!name || name.length > 255) fail("Every package needs a name of 1–255 characters.");
    return { packageId: Number(pkg.packageId), name };
  });
  if (new Set(packages.map(pkg => pkg.name.toLowerCase())).size !== packages.length) fail("Use a different name for each package.");
  const { clean: input, output } = normalizeInput(body.input, product, packages, enterprises, settings);
  if (Date.parse(input.priceEffectiveAt.replace(" ", "T") + "Z") > Date.now()) fail("Future prices cannot take effect yet. Create the product on its effective date.");
  const preview = { product, packages, input, output, settingsVersionId: settings.id };
  return { ...preview, previewHash: hash(preview) };
}

export const previewEnterpriseProductCreation = body => prepare(body);

export async function createEnterpriseProduct(body, user) {
  const actor = Number(user?.userId || user?.adminId);
  if (!Number.isSafeInteger(actor) || actor <= 0) fail("An authenticated editor is required.", 403);
  if (!/^[\w-]{16,64}$/.test(body?.creationKey || "")) fail("A creation request key is required.");
  await getPricingSettings(); // Complete schema setup before the transaction.
  const requestHash = hash({ product: body.product, input: body.input, previewHash: body.previewHash });
  const connection = await getPool().getConnection();
  let locked = false;
  try {
    // Serialize manual catalog ID allocation and uncertain-request retries.
    const [[lock]] = await connection.query("SELECT GET_LOCK('enterprise_product_creation',10) AS acquired");
    if (Number(lock.acquired) !== 1) fail("Another product is being created. Retry shortly.", 409);
    locked = true;
    await connection.beginTransaction();
    const [[receipt]] = await connection.query("SELECT * FROM enterprise_product_creations WHERE creation_key=? FOR UPDATE", [body.creationKey]);
    if (receipt) {
      if (Number(receipt.editor_id) !== actor || receipt.request_hash !== requestHash) fail("This creation request was already used. Recover the original product before changing it.", 409);
      await connection.commit();
      return { productId: receipt.product_id, revisionId: receipt.revision_id, recovered: true };
    }
    const preview = await prepare(body, connection);
    if (!body.previewHash || body.previewHash !== preview.previewHash) fail("The product or pricing rules changed. Review the refreshed prices before creating it.", 409);
    const [[settings]] = await connection.query("SELECT id FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE");
    if (Number(settings.id) !== preview.settingsVersionId) fail("Pricing settings changed. Refresh the preview.", 409);
    const [[lastProduct]] = await connection.query("SELECT id FROM products ORDER BY id DESC LIMIT 1 FOR UPDATE");
    const [[lastPackage]] = await connection.query("SELECT id FROM packages ORDER BY id DESC LIMIT 1 FOR UPDATE");
    const productId = Number(lastProduct?.id || 0) + 1;
    let packageId = Number(lastPackage?.id || 0) + 1;
    await connection.query(`INSERT INTO products
      (id,name,description,vendor_id,category_id,exclude_from_snap,exclude_from_guest,visible,track_inventory,inventory,is_deleted,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,0,0,0,0,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
    [productId, preview.product.name, preview.product.description, preview.product.vendorId, preview.product.categoryId, Number(preview.product.excludeFromSnap), Number(preview.product.excludeFromGuest)]);
    const mappedInput = structuredClone(preview.input);
    for (const [index, pkg] of preview.packages.entries()) {
      const output = preview.output.packages[index];
      const factor = preview.input.pricingUnit === "lb" ? output.averageWeightMilliPounds : output.quantity;
      const divisor = preview.input.pricingUnit === "lb" ? 100000n : 100n;
      const costCents = output.packageBuyPriceCents ?? roundRatio(BigInt(preview.output.buyFromTenThousandths) * BigInt(factor), divisor);
      await connection.query(`INSERT INTO packages
        (id,product_id,name,price,unit,num_of_items,track_type,charge_type,visible,track_inventory,inventory)
        VALUES (?,?,?,?,?,?,'package','package',0,0,0)`,
      [packageId, productId, pkg.name, (costCents / 100).toFixed(2), "each", output.quantity || 1]);
      mappedInput.packages[index].packageId = packageId++;
    }
    const clean = mappedInput;
    const output = { ...preview.output, packages: preview.output.packages.map((pkg, index) => ({ ...pkg, packageId: clean.packages[index].packageId })) };
    const price = (output.squareUnitCents ?? output.csaUnitCents) / 100;
    await connection.query(`INSERT INTO product_pricing_profiles
      (product_id,unit_of_measure,source_unit_price,source_multiplier,guest_markup,member_markup,herd_share_markup,snap_markup,on_sale,sale_discount,remote_sync_status,created_at,updated_at)
      VALUES (?,?,?,1,0,0,0,0,0,0,'pending',UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
    [productId, clean.pricingUnit === "lb" ? "lbs" : "each", price.toFixed(2)]);
    await connection.query("INSERT INTO product_sales (product_id,on_sale,sale_discount,updated_at) VALUES (?,0,0,UTC_TIMESTAMP())", [productId]);
    await connection.query(`INSERT INTO local_line_product_meta
      (product_id,local_line_product_id,status,visible,track_inventory,product_inventory,created_at,updated_at)
      VALUES (?,0,'local-only',0,0,0,UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [productId]);
    const result = await persistEnterprisePricingRevision(connection, productId,
      { input: clean, output, settingsVersionId: preview.settingsVersionId }, user);
    await connection.query(`INSERT INTO enterprise_product_creations
      (creation_key,request_hash,editor_id,product_id,revision_id,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())`,
    [body.creationKey, requestHash, actor, productId, result.revisionId]);
    await connection.commit();
    return { productId, ...result };
  } catch (error) { await connection.rollback(); throw error; }
  finally {
    try {
      if (locked) await connection.query("SELECT RELEASE_LOCK('enterprise_product_creation')");
    } finally { connection.release(); }
  }
}
