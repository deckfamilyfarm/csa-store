// Explicit additive migration only. Runtime readiness never performs DDL.
export const MERCHANDISE_TABLES = {
  merch_products: `id INT AUTO_INCREMENT PRIMARY KEY, supplier VARCHAR(32) NOT NULL DEFAULT 'printify',
    shop_id BIGINT NOT NULL, external_id VARCHAR(80) NOT NULL, vendor_id INT, category VARCHAR(80) NOT NULL DEFAULT 'Branded Merchandise',
    name VARCHAR(255) NOT NULL, description LONGTEXT NOT NULL, images_json LONGTEXT NOT NULL, source_json LONGTEXT NOT NULL,
    source_hash CHAR(64) NOT NULL, holds_json TEXT NOT NULL, provider_name VARCHAR(255),
    active TINYINT NOT NULL DEFAULT 0, artwork_reviewed TINYINT NOT NULL DEFAULT 0, currency CHAR(3),
    version INT NOT NULL DEFAULT 1, updated_ms BIGINT NOT NULL, updated_by INT,
    UNIQUE KEY supplier_product (supplier,shop_id,external_id)`,
  merch_variants: `id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, external_id BIGINT NOT NULL,
    title VARCHAR(255) NOT NULL, sku VARCHAR(120), options_json TEXT NOT NULL,
    source_enabled TINYINT NOT NULL, available TINYINT NOT NULL, cost_cents INT, channel_price_cents INT,
    proposed_retail_cents INT, retail_cents INT, enabled TINYINT NOT NULL DEFAULT 0,
    UNIQUE KEY product_variant (product_id,external_id), FOREIGN KEY (product_id) REFERENCES merch_products(id)`,
  commerce_quotes: `id CHAR(36) PRIMARY KEY, token_hash CHAR(64) NOT NULL, snapshot_json LONGTEXT NOT NULL,
    expires_ms BIGINT NOT NULL, created_ms BIGINT NOT NULL, order_id CHAR(36), INDEX quote_expiry (expires_ms)`,
  commerce_orders: `id CHAR(36) PRIMARY KEY, number VARCHAR(40) NOT NULL UNIQUE, kind VARCHAR(32) NOT NULL DEFAULT 'merchandise',
    token_hash CHAR(64) NOT NULL UNIQUE, quote_id CHAR(36) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'creating', stripe_mode VARCHAR(8) NOT NULL, stripe_account VARCHAR(80) NOT NULL,
    subtotal_cents INT NOT NULL, shipping_cents INT NOT NULL, tax_cents INT NOT NULL, total_cents INT NOT NULL,
    currency CHAR(3) NOT NULL, snapshot_json LONGTEXT NOT NULL, stripe_request_json LONGTEXT NOT NULL,
    stripe_key VARCHAR(100) NOT NULL UNIQUE, stripe_attempt_ms BIGINT, stripe_session_id VARCHAR(255) UNIQUE,
    stripe_payment_id VARCHAR(255) UNIQUE, checkout_url TEXT, expires_ms BIGINT NOT NULL,
    created_ms BIGINT NOT NULL, paid_ms BIGINT, refunded_cents INT NOT NULL DEFAULT 0,
    stripe_fee_cents INT, financial_hold TINYINT NOT NULL DEFAULT 0, last_error VARCHAR(500),
    INDEX pending_commerce (status,created_ms)`,
  commerce_fulfillments: `id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL DEFAULT 'printify',
    shop_id BIGINT NOT NULL, external_id VARCHAR(100) NOT NULL UNIQUE, request_json LONGTEXT NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'awaiting_payment', remote_id VARCHAR(100),
    attempted_ms BIGINT, receipt_json LONGTEXT, tracking_json LONGTEXT, actual_cost_cents INT,
    actual_shipping_cents INT, actual_tax_cents INT, last_error VARCHAR(500), updated_ms BIGINT NOT NULL,
    UNIQUE KEY provider_order (kind,shop_id,remote_id), FOREIGN KEY (order_id) REFERENCES commerce_orders(id)`,
  commerce_operations: `id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, fulfillment_id CHAR(36),
    kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'reviewed', baseline_hash CHAR(64) NOT NULL,
    request_json LONGTEXT NOT NULL, request_key VARCHAR(100) NOT NULL UNIQUE, amount_cents INT,
    attempted_ms BIGINT, receipt_json LONGTEXT, remote_id VARCHAR(100), created_ms BIGINT NOT NULL,
    reviewed_by INT, approved_by INT, applied_ms BIGINT, last_error VARCHAR(500),
    INDEX order_operations (order_id,kind,status), FOREIGN KEY (order_id) REFERENCES commerce_orders(id)`,
  commerce_webhooks: `provider VARCHAR(32) NOT NULL, event_id VARCHAR(255) NOT NULL,
    payload_hash CHAR(64) NOT NULL, processed_ms BIGINT NOT NULL,
    PRIMARY KEY (provider,event_id)`,
  commerce_emails: `id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL,
    payload_json LONGTEXT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    next_attempt_ms BIGINT NOT NULL, sent_ms BIGINT, last_error VARCHAR(500),
    UNIQUE KEY order_email (order_id,kind), INDEX due_commerce_mail (status,next_attempt_ms)`
};
export async function merchandisePreflight(pool) {
  const [rows] = await pool.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  const present = new Set(rows.map(row => row.name));
  const missing = Object.keys(MERCHANDISE_TABLES).filter(name => !present.has(name));
  const missingColumns=[];
  if(present.has('merch_products')) {
    const [columns]=await pool.query("SHOW COLUMNS FROM merch_products LIKE 'vendor_id'");
    if(!columns.length)missingColumns.push('merch_products.vendor_id');
  }
  return { ready: !missing.length&&!missingColumns.length, missing, missingColumns, existingFarmAndFinancialTablesChanged: false };
}
export async function migrateMerchandise(pool) {
  for (const [table, definition] of Object.entries(MERCHANDISE_TABLES)) await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (${definition}) ENGINE=InnoDB`);
  const [columns]=await pool.query("SHOW COLUMNS FROM merch_products LIKE 'vendor_id'");
  if(!columns.length)await pool.query('ALTER TABLE merch_products ADD COLUMN vendor_id INT');
  return merchandisePreflight(pool);
}
export async function assertMerchandiseSchema(pool) {
  if (!(await merchandisePreflight(pool)).ready) throw Object.assign(new Error('Install the merchandise migration with --check, then --apply.'), { status: 503 });
}
