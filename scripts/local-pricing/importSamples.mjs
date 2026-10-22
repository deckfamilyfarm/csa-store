import fs from "node:fs/promises";
import { assertLocalDatabase, installLocalEnvironment, installLoopbackNetworkGuard } from "./env.mjs";

const snapshot = JSON.parse(await fs.readFile("/private/tmp/csa-store-pricing-samples.json", "utf8"));
if (!Array.isArray(snapshot.records) || snapshot.records.length !== 15) {
  throw new Error("The pricing sample snapshot must contain exactly 15 reviewed products.");
}
installLocalEnvironment();
assertLocalDatabase();
installLoopbackNetworkGuard();
const { getPool } = await import("../../apps/api/db.js");
const { ensureEnterprisePricingSchema } = await import("../../apps/api/lib/enterprisePricingSchema.js");
const { deriveMigrationBuyPrice } = await import("../../apps/api/lib/legacyPricingEvidence.js");
await ensureEnterprisePricingSchema();
const pool = getPool();
const connection = await pool.getConnection();

const vendorIds = new Map([
  ["Deck Family Farm", 9101],
  ["Deck Family Farm's Hyland Artisinal Meats", 9102],
  ["Creamy Cow, LLC", 9103]
]);
const readOnlyEvidence = record => ({
  product: {
    name: record.product.name, vendorName: record.product.vendorName,
    vendorPriceListMarkup: record.product.vendorPriceListMarkup,
    vendorGuestMarkup: record.product.vendorGuestMarkup
  },
  profile: record.profile,
  packages: record.packages.map(pkg => ({ id: pkg.id, name: pkg.name, price: pkg.price,
    numOfItems: pkg.numOfItems, cachedWeight: pkg.cachedWeight })),
  sale: record.sale,
  localLinePrices: (record.localLinePrices || []).map(row => ({
    packageId: row.packageId, listName: row.listName, finalPrice: row.finalPrice,
    crossedOutPrice: row.crossedOutPrice, onSale: row.onSale, cachedAt: row.cachedAt
  })),
  squarePrices: (record.squarePrices || []).map(row => ({
    packageId: row.packageId, variationName: row.variationName,
    priceCents: row.priceCents, cachedAt: row.cachedAt
  }))
});

