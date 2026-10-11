import { isNoMarkupProduct, isSourcePricingVendor, resolvePricingProfile } from './productPricing.js';
import { requireProductVendor } from './productVendor.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });

export function normalizeProductMarkupOverride(value) {
  if (value === null || value === '') return null;
  if (!['number', 'string'].includes(typeof value) || !String(value).trim()) {
    throw invalid('Enter a nonnegative product markup, or leave it blank to use the vendor default.');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 999999.9999) {
    throw invalid('Product markup must be a nonnegative number.');
  }
  return Number(number.toFixed(4));
}

// Local only. Publication is a separate, explicitly reviewed Product Sync action.
export async function saveProductMarkupOverride(pool, productId, value) {
  if (!Number.isSafeInteger(Number(productId)) || Number(productId) <= 0) throw invalid('Invalid product id.');
  const markupOverride = normalizeProductMarkupOverride(value);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[product]] = await connection.query(`SELECT p.id, p.name, p.vendor_id AS vendorId, p.is_deleted AS isDeleted,
      c.name AS categoryName FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=? FOR UPDATE`, [productId]);
    if (!product) throw Object.assign(new Error('Product not found.'), { status: 404 });
    const [[vendor]] = await connection.query(`SELECT id, name, price_list_markup AS priceListMarkup,
      guest_markup AS guestMarkup, member_markup AS memberMarkup FROM vendors WHERE id=? FOR UPDATE`, [product.vendorId]);
    requireProductVendor(product, vendor);
    if (product.isDeleted || product.categoryName?.trim().toLowerCase() === 'membership') throw invalid('This product is outside the pricelist workflow.');
    if (isSourcePricingVendor(vendor) || isNoMarkupProduct(product)) throw invalid('Formula vendors and deposit products do not support product markup overrides.');
    const [[profile]] = await connection.query(`SELECT guest_markup AS guestMarkup, member_markup AS memberMarkup,
      herd_share_markup AS herdShareMarkup, snap_markup AS snapMarkup, markup_override AS markupOverride
      FROM product_pricing_profiles WHERE product_id=? FOR UPDATE`, [productId]);
    const [[sale]] = await connection.query('SELECT on_sale AS onSale, sale_discount AS saleDiscount FROM product_sales WHERE product_id=?', [productId]);
    const resolved = resolvePricingProfile({ product, vendor, profile: { ...profile, markupOverride } });
    await connection.query(`INSERT INTO product_pricing_profiles
      (product_id, markup_override, guest_markup, member_markup, herd_share_markup, snap_markup,
       on_sale, sale_discount, remote_sync_status, remote_sync_message, price_changed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'Local product markup updated. Apply to remote store pending.', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE markup_override=VALUES(markup_override), guest_markup=VALUES(guest_markup),
       member_markup=VALUES(member_markup), herd_share_markup=VALUES(herd_share_markup), snap_markup=VALUES(snap_markup),
       remote_sync_status=VALUES(remote_sync_status), remote_sync_message=VALUES(remote_sync_message),
       price_changed_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP()`,
    [productId, markupOverride, resolved.guestMarkup, resolved.memberMarkup, resolved.herdShareMarkup, resolved.snapMarkup,
      Number(sale?.onSale || 0), sale?.saleDiscount ?? null]);
    await connection.commit();
    return { ok: true, productId: Number(productId), markupOverride };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
