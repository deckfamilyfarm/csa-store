import { normalizeCustomerPriceOverrides, customerOverridePrice } from './customerPriceOverrides.js';
import { getPriceListDefinitions, isNoMarkupProduct, isSourcePricingVendor } from './productPricing.js';
import { requireProductVendor } from './productVendor.js';

export async function saveCustomerPriceOverrides(pool, productId, input) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  if (!Number.isSafeInteger(productId) || productId <= 0 || !Array.isArray(input)) throw invalid('Invalid product or customer price settings.');
  const rows = normalizeCustomerPriceOverrides(input);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[product]] = await connection.query(`SELECT p.id,p.name,p.vendor_id AS vendorId,p.is_deleted AS isDeleted,c.name AS categoryName
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? FOR UPDATE`, [productId]);
    if (!product) throw Object.assign(new Error('Product not found.'), { status: 404 });
    const [[vendor]] = await connection.query('SELECT id,name FROM vendors WHERE id=? FOR UPDATE', [product.vendorId]);
    requireProductVendor(product, vendor);
    if (product.isDeleted || product.categoryName?.trim().toLowerCase() === 'membership' || isSourcePricingVendor(vendor) || isNoMarkupProduct(product)) throw invalid('Customer-group pricing is available only for standard products.');
    const [packages] = await connection.query('SELECT id,price FROM packages WHERE product_id=? FOR UPDATE', [productId]);
    const configuredIds = new Set(getPriceListDefinitions({ guestMarkup: 0, memberMarkup: 0, herdShareMarkup: 0, snapMarkup: 0 }).map(list => list.id));
    for (const row of rows) {
      const pkg = packages.find(p => Number(p.id) === row.packageId);
      if (!pkg || !configuredIds.has(row.priceListId)) throw invalid('Customer pricing must use this product’s packages and configured customer groups.');
      customerOverridePrice(pkg.price, row);
    }
    const [[sale]] = await connection.query('SELECT on_sale,sale_discount FROM product_sales WHERE product_id=? FOR UPDATE', [productId]);
    await connection.query(`INSERT INTO product_pricing_profiles
      (product_id,customer_price_overrides_json,on_sale,sale_discount,remote_sync_status,remote_sync_message,price_changed_at,created_at,updated_at)
      VALUES (?,?,?,?,'pending','Local customer-group pricing updated. Review Product Sync before publication.',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE customer_price_overrides_json=VALUES(customer_price_overrides_json),
      remote_sync_status=VALUES(remote_sync_status),remote_sync_message=VALUES(remote_sync_message),price_changed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP()`,
    [productId, rows.length ? JSON.stringify(rows) : null, Number(sale?.on_sale || 0), sale?.sale_discount ?? null]);
    await connection.commit();
    return { ok: true, productId, customerPriceOverrides: rows };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
