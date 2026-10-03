// These tables deliberately have no connection to Local Line product/package stock.
// Time instants use UTC epoch milliseconds; pickup_date is a Pacific calendar date.
const bootstraps = new WeakMap();
export function ensureStorefrontSchema(pool) {
  if (!bootstraps.has(pool)) bootstraps.set(pool, bootstrap(pool).catch(error => {
    bootstraps.delete(pool);
    throw error;
  }));
  return bootstraps.get(pool);
}

async function bootstrap(pool) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS storefront_settings (
      id INT PRIMARY KEY, show_products TINYINT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1, updated_ms BIGINT, updated_by INT
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_sales (
      id INT PRIMARY KEY, title VARCHAR(200) NOT NULL, description TEXT NOT NULL,
      image_url VARCHAR(2048) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'draft',
      pickup_date VARCHAR(10) NOT NULL, closes_ms BIGINT, contact_email VARCHAR(254) NOT NULL DEFAULT '',
      heritage_description TEXT, broad_breasted_description TEXT,
      notify_email VARCHAR(254) NOT NULL DEFAULT '', updated_ms BIGINT NOT NULL,
      version INT NOT NULL DEFAULT 1, updated_by INT
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_options (
      id INT AUTO_INCREMENT PRIMARY KEY, sale_id INT NOT NULL, product_id INT, label VARCHAR(255) NOT NULL,
      description TEXT NOT NULL, price_cents INT NOT NULL DEFAULT 0, on_hand INT NOT NULL DEFAULT 0,
      reserved INT NOT NULL DEFAULT 0, active TINYINT NOT NULL DEFAULT 1,
      INDEX sale_options (sale_id, active), CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_pickup_groups (
      id INT AUTO_INCREMENT PRIMARY KEY, sale_id INT NOT NULL, name VARCHAR(120) NOT NULL, active TINYINT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_pickups (
      id INT AUTO_INCREMENT PRIMARY KEY, sale_id INT NOT NULL, group_id INT NOT NULL DEFAULT 1,
      active TINYINT NOT NULL DEFAULT 1, name VARCHAR(120) NOT NULL,
      address VARCHAR(500) NOT NULL DEFAULT '', hours VARCHAR(120) NOT NULL DEFAULT '', instructions TEXT NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_orders (
      id CHAR(36) PRIMARY KEY, number VARCHAR(40) NOT NULL UNIQUE, sale_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL,
      status VARCHAR(24) NOT NULL, customer_json TEXT NOT NULL, pickup_json TEXT NOT NULL,
      total_cents INT NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'usd',
      stripe_request_json MEDIUMTEXT NOT NULL, stripe_session_id VARCHAR(255) UNIQUE,
      stripe_payment_id VARCHAR(255) UNIQUE, checkout_url TEXT, expires_ms BIGINT NOT NULL,
      created_ms BIGINT NOT NULL, paid_ms BIGINT, collected_ms BIGINT, collected_by INT,
      refund_key CHAR(36), refund_id VARCHAR(255), refund_status VARCHAR(40), refunded_cents INT NOT NULL DEFAULT 0,
      refund_requested_by INT, refund_requested_ms BIGINT,
      cancelled_ms BIGINT, cancel_requested TINYINT NOT NULL DEFAULT 0, last_error TEXT,
      contact_email VARCHAR(254) NOT NULL, notify_email VARCHAR(254) NOT NULL,
      INDEX pending_orders (status, created_ms), INDEX sale_orders (sale_id, created_ms)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_order_items (
      order_id CHAR(36) NOT NULL, option_id INT NOT NULL, label VARCHAR(255) NOT NULL,
      quantity INT NOT NULL, price_cents INT NOT NULL, PRIMARY KEY (order_id, option_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_stock_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, option_id INT NOT NULL, order_id CHAR(36),
      delta_on_hand INT NOT NULL, delta_reserved INT NOT NULL, reason VARCHAR(500) NOT NULL,
      actor_id INT, created_ms BIGINT NOT NULL, INDEX stock_option (option_id, id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_webhooks (
      event_id VARCHAR(255) PRIMARY KEY, event_type VARCHAR(100) NOT NULL, processed_ms BIGINT NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS storefront_emails (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, kind VARCHAR(24) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
      next_attempt_ms BIGINT NOT NULL, sent_ms BIGINT, last_error TEXT,
      UNIQUE KEY order_email (order_id, kind), INDEX due_emails (status, next_attempt_ms)
    ) ENGINE=InnoDB`
  ]) await pool.query(sql);
  await pool.query('INSERT IGNORE INTO storefront_settings (id) VALUES (1)');
  // Upgrade the first preorder schema without losing allocations or order snapshots.
  for (const [table, column, definition] of [
    ['storefront_sales', 'heritage_description', 'TEXT'],
    ['storefront_sales', 'broad_breasted_description', 'TEXT'],
    ['storefront_options', 'product_id', 'INT'],
    ['storefront_pickups', 'group_id', 'INT NOT NULL DEFAULT 1'],
    ['storefront_pickups', 'active', 'TINYINT NOT NULL DEFAULT 1']
  ]) {
    const [rows] = await pool.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
    if (!rows.length) await pool.query(`ALTER TABLE ?? ADD COLUMN ?? ${definition}`, [table, column]).catch(error => {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    });
  }
  const [[pickupId]] = await pool.query("SHOW COLUMNS FROM storefront_pickups LIKE 'id'");
  if (!pickupId.Extra.includes('auto_increment')) await pool.query('ALTER TABLE storefront_pickups MODIFY id INT NOT NULL AUTO_INCREMENT');
  for (const table of ['storefront_options', 'storefront_order_items']) {
    const [[label]] = await pool.query("SHOW COLUMNS FROM ?? LIKE 'label'", [table]);
    if (label.Type !== 'varchar(255)') await pool.query('ALTER TABLE ?? MODIFY label VARCHAR(255) NOT NULL', [table]);
  }
  await pool.query(`INSERT IGNORE INTO storefront_sales
    (id,title,description,pickup_date,updated_ms) VALUES (1,?,?,?,?)`, [
    'Thanksgiving turkey preorders', 'Reserve your Deck Family Farm turkey for Saturday pickup.', '2026-11-21', Date.now()
  ]);
  await pool.query("INSERT IGNORE INTO storefront_pickup_groups (id,sale_id,name) VALUES (1,1,'Thanksgiving pickup')");
  for (const [index, name] of ['PSU Farmers Market', 'Hollywood Farmers Market', 'Lane County Farmers Market', 'Farm Pickup'].entries()) {
    await pool.query(`INSERT IGNORE INTO storefront_pickups (id,sale_id,name,instructions) VALUES (?,1,?,'')`, [index + 1, name]);
  }
}
