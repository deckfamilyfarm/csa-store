import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { relations } from "drizzle-orm";
import * as schema from "./schema.js";
import { ADMIN_ROLE_DEFINITIONS } from "./lib/adminRoles.js";

let db;
let pool;
let localLineSchemaPromise;
let adminAccessSchemaPromise;
let adminPricelistIndexesPromise;

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
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_order_id INT NOT NULL,
      status VARCHAR(64),
      price_list_id INT,
      price_list_name VARCHAR(255),
      customer_id INT,
      customer_name VARCHAR(255),
      created_at_remote DATETIME,
      updated_at_remote DATETIME,
      opened_at_remote DATETIME,
      fulfillment_strategy_id INT,
      fulfillment_strategy_name VARCHAR(255),
      fulfillment_type VARCHAR(64),
      fulfillment_status VARCHAR(64),
      fulfillment_date DATETIME,
      pickup_start_time VARCHAR(32),
      pickup_end_time VARCHAR(32),
      payment_status VARCHAR(64),
      subtotal DECIMAL(10, 2),
      tax DECIMAL(10, 2),
      total DECIMAL(10, 2),
      discount DECIMAL(10, 2),
      product_count INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_order_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_order_entry_id INT NOT NULL,
      local_line_order_id INT NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      package_name VARCHAR(255),
      vendor_id INT,
      vendor_name VARCHAR(255),
      category_name VARCHAR(255),
      unit_quantity DECIMAL(10, 3),
      inventory_quantity DECIMAL(10, 3),
      price DECIMAL(10, 2),
      total_price DECIMAL(10, 2),
      price_per_unit VARCHAR(64),
      charge_type VARCHAR(64),
      track_type VARCHAR(64),
      pack_weight DECIMAL(10, 3),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_cursors (
      sync_key VARCHAR(64) PRIMARY KEY,
      cursor_value VARCHAR(255),
      synced_through_at DATETIME,
      last_started_at DATETIME,
      last_finished_at DATETIME,
      last_status VARCHAR(32),
      last_message TEXT,
      summary_json TEXT,
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
  },
  {
    tableName: "drop_sites",
    indexName: "ux_drop_sites_local_line_fulfillment",
    unique: true,
    columns: "local_line_fulfillment_strategy_id"
  },
  {
    tableName: "local_line_orders",
    indexName: "ux_local_line_orders_remote_id",
    unique: true,
    columns: "local_line_order_id"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_created_remote",
    columns: "created_at_remote"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_updated_remote",
    columns: "updated_at_remote"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_fulfillment_site",
    columns: "fulfillment_strategy_name"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "ux_local_line_order_entries_remote_id",
    unique: true,
    columns: "local_line_order_entry_id"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_order",
    columns: "local_line_order_id"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_vendor",
    columns: "vendor_name"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_product",
    columns: "product_name"
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
  },
  {
    tableName: "drop_sites",
    columnName: "source",
    definition: "source VARCHAR(32) DEFAULT 'local'"
  },
  {
    tableName: "drop_sites",
    columnName: "local_line_fulfillment_strategy_id",
    definition: "local_line_fulfillment_strategy_id INT"
  },
  {
    tableName: "drop_sites",
    columnName: "type",
    definition: "type VARCHAR(32)"
  },
  {
    tableName: "drop_sites",
    columnName: "fulfillment_type",
    definition: "fulfillment_type VARCHAR(32)"
  },
  {
    tableName: "drop_sites",
    columnName: "timezone",
    definition: "timezone VARCHAR(64)"
  },
  {
    tableName: "drop_sites",
    columnName: "latitude",
    definition: "latitude DECIMAL(10, 7)"
  },
  {
    tableName: "drop_sites",
    columnName: "longitude",
    definition: "longitude DECIMAL(10, 7)"
  },
  {
    tableName: "drop_sites",
    columnName: "instructions",
    definition: "instructions TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "address_json",
    definition: "address_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "availability_json",
    definition: "availability_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "price_lists_json",
    definition: "price_lists_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "raw_json",
    definition: "raw_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "last_synced_at",
    definition: "last_synced_at DATETIME"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_strategy_id",
    definition: "fulfillment_strategy_id INT"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_strategy_name",
    definition: "fulfillment_strategy_name VARCHAR(255)"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_date",
    definition: "fulfillment_date DATETIME"
  },
  {
    tableName: "local_line_orders",
    columnName: "pickup_start_time",
    definition: "pickup_start_time VARCHAR(32)"
  },
  {
    tableName: "local_line_orders",
    columnName: "pickup_end_time",
    definition: "pickup_end_time VARCHAR(32)"
  }
];

