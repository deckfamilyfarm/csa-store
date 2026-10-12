import { ensureFarmStockSchema, getPool } from "../db.js";
import { hasAdminPermission } from "./adminRoles.js";
import { validateSavedProductVendor } from "./productVendor.js";
import { fail } from "./productSyncCore.js";
import { farmPounds, farmInventorySnapshot, resolveFarmInventory, FARM_INVENTORY_FIELDS } from "./farmInventory.js";

export const farmStockValue = value => value == null ? null : Boolean(Number(value));

export function validateFarmStockInput(input) {
  if (!input || Array.isArray(input) || typeof input !== "object" ||
      Object.keys(input).some(key => ![...FARM_INVENTORY_FIELDS, "expectedRevision"].includes(key)) ||
      !FARM_INVENTORY_FIELDS.some(key => Object.hasOwn(input, key))) {
    fail("Only Stock on Farm (True or False), on-farm pounds, and the expected revision are accepted.");
  }
  if (Object.hasOwn(input, "stockOnFarm") && typeof input.stockOnFarm !== "boolean") fail("Stock on Farm must be True or False.");
  if (Object.hasOwn(input, "stockOnFarmLbs")) {
    if (input.stockOnFarmLbs !== null && typeof input.stockOnFarmLbs !== "number") fail("On-farm pounds must be a number or null.");
    farmPounds(input.stockOnFarmLbs);
  }
  // Keep the original boolean-only endpoint compatible. New clients always use a revision.
  if (Object.hasOwn(input, "stockOnFarmLbs") || Object.hasOwn(input, "expectedRevision")) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("A valid farm-stock revision is required. Reload the product and retry.");
  }
  return Object.fromEntries(FARM_INVENTORY_FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

export async function saveProductFarmStock(productId, input, user) {
  if (!hasAdminPermission(user?.adminRoles || [], ["inventory_admin", "pricing_admin", "local_pricelist_admin"])) {
    fail("Product editing permission is required to save Stock on Farm.", 403);
  }
  const id = Number(productId);
  if (!["number", "string"].includes(typeof productId) || !Number.isSafeInteger(id) || id <= 0) fail("Invalid product ID.");
  const changes = validateFarmStockInput(input);
  await ensureFarmStockSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[product]] = await connection.query(`SELECT p.id, p.is_deleted, c.name AS categoryName,
      p.stock_on_farm AS stockOnFarm, p.stock_on_farm_lbs AS stockOnFarmLbs, p.farm_stock_revision AS farmStockRevision
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? FOR UPDATE`, [id]);
    if (!product) fail("Product not found.", 404);
    if (product.is_deleted || product.categoryName?.trim().toLowerCase() === "membership") fail("This product is not available in Inventory.");
    await validateSavedProductVendor(connection, id);
    const current = farmInventorySnapshot(product);
    const next = resolveFarmInventory(current, changes);
    const unchanged = FARM_INVENTORY_FIELDS.every(key => current[key] === next[key]);
    // An identical retry after a lost response is safe: these are absolute counts, not deltas.
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.farmStockRevision && !unchanged) {
      const error = new Error("Farm inventory changed since you opened it. Review the latest saved count before retrying.");
      error.status = 409;
      error.farmStockConflict = current;
      throw error;
    }
    const farmStockRevision = current.farmStockRevision + (unchanged ? 0 : 1);
    if (!unchanged) await connection.query("UPDATE products SET stock_on_farm=?, stock_on_farm_lbs=?, farm_stock_revision=?, updated_at=UTC_TIMESTAMP() WHERE id=?",
      [next.stockOnFarm == null ? null : Number(next.stockOnFarm), next.stockOnFarmLbs, farmStockRevision, id]);
    await connection.commit();
    return { ok: true, productId: id, ...next, farmStockRevision, localOnly: true, savedFields: FARM_INVENTORY_FIELDS };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
