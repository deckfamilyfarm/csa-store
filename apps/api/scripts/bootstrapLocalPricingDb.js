import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../schema.js";
import {
  ensureAdminAccessSchema,
  ensureFarmStockSchema,
  ensureLocalLineSyncSchema,
  ensureSquareSyncSchema,
  getPool
} from "../db.js";
import { ensureProductSyncSchema } from "../lib/productSyncSchema.js";
import { ensureEnterprisePricingSchema } from "../lib/enterprisePricingSchema.js";

if (process.env.CSA_LOCAL_ONLY !== "true") {
  throw new Error("Synthetic pricing database bootstrap requires local-only mode.");
}

const pool = getPool();
const baseTables = [
  schema.vendors,
  schema.categories,
  schema.products,
  schema.packages,
  schema.productImages,
  schema.tags,
  schema.productTags,
  schema.productSales,
  schema.dropSites,
  schema.users,
  schema.recipes,
  schema.reviews
];

function tableSql(table) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    const definition = [
      mysql.escapeId(column.name),
      column.getSQLType(),
      column.notNull ? "NOT NULL" : "NULL",
      column.autoIncrement ? "AUTO_INCREMENT" : "",
      column.default !== undefined && (typeof column.default !== "object" || column.default === null)
        ? `DEFAULT ${mysql.escape(column.default)}` : ""
    ].filter(Boolean).join(" ");
    return definition;
  });
  const primary = config.primaryKeys.length
    ? config.primaryKeys[0].columns
    : config.columns.filter(column => column.primary);
  if (primary.length) columns.push(`PRIMARY KEY (${primary.map(column => mysql.escapeId(column.name)).join(", ")})`);
  for (const column of config.columns.filter(column => column.isUnique)) {
    columns.push(`UNIQUE KEY ${mysql.escapeId(column.uniqueName)} (${mysql.escapeId(column.name)})`);
  }
  for (const index of config.indexes.filter(index => index.config.unique)) {
    columns.push(`UNIQUE KEY ${mysql.escapeId(index.config.name)} (${index.config.columns.map(column => mysql.escapeId(column.name)).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${mysql.escapeId(config.name)} (${columns.join(", ")}) ENGINE=InnoDB`;
}

try {
  const [identity] = await pool.query("SELECT DATABASE() AS database_name, CURRENT_USER() AS database_user");
  if (identity[0]?.database_name !== "csa_pricing_local" || !String(identity[0]?.database_user).startsWith("csa_local@")) {
    throw new Error("The connected MySQL account is not the local pricing database account.");
  }

  for (const table of baseTables) await pool.query(tableSql(table));
  await ensureFarmStockSchema();
  await ensureLocalLineSyncSchema();
  await ensureAdminAccessSchema();
  await ensureSquareSyncSchema();
  await ensureProductSyncSchema();
  await ensureEnterprisePricingSchema();

  await pool.query("INSERT INTO vendors (id, name) VALUES (9001, 'Deck Family Farm'), (9002, 'Example Farm') ON DUPLICATE KEY UPDATE id = id");
  await pool.query("INSERT INTO categories (id, name) VALUES (9001, 'Local Pricing Fixtures') ON DUPLICATE KEY UPDATE id = id");
  await pool.query(`INSERT INTO products (id, name, vendor_id, category_id, visible, is_deleted)
    VALUES (9000001, 'Synthetic Ground Beef', 9001, 9001, 1, 0),
           (9000002, 'Synthetic Apple Box', 9002, 9001, 1, 0),
           (9000003, 'Synthetic Deposit', 9001, 9001, 1, 0)
    ON DUPLICATE KEY UPDATE id = id`);
  await pool.query(`INSERT INTO packages (id, product_id, name, price, unit, num_of_items, visible)
    VALUES (9000001, 9000001, '1 lb', 12.00, 'lbs', 1, 1),
           (9000002, 9000002, '1 box', 18.00, 'each', 1, 1),
           (9000003, 9000003, '1 deposit', 5.00, 'each', 1, 1)
    ON DUPLICATE KEY UPDATE id = id`);
  await pool.query(`INSERT INTO product_pricing_profiles
    (product_id, unit_of_measure, source_unit_price, source_multiplier, guest_markup, member_markup, herd_share_markup, snap_markup)
    VALUES (9000001, 'lbs', 12.00, 0.5412, 0.55, 0.40, 0.40, 0.40),
           (9000003, 'each', 5.00, 1.0000, 0, 0, 0, 0)
    ON DUPLICATE KEY UPDATE product_id = product_id`);

  console.log("Local pricing database ready with three synthetic products.");
} finally {
  await pool.end();
}