try {
  const [identity] = await connection.query("SELECT DATABASE() AS databaseName, CURRENT_USER() AS databaseUser");
  if (identity[0]?.databaseName !== "csa_pricing_local" ||
      !String(identity[0]?.databaseUser).startsWith("csa_local@")) {
    throw new Error("Refusing to import samples outside the dedicated local pricing database.");
  }
  await connection.query(`CREATE TABLE IF NOT EXISTS local_pricing_sample_sources (
    local_product_id INT PRIMARY KEY, source_product_id INT NOT NULL UNIQUE,
    source_vendor_name VARCHAR(255) NOT NULL, sampled_at DATETIME NOT NULL,
    source_snapshot_json LONGTEXT
  ) ENGINE=InnoDB`);
  const [snapshotColumn] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='local_pricing_sample_sources'
      AND COLUMN_NAME='source_snapshot_json'`);
  if (!snapshotColumn.length) await connection.query(
    "ALTER TABLE local_pricing_sample_sources ADD COLUMN source_snapshot_json LONGTEXT"
  );
  const [enterpriseRows] = await connection.query("SELECT id FROM enterprise_pricing_enterprises WHERE code='ffcsa'");
  if (enterpriseRows.length !== 1) throw new Error("The local FFCSA pricing enterprise is missing.");
  const ffcsaId = Number(enterpriseRows[0].id);
  await connection.beginTransaction();
  for (const [sourceName, vendorId] of vendorIds) {
    await connection.execute("UPDATE vendors SET name=? WHERE id=? AND name=?",
      [sourceName, vendorId, `${sourceName} (local sample)`]);
  }
  const categoryIds = new Map();
  let imported = 0;
  let preserved = 0;
  for (const [index, record] of snapshot.records.entries()) {
    const localProductId = 9100001 + index;
    const localPackageBase = 9100001 + index * 10;
    const sourceVendor = record.product.vendorName;
    const vendorId = vendorIds.get(sourceVendor);
    const evidenceJson = JSON.stringify(readOnlyEvidence(record));
    const buyPrice = deriveMigrationBuyPrice(record);
    if (!vendorId || Number(record.sourceProductId) !== Number(record.product.id)) {
      throw new Error("The sample snapshot contains an unreviewed product or vendor.");
    }
    const [existingSample] = await connection.execute(
      "SELECT source_product_id AS sourceProductId FROM local_pricing_sample_sources WHERE local_product_id=? FOR UPDATE",
      [localProductId]
    );
    if (existingSample.length) {
      if (Number(existingSample[0].sourceProductId) !== Number(record.sourceProductId)) {
        throw new Error(`Local sample ID ${localProductId} belongs to a different source product.`);
      }
      await connection.execute(`UPDATE local_pricing_sample_sources
        SET source_snapshot_json=?, sampled_at=? WHERE local_product_id=?`,
      [evidenceJson, snapshot.capturedAt.slice(0, 19).replace("T", " "), localProductId]);
      if (buyPrice) await connection.execute(`INSERT IGNORE INTO enterprise_pricing_buy_price_drafts
        (product_id,purchasing_enterprise_id,price,updated_at) VALUES (?,?,?,UTC_TIMESTAMP())`,
      [localProductId, ffcsaId, (buyPrice.cents / 100).toFixed(2)]);
      preserved++;
      continue; // Preserve local edits on repeated imports.
    }
    const [occupied] = await connection.execute("SELECT id FROM products WHERE id=?", [localProductId]);
    if (occupied.length) throw new Error(`Local product ID ${localProductId} is already in use.`);

    const localVendorName = sourceVendor;
    const [localVendor] = await connection.execute("SELECT name FROM vendors WHERE id=?", [vendorId]);
    if (localVendor.length && localVendor[0].name !== localVendorName) {
      throw new Error(`Local vendor ID ${vendorId} is already in use.`);
    }
    if (!localVendor.length) await connection.execute(`INSERT INTO vendors
      (id,name,price_list_markup,source_multiplier,guest_markup,member_markup)
      VALUES (?,?,?,?,?,?)`, [vendorId, localVendorName,
      record.product.vendorPriceListMarkup, record.product.vendorSourceMultiplier,
      record.product.vendorGuestMarkup, record.product.vendorMemberMarkup]);

    const categoryName = record.product.categoryName || "Uncategorized";
    if (!categoryIds.has(categoryName)) {
      const [existingCategory] = await connection.execute("SELECT id FROM categories WHERE name=?", [categoryName]);
      if (existingCategory.length) categoryIds.set(categoryName, Number(existingCategory[0].id));
      else {
        const [result] = await connection.execute("INSERT INTO categories (name) VALUES (?)", [categoryName]);
        categoryIds.set(categoryName, Number(result.insertId));
      }
    }
    await connection.execute(`INSERT INTO products
      (id,name,description,visible,category_id,vendor_id,is_deleted,stock_on_farm,stock_on_farm_lbs)
      VALUES (?,?,?,?,?,?,0,NULL,NULL)`, [localProductId, record.product.name,
      record.product.description, record.product.visible, categoryIds.get(categoryName), vendorId]);
    for (const [packageIndex, pkg] of record.packages.entries()) {
      const localPackageId = localPackageBase + packageIndex;
      const [occupiedPackage] = await connection.execute("SELECT id FROM packages WHERE id=?", [localPackageId]);
      if (occupiedPackage.length) throw new Error(`Local package ID ${localPackageId} is already in use.`);
      await connection.execute(`INSERT INTO packages
        (id,product_id,name,price,unit,num_of_items,charge_type,visible,track_inventory,inventory)
        VALUES (?,?,?,?,?,?,?,?,0,NULL)`, [localPackageId, localProductId, pkg.name,
        pkg.price, pkg.unit, pkg.numOfItems, pkg.chargeType, pkg.visible]);
    }
    if (record.profile) {
      const p = record.profile;
      await connection.execute(`INSERT INTO product_pricing_profiles
        (product_id,unit_of_measure,source_unit_price,min_weight,max_weight,avg_weight_override,
         source_multiplier,guest_markup,member_markup,herd_share_markup,snap_markup,markup_override,
         on_sale,sale_discount,remote_sync_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [localProductId, p.pricingUnit,
        p.sourceUnitPrice, p.minWeight, p.maxWeight, p.avgWeightOverride,
        p.sourceMultiplier, p.guestMarkup, p.memberMarkup, p.herdShareMarkup,
        p.snapMarkup, p.markupOverride, p.onSale, p.saleDiscount, "sample-local-only"]);
    }
    await connection.execute(`INSERT INTO local_pricing_sample_sources
      (local_product_id,source_product_id,source_vendor_name,sampled_at,source_snapshot_json)
      VALUES (?,?,?,?,?)`, [localProductId, record.sourceProductId, sourceVendor,
      snapshot.capturedAt.slice(0, 19).replace("T", " "), evidenceJson]);
    if (buyPrice) await connection.execute(`INSERT INTO enterprise_pricing_buy_price_drafts
      (product_id,purchasing_enterprise_id,price,updated_at) VALUES (?,?,?,UTC_TIMESTAMP())`,
    [localProductId, ffcsaId, (buyPrice.cents / 100).toFixed(2)]);
    imported++;
  }
  await connection.commit();
  console.log(`Local pricing samples ready: ${imported} imported, ${preserved} existing edits preserved.`);
  console.log("No Square or Local Line product, package, price-list, or variation mappings were copied.");
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
