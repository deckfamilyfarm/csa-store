// Explicit production read: exports a small catalog snapshot for the isolated local pricing database.
// No application modules are imported, no remote APIs are called, and every SQL operation is read-only.
import fs from "node:fs/promises";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

const sourceIds = [
  813084, 941005, 805658, 805652, 805661, // Deck: fixed packages and variable weight
  913652, 1131920, 805663, 1011872, 816905, // Hyland: four each and its only explicit lbs item
  1167933, 805461, 805471, 805474, 805473 // Creamy Cow: milk, buttermilk, and cream
];
const snapshotPath = "/private/tmp/csa-store-pricing-samples.json";
const env = dotenv.parse(await fs.readFile(new URL("../../../.env", import.meta.url)));
const config = {
  host: env.STORE_DB_HOST,
  port: Number(env.STORE_DB_PORT || 3306),
  user: env.STORE_DB_USER,
  password: env.STORE_DB_PASSWORD,
  database: env.STORE_DB_DATABASE,
  multipleStatements: false
};
if (!config.host || !config.user || !config.database ||
    config.database === "csa_pricing_local" || config.port === 33077) {
  throw new Error("Production catalog credentials are required; refusing the local fixture database.");
}

const connection = await mysql.createConnection(config);
try {
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.query("START TRANSACTION READ ONLY");
  const [products] = await connection.query(`SELECT p.id, p.name, p.description, p.visible,
      p.category_id AS categoryId, c.name AS categoryName,
      p.vendor_id AS vendorId, v.name AS vendorName,
      v.price_list_markup AS vendorPriceListMarkup, v.source_multiplier AS vendorSourceMultiplier,
      v.guest_markup AS vendorGuestMarkup, v.member_markup AS vendorMemberMarkup
    FROM products p JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.id IN (?) AND COALESCE(p.is_deleted,0)=0`, [sourceIds]);
  if (products.length !== sourceIds.length) throw new Error("A selected production product is missing or deleted.");
  const [packages] = await connection.query(`SELECT pkg.id, pkg.product_id AS productId, pkg.name,
      pkg.price, pkg.unit, pkg.num_of_items AS numOfItems, pkg.visible,
      pkg.package_code AS packageCode, pkg.charge_type AS chargeType,
      m.avg_package_weight AS cachedWeight
    FROM packages pkg LEFT JOIN local_line_package_meta m ON m.package_id=pkg.id
    WHERE pkg.product_id IN (?) ORDER BY pkg.product_id,pkg.id`, [sourceIds]);
  const [profiles] = await connection.query(`SELECT product_id AS productId, unit_of_measure AS pricingUnit,
      source_unit_price AS sourceUnitPrice, min_weight AS minWeight, max_weight AS maxWeight,
      avg_weight_override AS avgWeightOverride, source_multiplier AS sourceMultiplier,
      guest_markup AS guestMarkup, member_markup AS memberMarkup,
      herd_share_markup AS herdShareMarkup, snap_markup AS snapMarkup,
      markup_override AS markupOverride, on_sale AS onSale, sale_discount AS saleDiscount,
      remote_sync_status AS remoteSyncStatus, remote_synced_at AS remoteSyncedAt
    FROM product_pricing_profiles WHERE product_id IN (?)`, [sourceIds]);
  const [localLinePrices] = await connection.query(`SELECT product_id AS productId, package_id AS packageId,
      price_list_name AS listName, price_list_id AS listId,
      final_price_cache AS finalPrice, calculated_value AS calculatedPrice,
      on_sale AS onSale, strikethrough_display_value AS crossedOutPrice,
      last_synced_at AS cachedAt
    FROM local_line_price_list_entries WHERE product_id IN (?)
      AND package_id IS NOT NULL ORDER BY product_id,package_id,price_list_name`, [sourceIds]);
  const [squarePrices] = await connection.query(`SELECT l.product_id AS productId,
      l.package_id AS packageId, v.name AS variationName, v.price_amount AS priceCents,
      v.pricing_type AS pricingType, v.last_synced_at AS cachedAt,
      l.approved_at AS mappedAt
    FROM square_variation_links l JOIN square_catalog_variations v
      ON v.square_variation_id=l.square_variation_id
    WHERE l.product_id IN (?) AND l.approved_at IS NOT NULL
    ORDER BY l.product_id,l.package_id`, [sourceIds]);
  const [sales] = await connection.query(`SELECT product_id AS productId, on_sale AS onSale,
      sale_discount AS saleDiscount FROM product_sales WHERE product_id IN (?)`, [sourceIds]);
  const [sourcePricingTables] = await connection.query(`SELECT TABLE_NAME AS tableName
    FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
      AND (TABLE_NAME LIKE '%wholesale%' OR TABLE_NAME LIKE '%purchase_cost%')`);
  const byProfile = new Map(profiles.map(row => [Number(row.productId), row]));
  const bySale = new Map(sales.map(row => [Number(row.productId), row]));
  const records = sourceIds.map(sourceProductId => {
    const product = products.find(row => Number(row.id) === sourceProductId);
    const productPackages = packages.filter(row => Number(row.productId) === sourceProductId);
    if (!productPackages.length) throw new Error(`Selected product ${sourceProductId} has no packages.`);
    return { sourceProductId, product, profile: byProfile.get(sourceProductId) || null,
      packages: productPackages, sale: bySale.get(sourceProductId) || null,
      localLinePrices: localLinePrices.filter(row => Number(row.productId) === sourceProductId),
      squarePrices: squarePrices.filter(row => Number(row.productId) === sourceProductId) };
  });
  await connection.query("ROLLBACK");
  await fs.writeFile(snapshotPath, JSON.stringify({ capturedAt: new Date().toISOString(), records }, null, 2), { mode: 0o600 });
  for (const record of records) {
    console.log(`${record.product.vendorName}: ${record.product.name} (${record.profile?.pricingUnit || "unit missing"}, LL cached rows ${record.localLinePrices.length}, Square mapped rows ${record.squarePrices.length})`);
  }
  console.log(`Production purchase/wholesale tables: ${sourcePricingTables.map(row => row.tableName).join(", ") || "none"}`);
  console.log(`Read-only snapshot: ${snapshotPath}`);
} finally {
  await connection.end();
}
