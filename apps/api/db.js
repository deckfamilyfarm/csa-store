import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { relations } from "drizzle-orm";
import * as schema from "./schema.js";

let db;
let pool;
let localLineSchemaPromise;

const LOCAL_LINE_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS price_lists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_price_list_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      active TINYINT(1) DEFAULT 1,
      source VARCHAR(32) DEFAULT 'localline',
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS package_price_list_memberships (
      package_id INT NOT NULL,
      price_list_id INT NOT NULL,
      present TINYINT(1) DEFAULT 1,
      adjustment_type TINYINT(1),
      adjustment_value DECIMAL(10, 2),
      calculated_value DECIMAL(10, 2),
      base_price_used DECIMAL(10, 2),
      final_price_cache DECIMAL(10, 2),
      on_sale TINYINT(1) DEFAULT 0,
      on_sale_toggle TINYINT(1) DEFAULT 0,
      strikethrough_display_value DECIMAL(10, 2),
      max_units_per_order INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME,
      PRIMARY KEY (package_id, price_list_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_price_list_memberships (
      product_id INT NOT NULL,
      price_list_id INT NOT NULL,
      package_count INT DEFAULT 0,
      all_packages_present TINYINT(1) DEFAULT 0,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME,
      PRIMARY KEY (product_id, price_list_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_pricing_profiles (
      product_id INT PRIMARY KEY,
      unit_of_measure VARCHAR(16) DEFAULT 'each',
      source_unit_price DECIMAL(10, 2),
      min_weight DECIMAL(10, 3),
      max_weight DECIMAL(10, 3),
      avg_weight_override DECIMAL(10, 3),
      source_multiplier DECIMAL(10, 4) DEFAULT 0.5412,
      guest_markup DECIMAL(10, 4),
      member_markup DECIMAL(10, 4),
      herd_share_markup DECIMAL(10, 4),
      snap_markup DECIMAL(10, 4),
      on_sale TINYINT(1) DEFAULT 0,
      sale_discount DECIMAL(5, 4),
      remote_sync_status VARCHAR(32) DEFAULT 'pending',
      remote_sync_message TEXT,
      remote_synced_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_media (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      source VARCHAR(32) DEFAULT 'localline',
      source_media_id VARCHAR(255),
      source_url TEXT,
      remote_url TEXT,
      storage_key VARCHAR(512),
      public_url TEXT,
      thumbnail_url TEXT,
      sort_order INT DEFAULT 0,
      is_primary TINYINT(1) DEFAULT 0,
      alt_text VARCHAR(512),
      content_hash VARCHAR(128),
      width INT,
      height INT,
      mime_type VARCHAR(128),
      fetched_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_product_meta (
      product_id INT PRIMARY KEY,
      local_line_product_id INT NOT NULL,
      internal_id VARCHAR(255),
      visible TINYINT(1),
      track_inventory TINYINT(1),
      track_inventory_by VARCHAR(64),
      inventory_type VARCHAR(64),
      product_inventory INT,
      package_codes_enabled TINYINT(1),
      export_hash VARCHAR(64),
      live_hash VARCHAR(64),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_package_meta (
      package_id INT PRIMARY KEY,
      product_id INT NOT NULL,
      local_line_package_id INT NOT NULL,
      inventory_type VARCHAR(64),
      package_inventory INT,
      package_reserved_inventory INT,
      package_available_inventory INT,
      avg_package_weight DECIMAL(10, 3),
      num_of_items INT,
      package_code VARCHAR(255),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mode VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      summary_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_price_list_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      local_line_product_id INT,
      package_id INT,
      local_line_package_id INT,
      price_list_id INT NOT NULL,
      local_line_price_list_id INT NOT NULL,
      entry_scope VARCHAR(16) NOT NULL,
      source_entry_id VARCHAR(255),
      price_list_name VARCHAR(255),
      product_name VARCHAR(255),
      package_name VARCHAR(255),
      visible TINYINT(1),
      track_inventory TINYINT(1),
      package_code VARCHAR(255),
      adjustment_type TINYINT(1),
      adjustment_value DECIMAL(10, 2),
      calculated_value DECIMAL(10, 2),
      base_price_used DECIMAL(10, 2),
      final_price_cache DECIMAL(10, 2),
      on_sale TINYINT(1) DEFAULT 0,
      on_sale_toggle TINYINT(1) DEFAULT 0,
      strikethrough_display_value DECIMAL(10, 2),
      max_units_per_order INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_issues (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sync_run_id INT NOT NULL,
      severity VARCHAR(16) NOT NULL,
      issue_type VARCHAR(64) NOT NULL,
      product_id INT,
      package_id INT,
      price_list_id INT,
      details_json TEXT,
      resolved_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const LOCAL_LINE_INDEX_STATEMENTS = [
  {
    tableName: "price_lists",
    indexName: "ux_price_lists_local_line_id",
    unique: true,
    columns: "local_line_price_list_id"
  },
  {
    tableName: "package_price_list_memberships",
    indexName: "idx_package_price_list_memberships_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "product_price_list_memberships",
    indexName: "idx_product_price_list_memberships_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "product_media",
    indexName: "idx_product_media_product",
    columns: "product_id"
  },
  {
    tableName: "product_media",
    indexName: "idx_product_media_source_media",
    columns: "source, source_media_id"
  },
  {
    tableName: "local_line_product_meta",
    indexName: "idx_local_line_product_meta_local_line_id",
    columns: "local_line_product_id"
  },
  {
    tableName: "local_line_package_meta",
    indexName: "idx_local_line_package_meta_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_package_meta",
    indexName: "idx_local_line_package_meta_local_line_id",
    columns: "local_line_package_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_package",
    columns: "package_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_run",
    columns: "sync_run_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_package",
    columns: "package_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_price_list",
    columns: "price_list_id"
  }
];

const LOCAL_LINE_COLUMN_STATEMENTS = [
  {
    tableName: "local_line_product_meta",
    columnName: "vendor_name",
    definition: "vendor_name VARCHAR(255)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "status",
    definition: "status VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "reserved_inventory",
    definition: "reserved_inventory INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "available_inventory",
    definition: "available_inventory INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "ownership_type",
    definition: "ownership_type VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "packing_tag",
    definition: "packing_tag VARCHAR(255)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "export_hash",
    definition: "export_hash VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "live_hash",
    definition: "live_hash VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "last_live_fetch_status",
    definition: "last_live_fetch_status INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "last_live_fetch_error",
    definition: "last_live_fetch_error TEXT"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_name",
    definition: "live_name VARCHAR(255)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_price",
    definition: "live_price DECIMAL(10, 2)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_visible",
    definition: "live_visible TINYINT(1)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_track_inventory",
    definition: "live_track_inventory TINYINT(1)"
  }
];

async function indexExists(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?
      LIMIT 1
    `,
    [tableName, indexName]
  );
  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function runLocalLineSchemaBootstrap(connection) {
  for (const statement of LOCAL_LINE_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const columnDefinition of LOCAL_LINE_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  for (const indexDefinition of LOCAL_LINE_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

export function initDb() {
  if (db) return db;

  pool = mysql.createPool({
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

export function getDb() {
  return db ?? initDb();
}

export function getPool() {
  if (!pool) initDb();
  return pool;
}

export async function ensureLocalLineSyncSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!localLineSchemaPromise) {
      localLineSchemaPromise = runLocalLineSchemaBootstrap(connection).catch((error) => {
        localLineSchemaPromise = null;
        throw error;
      });
    }
    return localLineSchemaPromise;
  }

  return runLocalLineSchemaBootstrap(connection);
}

export function isMissingTableError(error, tableName = "") {
  if (!error) return false;
  if (error.code !== "ER_NO_SUCH_TABLE") return false;
  if (!tableName) return true;
  return String(error.sqlMessage || error.message || "").includes(`.${tableName}`);
}

export { schema, relations };
