import { getPool, ensureSquareSyncSchema } from "../db.js";

let schemaPromise;
export async function ensureEnterprisePricingSchema() {
  if (!schemaPromise) schemaPromise = bootstrap().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function bootstrap() {
  await ensureSquareSyncSchema();
  const pool = getPool();
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_enterprises (
      id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_settings_versions (
      id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(24) NOT NULL, settings_json LONGTEXT NOT NULL,
      created_by INT, approved_by INT, created_at DATETIME NOT NULL, approved_at DATETIME,
      INDEX settings_status (status, id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_revisions (
      id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, settings_version_id INT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending', input_json LONGTEXT NOT NULL, output_json LONGTEXT NOT NULL,
      editor_id INT NOT NULL, approver_id INT, created_at DATETIME NOT NULL, approved_at DATETIME,
      active_at DATETIME, rejected_at DATETIME,
      INDEX revisions_product (product_id, id), INDEX revisions_status (status, id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_product_state (
      product_id INT PRIMARY KEY, latest_revision_id INT, active_revision_id INT, migrated_at DATETIME,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_purchase_cost_history (
      id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, purchasing_enterprise_id INT NOT NULL,
      cost DECIMAL(14,4) NOT NULL, effective_at DATETIME NOT NULL, documentation_ref VARCHAR(2048),
      revision_id INT NOT NULL, recorded_at DATETIME NOT NULL,
      UNIQUE KEY purchase_cost_revision (revision_id, purchasing_enterprise_id, effective_at),
      INDEX cost_product_enterprise (product_id, purchasing_enterprise_id, effective_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_buy_price_drafts (
      product_id INT PRIMARY KEY, purchasing_enterprise_id INT NOT NULL,
      price DECIMAL(14,2) NOT NULL, revision INT NOT NULL DEFAULT 1,
      edited_by INT, updated_at DATETIME NOT NULL,
      INDEX buy_price_enterprise (purchasing_enterprise_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_migration_rows (
      id INT AUTO_INCREMENT PRIMARY KEY, migration_version VARCHAR(64) NOT NULL,
      run_key VARCHAR(64) NOT NULL, product_id INT NOT NULL, source_hash CHAR(64) NOT NULL,
      source_json LONGTEXT NOT NULL, plan_json LONGTEXT NOT NULL, revision_id INT,
      status VARCHAR(32) NOT NULL, created_by INT NOT NULL, created_at DATETIME NOT NULL,
      UNIQUE KEY migration_product (migration_version, product_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_wholesale_price_history (
      id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, selling_enterprise_id INT NOT NULL,
      mode VARCHAR(16) NOT NULL, price_cents INT, markup_bp INT, cost_enterprise_id INT,
      revision_id INT NOT NULL, recorded_at DATETIME NOT NULL,
      UNIQUE KEY wholesale_revision (revision_id, selling_enterprise_id),
      INDEX wholesale_product_enterprise (product_id, selling_enterprise_id, id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_pricing_publications (
      revision_id INT NOT NULL, platform VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL,
      audit_id INT, release_id INT, frozen_json LONGTEXT NOT NULL, result_json LONGTEXT,
      verified_at DATETIME, updated_at DATETIME NOT NULL,
      PRIMARY KEY (revision_id, platform), INDEX publication_status (status, revision_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_promotions (
      id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(24) NOT NULL DEFAULT 'pending',
      input_json LONGTEXT NOT NULL, output_json LONGTEXT NOT NULL,
      editor_id INT NOT NULL, approver_id INT, created_at DATETIME NOT NULL, approved_at DATETIME,
      cancelled_at DATETIME, square_request_key VARCHAR(64), square_request_json LONGTEXT,
      square_receipt_json LONGTEXT, square_status VARCHAR(24), localline_status VARCHAR(24),
      last_error TEXT, updated_at DATETIME NOT NULL,
      INDEX promotion_status (status, id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS enterprise_promotion_events (
      id INT AUTO_INCREMENT PRIMARY KEY, promotion_id INT NOT NULL, event VARCHAR(32) NOT NULL,
      actor_id INT, details_json LONGTEXT, created_at DATETIME NOT NULL,
      INDEX promotion_events (promotion_id, id)
    ) ENGINE=InnoDB`
  ]) await pool.query(sql);
  for (const [code, name] of [["ffcsa", "Full Farm CSA"], ["deck", "Deck Family Farm"], ["hyland", "Hyland"], ["creamy-cow", "Creamy Cow"]]) {
    await pool.query("INSERT IGNORE INTO enterprise_pricing_enterprises (code, name) VALUES (?, ?)", [code, name]);
  }
  const { DEFAULT_PRICING_SETTINGS } = await import("./enterprisePricingEngine.js");
  await pool.query(`INSERT INTO enterprise_pricing_settings_versions (id, status, settings_json, created_at, approved_at)
    VALUES (1, 'active', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE id=id`, [JSON.stringify(DEFAULT_PRICING_SETTINGS)]);
}
