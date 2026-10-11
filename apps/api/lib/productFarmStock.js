import { ensureFarmStockSchema, getPool } from "../db.js";
import { hasAdminPermission } from "./adminRoles.js";
import { validateSavedProductVendor } from "./productVendor.js";
import { fail } from "./productSyncCore.js";

export const farmStockValue = value => value == null ? null : Boolean(Number(value));

export function validateFarmStockInput(input) {
  if (!input || Object.keys(input).length !== 1 || typeof input.stockOnFarm !== "boolean") {
    fail("Stock on Farm must be True or False. No other fields are accepted.");
  }
  return input.stockOnFarm;
}

export async function saveProductFarmStock(productId, input, user) {
  if (!hasAdminPermission(user?.adminRoles || [], ["inventory_admin", "pricing_admin", "local_pricelist_admin"])) {
    fail("Product editing permission is required to save Stock on Farm.", 403);
  }
  const id = Number(productId);
  if (!["number", "string"].includes(typeof productId) || !Number.isSafeInteger(id) || id <= 0) fail("Invalid product ID.");
  const stockOnFarm = validateFarmStockInput(input);
  await ensureFarmStockSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[product]] = await connection.query(`SELECT p.id, p.is_deleted, c.name AS categoryName
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? FOR UPDATE`, [id]);
    if (!product) fail("Product not found.", 404);
    if (product.is_deleted || product.categoryName?.trim().toLowerCase() === "membership") fail("This product is not available in Inventory.");
    await validateSavedProductVendor(connection, id);
    await connection.query("UPDATE products SET stock_on_farm=?, updated_at=UTC_TIMESTAMP() WHERE id=?", [Number(stockOnFarm), id]);
    await connection.commit();
    return { ok: true, productId: id, stockOnFarm, localOnly: true, savedFields: ["stockOnFarm"] };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
