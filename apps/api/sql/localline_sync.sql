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
