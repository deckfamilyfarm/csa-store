-- Local Line sync support tables for the `store` database

CREATE TABLE IF NOT EXISTS price_lists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  local_line_price_list_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  active TINYINT(1) DEFAULT 1,
  source VARCHAR(32) DEFAULT 'localline',
  created_at DATETIME,
  updated_at DATETIME,
  last_synced_at DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_price_lists_local_line_id
  ON price_lists (local_line_price_list_id);

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
);

CREATE INDEX IF NOT EXISTS idx_package_price_list_memberships_price_list
  ON package_price_list_memberships (price_list_id);

CREATE TABLE IF NOT EXISTS product_price_list_memberships (
  product_id INT NOT NULL,
  price_list_id INT NOT NULL,
  package_count INT DEFAULT 0,
  all_packages_present TINYINT(1) DEFAULT 0,
  created_at DATETIME,
  updated_at DATETIME,
  last_synced_at DATETIME,
  PRIMARY KEY (product_id, price_list_id)
);

CREATE INDEX IF NOT EXISTS idx_product_price_list_memberships_price_list
  ON product_price_list_memberships (price_list_id);

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
);

CREATE INDEX IF NOT EXISTS idx_product_media_product
  ON product_media (product_id);

CREATE INDEX IF NOT EXISTS idx_product_media_source_media
  ON product_media (source, source_media_id);

CREATE TABLE IF NOT EXISTS local_line_product_meta (
  product_id INT PRIMARY KEY,
  local_line_product_id INT NOT NULL,
  internal_id VARCHAR(255),
  vendor_name VARCHAR(255),
  status VARCHAR(64),
  visible TINYINT(1),
  track_inventory TINYINT(1),
  track_inventory_by VARCHAR(64),
  inventory_type VARCHAR(64),
  product_inventory INT,
  reserved_inventory INT,
  available_inventory INT,
  package_codes_enabled TINYINT(1),
  ownership_type VARCHAR(64),
  packing_tag VARCHAR(255),
  export_hash VARCHAR(64),
  live_hash VARCHAR(64),
  last_live_fetch_status INT,
  last_live_fetch_error TEXT,
  raw_json TEXT,
  created_at DATETIME,
  updated_at DATETIME,
  last_synced_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_local_line_product_meta_local_line_id
  ON local_line_product_meta (local_line_product_id);

CREATE TABLE IF NOT EXISTS local_line_package_meta (
  package_id INT PRIMARY KEY,
  product_id INT NOT NULL,
  local_line_package_id INT NOT NULL,
  live_name VARCHAR(255),
  live_price DECIMAL(10, 2),
  live_visible TINYINT(1),
  live_track_inventory TINYINT(1),
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
);

CREATE INDEX IF NOT EXISTS idx_local_line_package_meta_product
  ON local_line_package_meta (product_id);

CREATE INDEX IF NOT EXISTS idx_local_line_package_meta_local_line_id
  ON local_line_package_meta (local_line_package_id);

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
);

CREATE INDEX IF NOT EXISTS idx_local_line_price_list_entries_product
  ON local_line_price_list_entries (product_id);

CREATE INDEX IF NOT EXISTS idx_local_line_price_list_entries_package
  ON local_line_price_list_entries (package_id);

CREATE INDEX IF NOT EXISTS idx_local_line_price_list_entries_price_list
  ON local_line_price_list_entries (price_list_id);

CREATE TABLE IF NOT EXISTS local_line_sync_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME,
  summary_json TEXT,
  created_at DATETIME,
  updated_at DATETIME
);

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
);

CREATE INDEX IF NOT EXISTS idx_local_line_sync_issues_run
  ON local_line_sync_issues (sync_run_id);

CREATE INDEX IF NOT EXISTS idx_local_line_sync_issues_product
  ON local_line_sync_issues (product_id);

CREATE INDEX IF NOT EXISTS idx_local_line_sync_issues_package
  ON local_line_sync_issues (package_id);

CREATE INDEX IF NOT EXISTS idx_local_line_sync_issues_price_list
  ON local_line_sync_issues (price_list_id);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_local_line_orders_remote_id
  ON local_line_orders (local_line_order_id);

CREATE INDEX IF NOT EXISTS idx_local_line_orders_created_remote
  ON local_line_orders (created_at_remote);

CREATE INDEX IF NOT EXISTS idx_local_line_orders_updated_remote
  ON local_line_orders (updated_at_remote);

CREATE INDEX IF NOT EXISTS idx_local_line_orders_fulfillment_site
  ON local_line_orders (fulfillment_strategy_name);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_local_line_order_entries_remote_id
  ON local_line_order_entries (local_line_order_entry_id);

CREATE INDEX IF NOT EXISTS idx_local_line_order_entries_order
  ON local_line_order_entries (local_line_order_id);

CREATE INDEX IF NOT EXISTS idx_local_line_order_entries_vendor
  ON local_line_order_entries (vendor_name);

CREATE INDEX IF NOT EXISTS idx_local_line_order_entries_product
  ON local_line_order_entries (product_name);

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
);

ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS source VARCHAR(32) DEFAULT 'local';
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS local_line_fulfillment_strategy_id INT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS type VARCHAR(32);
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(32);
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 7);
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS longitude DECIMAL(10, 7);
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS address_json TEXT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS availability_json TEXT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS price_lists_json TEXT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS raw_json TEXT;
ALTER TABLE drop_sites ADD COLUMN IF NOT EXISTS last_synced_at DATETIME;
ALTER TABLE local_line_orders ADD COLUMN IF NOT EXISTS fulfillment_strategy_id INT;
ALTER TABLE local_line_orders ADD COLUMN IF NOT EXISTS fulfillment_strategy_name VARCHAR(255);
ALTER TABLE local_line_orders ADD COLUMN IF NOT EXISTS fulfillment_date DATETIME;
ALTER TABLE local_line_orders ADD COLUMN IF NOT EXISTS pickup_start_time VARCHAR(32);
ALTER TABLE local_line_orders ADD COLUMN IF NOT EXISTS pickup_end_time VARCHAR(32);

CREATE UNIQUE INDEX IF NOT EXISTS ux_drop_sites_local_line_fulfillment
  ON drop_sites (local_line_fulfillment_strategy_id);
