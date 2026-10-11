// These predicates also apply to counts and the pending-product review.
export const LOCAL_ONLY_PRODUCT_SQL =
  "NOT EXISTS (SELECT 1 FROM local_line_product_meta lm WHERE lm.product_id = p.id AND lm.local_line_product_id > 0)";
const SOURCE_PRICING_VENDOR_SQL =
  "(LOWER(COALESCE(v.name, '')) LIKE '%deck family farm%' OR LOWER(COALESCE(v.name, '')) LIKE '%hyland%' OR LOWER(COALESCE(v.name, '')) LIKE '%creamy cow%')";
const PRODUCT_VISIBILITY_SQL = "COALESCE(p.visible, (SELECT lm.visible FROM local_line_product_meta lm WHERE lm.product_id = p.id), 1)";
export const PRODUCT_ON_SALE_SQL = `(COALESCE(ps.on_sale, 0) = 1 OR EXISTS (SELECT 1 FROM product_pricing_profiles sale_profile WHERE sale_profile.product_id=p.id AND JSON_CONTAINS(COALESCE(sale_profile.customer_price_overrides_json, '[]'), '{"onSale":true}'))) `;
export const PRICELIST_PENDING_REMOTE_APPLY_SQL =
  "(" +
  "pp.product_id IS NOT NULL AND (" +
  "pp.remote_sync_status IN ('pending', 'failed') " +
  "OR COALESCE(pp.updated_at, '1970-01-01 00:00:00') > COALESCE(pp.remote_synced_at, '1970-01-01 00:00:00')" +
  ") OR " +
  LOCAL_ONLY_PRODUCT_SQL +
  ")";

export function buildPricelistWhereClause({
  search,
  categoryId,
  vendorId,
  vendorGroup = "",
  saleFilter,
  statusFilter,
  visibility = "all",
  stockOnFarm = "all",
  pricingType = "all",
  membershipCategoryIds = [],
}) {
  const clauses = ["COALESCE(p.is_deleted, 0) = 0"];
  const params = [];

  if (membershipCategoryIds.length) {
    clauses.push("(p.category_id IS NULL OR p.category_id NOT IN (?))");
    params.push(membershipCategoryIds);
  }

  if (search) {
    clauses.push("LOWER(TRIM(p.name)) LIKE ?");
    params.push(`%${String(search).trim().toLowerCase()}%`);
  }

  if (Number.isFinite(categoryId)) {
    clauses.push("p.category_id = ?");
    params.push(categoryId);
  }

  if (Number.isFinite(vendorId)) {
    clauses.push("p.vendor_id = ?");
    params.push(vendorId);
  }

  if (vendorGroup === "deck-enterprises") clauses.push(SOURCE_PRICING_VENDOR_SQL);

  if (visibility === "visible") clauses.push(`${PRODUCT_VISIBILITY_SQL} = 1`);
  if (visibility === "hidden") clauses.push(`${PRODUCT_VISIBILITY_SQL} = 0`);
  if (stockOnFarm === "not-checked") clauses.push("p.stock_on_farm IS NULL");
  if (stockOnFarm === "true") clauses.push("p.stock_on_farm = 1");
  if (stockOnFarm === "false") clauses.push("p.stock_on_farm = 0");
  if (pricingType === "formula") clauses.push(SOURCE_PRICING_VENDOR_SQL);
  if (pricingType === "standard")
    clauses.push(
      `NOT ${SOURCE_PRICING_VENDOR_SQL} AND LOWER(COALESCE(p.name, '')) NOT LIKE '%deposit%'`,
    );
  if (pricingType === "deposit")
    clauses.push("LOWER(COALESCE(p.name, '')) LIKE '%deposit%'");

  if (saleFilter === "onSale") {
    clauses.push(PRODUCT_ON_SALE_SQL);
  } else if (saleFilter === "notOnSale") {
    clauses.push(`NOT ${PRODUCT_ON_SALE_SQL}`);
  }

  switch (statusFilter) {
    case "local-only":
      clauses.push(LOCAL_ONLY_PRODUCT_SQL);
      break;
    case "needsApply":
      clauses.push(PRICELIST_PENDING_REMOTE_APPLY_SQL);
      break;
    case "applied":
      clauses.push(
        "pp.remote_sync_status = 'applied'",
        `NOT ${PRICELIST_PENDING_REMOTE_APPLY_SQL}`,
      );
      break;
    case "pending":
    case "failed":
      clauses.push("COALESCE(pp.remote_sync_status, 'not-applied') = ?");
      params.push(statusFilter);
      break;
    case "not-applied":
      clauses.push(
        "(" +
          "pp.product_id IS NULL " +
          "OR pp.remote_sync_status IS NULL " +
          "OR TRIM(pp.remote_sync_status) = '' " +
          "OR pp.remote_sync_status = 'not-applied'" +
          ")",
      );
      break;
    default:
      break;
  }

  return {
    clauses,
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