const ADMIN_ACCESS_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS admin_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_key VARCHAR(64) NOT NULL,
      label VARCHAR(128) NOT NULL,
      description TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY ux_admin_roles_key (role_key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS admin_user_roles (
      user_id INT NOT NULL,
      role_id INT NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (user_id, role_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      requested_by_user_id INT,
      requested_by_admin TINYINT(1) DEFAULT 0,
      used_at DATETIME,
      expires_at DATETIME NOT NULL,
      created_at DATETIME,
      UNIQUE KEY ux_password_reset_tokens_hash (token_hash)
    )
  `
];

const ADMIN_ACCESS_COLUMN_STATEMENTS = [
  {
    tableName: "users",
    columnName: "username",
    definition: "username VARCHAR(255)"
  },
  {
    tableName: "users",
    columnName: "name",
    definition: "name VARCHAR(255)"
  },
  {
    tableName: "users",
    columnName: "active",
    definition: "active TINYINT(1) DEFAULT 1"
  },
  {
    tableName: "users",
    columnName: "timesheets_user_id",
    definition: "timesheets_user_id VARCHAR(64)"
  },
  {
    tableName: "users",
    columnName: "timesheets_employee_id",
    definition: "timesheets_employee_id VARCHAR(64)"
  }
];

const ADMIN_ACCESS_INDEX_STATEMENTS = [
  {
    tableName: "admin_user_roles",
    indexName: "idx_admin_user_roles_role",
    columns: "role_id"
  },
  {
    tableName: "password_reset_tokens",
    indexName: "idx_password_reset_tokens_user",
    columns: "user_id"
  },
  {
    tableName: "password_reset_tokens",
    indexName: "idx_password_reset_tokens_expires",
    columns: "expires_at"
  },
  {
    tableName: "users",
    indexName: "ux_users_username",
    unique: true,
    columns: "username"
  }
];

const ADMIN_PRICELIST_INDEX_STATEMENTS = [
  {
    tableName: "products",
    indexName: "idx_products_category",
    columns: "category_id"
  },
  {
    tableName: "products",
    indexName: "idx_products_vendor",
    columns: "vendor_id"
  },
  {
    tableName: "products",
    indexName: "idx_products_name",
    columns: "name"
  },
  {
    tableName: "packages",
    indexName: "idx_packages_product",
    columns: "product_id"
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

async function singleColumnUniqueIndexes(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT index_name AS indexName
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND non_unique = 0
      GROUP BY index_name
      HAVING COUNT(*) = 1
        AND MAX(column_name = ?) = 1
    `,
    [tableName, columnName]
  );
  return rows.map((row) => row.indexName).filter((indexName) => indexName !== "PRIMARY");
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

async function runAdminAccessSchemaBootstrap(connection) {
  for (const statement of ADMIN_ACCESS_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const columnDefinition of ADMIN_ACCESS_COLUMN_STATEMENTS) {
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

  await connection.query(
    `
      UPDATE users
      SET username = TRIM(email)
      WHERE (username IS NULL OR TRIM(username) = '')
        AND email IS NOT NULL
        AND TRIM(email) <> ''
    `
  );
  await connection.query(
    `
      UPDATE users
      SET username = CONCAT('user-', id)
      WHERE username IS NULL
        OR TRIM(username) = ''
    `
  );
  await connection.query(
    `
      UPDATE users
      SET email = NULL
      WHERE email IS NOT NULL
        AND email NOT REGEXP '^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'
    `
  );

  await connection.query("ALTER TABLE users MODIFY username VARCHAR(255) NOT NULL");
  await connection.query("ALTER TABLE users MODIFY email VARCHAR(255)");

  const emailUniqueIndexes = await singleColumnUniqueIndexes(connection, "users", "email");
  for (const indexName of emailUniqueIndexes) {
    await connection.query(`ALTER TABLE users DROP INDEX \`${String(indexName).replace(/`/g, "``")}\``);
  }

  for (const indexDefinition of ADMIN_ACCESS_INDEX_STATEMENTS) {
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

  const now = new Date();
  for (const role of ADMIN_ROLE_DEFINITIONS) {
    await connection.query(
      `
        INSERT INTO admin_roles (role_key, label, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          label = VALUES(label),
          description = VALUES(description),
          updated_at = VALUES(updated_at)
      `,
      [role.key, role.label, role.description, now, now]
    );
  }

  await connection.query(
    `
      INSERT IGNORE INTO admin_user_roles (user_id, role_id, created_at)
      SELECT u.id, r.id, ?
      FROM users u
      JOIN admin_roles r ON r.role_key = 'admin'
      WHERE u.role IN ('admin', 'administrator')
    `,
    [now]
  );
}

async function runAdminPricelistIndexBootstrap(connection) {
  for (const indexDefinition of ADMIN_PRICELIST_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    await connection.query(
      `CREATE INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
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

export async function ensureAdminAccessSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!adminAccessSchemaPromise) {
      adminAccessSchemaPromise = runAdminAccessSchemaBootstrap(connection).catch((error) => {
        adminAccessSchemaPromise = null;
        throw error;
      });
    }
    return adminAccessSchemaPromise;
  }

  return runAdminAccessSchemaBootstrap(connection);
}

export async function ensureAdminPricelistIndexes(connection = getPool()) {
  if (connection === getPool()) {
    if (!adminPricelistIndexesPromise) {
      adminPricelistIndexesPromise = runAdminPricelistIndexBootstrap(connection).catch((error) => {
        adminPricelistIndexesPromise = null;
        throw error;
      });
    }
    return adminPricelistIndexesPromise;
  }

  return runAdminPricelistIndexBootstrap(connection);
}

export function isMissingTableError(error, tableName = "") {
  if (!error) return false;
  if (error.code !== "ER_NO_SUCH_TABLE") return false;
  if (!tableName) return true;
  return String(error.sqlMessage || error.message || "").includes(`.${tableName}`);
}

export { schema, relations };
