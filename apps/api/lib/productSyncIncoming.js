import { getPool } from "../db.js";
import { runLocalLineAudit } from "../scripts/auditLocalLineSync.js";
import { getActiveScheduledPricelistProductChangeMap } from "./scheduledPricelistReleases.js";
import { same, fingerprint } from "./productSyncCore.js";

const PRODUCT_COLUMNS = { name: "name", description: "description", visible: "visible", trackInventory: "track_inventory", inventory: "inventory" };
const PACKAGE_COLUMNS = { name: "name", price: "price", packageCode: "package_code", visible: "visible", trackInventory: "track_inventory", inventory: "inventory" };
const supported = new Set(["create-store-product-from-localline", "update-store-product-from-localline", "update-store-package-from-localline", "add-missing-store-package"]);
export function incomingProposals(report, catalog) {
  const byId = new Map(catalog.map(row => [Number(row.id), row]));
  const output = [];
  for (const proposals of Object.values(report.proposedUpdates)) for (const original of proposals) {
    const product = byId.get(Number(original.productId));
    if (product?.categoryName?.trim().toLowerCase() === "membership") continue;
    const proposal = structuredClone(original);
    // Formula prices are locally authoritative. Review price drift separately from catalog repairs.
    if (/deck family farm|hyland|creamy cow/i.test(product?.vendorName || "") && proposal.changes?.price) {
      output.push({ proposal: { ...proposal, action: "review-formula-package-price", changes: { price: proposal.changes.price } }, product, supported: false });
      delete proposal.changes.price;
    }
    if (proposal.changes && !Object.keys(proposal.changes).length) continue;
    output.push({ proposal, product, supported: supported.has(proposal.action) });
  }
  return output;
}
export async function readIncomingSnapshot(proposal, connection = getPool()) {
  const [products] = await connection.query("SELECT id, name, description, visible, track_inventory, inventory, category_id, vendor_id FROM products WHERE id = ?", [proposal.productId]);
  const [packages] = await connection.query("SELECT id, product_id, name, price, package_code, visible, track_inventory, inventory FROM packages WHERE product_id = ? OR id = ? ORDER BY id", [proposal.productId, proposal.packageId || 0]);
  const [links] = await connection.query("SELECT product_id, local_line_product_id FROM local_line_product_meta WHERE product_id = ?", [proposal.productId]);
  const [packageLinks] = await connection.query("SELECT package_id, local_line_package_id FROM local_line_package_meta WHERE product_id = ? ORDER BY package_id", [proposal.productId]);
  const creating = proposal.action === "create-store-product-from-localline";
  const productUpdate = proposal.action === "update-store-product-from-localline";
  const columns = productUpdate ? PRODUCT_COLUMNS : PACKAGE_COLUMNS;
  const relevant = row => Object.fromEntries(["id", ...Object.keys(proposal.changes || {}).map(key => columns[key]).filter(Boolean)].map(key => [key, row[key]]));
  return {
    products: creating ? products : products.map(row => ({ id: row.id, category_id: row.category_id, vendor_id: row.vendor_id, ...(productUpdate ? relevant(row) : {}) })),
    packages: creating ? packages : packages.filter(row => Number(row.id) === Number(proposal.packageId)).map(row => proposal.action === "add-missing-store-package" ? row : relevant(row)),
    links, packageLinks: productUpdate || creating ? packageLinks : packageLinks.filter(row => Number(row.package_id) === Number(proposal.packageId))
  };
}
export async function prepareIncomingActions(catalog, productIds = []) {
  const { report } = await runLocalLineAudit({ write: false, writeReport: false, skipPricelist: true, limit: 0,
    productIds: productIds.length ? productIds : null });
  const actions = [];
  const protectedProducts = await getActiveScheduledPricelistProductChangeMap();
  for (const entry of incomingProposals(report, catalog)) {
    const { proposal, product } = entry;
    if (productIds.length && !productIds.includes(Number(proposal.productId))) continue;
    const localBefore = await readIncomingSnapshot(proposal);
    const explicitLink = localBefore.links[0]?.local_line_product_id;
    const mappingConflict = proposal.localLineProductId && explicitLink != null && Number(explicitLink) !== Number(proposal.localLineProductId);
    const idConflict = proposal.action === "create-store-product-from-localline" && localBefore.products.length > 0;
    const conflict = mappingConflict || idConflict;
    actions.push({
      direction: "incoming", platform: "localline", kind: proposal.action,
      productId: Number(proposal.productId || 0), productName: product?.name || proposal.product?.name || proposal.localLineName || `Product ${proposal.productId}`,
      vendorName: product?.vendorName || "", packageId: proposal.packageId || null,
      status: conflict ? "review" : entry.supported ? protectedProducts.has(Number(proposal.productId)) ? "blocked" : "changed" : "review",
      message: conflict ? "This Local Line product conflicts with an existing local id or link. Reconcile the match before applying catalog repairs." : entry.supported ? protectedProducts.has(Number(proposal.productId)) ? "Resolve the active release before applying incoming changes to this product." : "Supported local catalog repair" : "Review only; local pricing and formula inputs remain authoritative.",
      proposal, proposalHash: fingerprint(proposal), localBefore,
      display: { current: Object.fromEntries(Object.entries(proposal.changes || {}).map(([key, value]) => [key, value.from])), proposed: Object.keys(proposal.changes || {}).length ? Object.fromEntries(Object.entries(proposal.changes).map(([key, value]) => [key, value.to])) : proposal }
    });
  }
  return actions;
}
export async function applyIncomingAction(action, freshHashes, connection) {
  if (!supported.has(action.kind) || !freshHashes.has(action.proposalHash)) return { status: "held", message: "Local or remote values changed. Audit and approve again." };
  const proposal = action.proposal;
  await connection.beginTransaction();
  try {
    await connection.query("SELECT id FROM products WHERE id = ? FOR UPDATE", [action.productId]);
    if (!same(await readIncomingSnapshot(proposal, connection), action.localBefore)) throw new Error("Local fields or links changed. Audit and approve again.");
    const protectedProducts = await getActiveScheduledPricelistProductChangeMap(connection);
    if (protectedProducts.has(action.productId)) throw new Error("This product has an active release. Resolve it before applying incoming repairs.");
    if (action.kind.startsWith("update-store-")) {
      const isPackage = action.kind === "update-store-package-from-localline";
      const columns = isPackage ? PACKAGE_COLUMNS : PRODUCT_COLUMNS;
      const values = Object.entries(proposal.changes || {}).map(([key, change]) => {
        if (!columns[key]) throw new Error(`Unsupported catalog field ${key}.`);
        return [columns[key], typeof change.to === "boolean" ? Number(change.to) : change.to ?? null];
      });
      await connection.query(`UPDATE ${isPackage ? "packages" : "products"} SET ${values.map(([col]) => `${col} = ?`).join(", ")} WHERE id = ?`, [...values.map(([, value]) => value), isPackage ? proposal.packageId : proposal.productId]);
    } else {
      if (action.kind === "create-store-product-from-localline") {
        const product = proposal.product;
        await connection.query(`INSERT INTO products (id, name, description, visible, track_inventory, inventory, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [proposal.productId, product.name, product.description || "", product.visible || 0, product.trackInventory || 0, product.inventory ?? null]);
        await connection.query(`INSERT INTO local_line_product_meta (product_id, local_line_product_id, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [proposal.productId, proposal.localLineProductId || proposal.productId]);
      }
      const packages = action.kind === "create-store-product-from-localline" ? proposal.packages || [] : [{ ...proposal.package, packageId: proposal.packageId }];
      for (const pkg of packages) {
        await connection.query(`INSERT INTO packages (id, product_id, name, price, package_code, num_of_items, visible, track_inventory, inventory)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [pkg.packageId, proposal.productId, pkg.name || "Package", pkg.price ?? null, pkg.packageCode ?? null, pkg.numOfItems ?? null, Number(pkg.visible ?? 1), Number(pkg.trackInventory || 0), pkg.inventory ?? null]);
        await connection.query(`INSERT INTO local_line_package_meta (package_id, product_id, local_line_package_id, created_at, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [pkg.packageId, proposal.productId, pkg.localLinePackageId || pkg.packageId]);
      }
    }
    const result = { status: "applied", message: "Approved local catalog repair applied." };
    await connection.query("UPDATE product_sync_actions SET status = 'applied', result_json = ?, applied_at = UTC_TIMESTAMP() WHERE id = ?", [JSON.stringify(result), action.id]);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    return { status: "held", message: error.message };
  }
}
