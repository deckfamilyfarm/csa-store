-- Add admin/recipe tables if missing (run in `store` database)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) DEFAULT 'member',
  name VARCHAR(255),
  active TINYINT(1) DEFAULT 1,
  timesheets_user_id VARCHAR(64),
  timesheets_employee_id VARCHAR(64),
  created_at DATETIME,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS admin_roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_key VARCHAR(64) NOT NULL UNIQUE,
  label VARCHAR(128) NOT NULL,
  description TEXT,
  created_at DATETIME,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  created_at DATETIME,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_user_roles_role
  ON admin_user_roles (role_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  requested_by_user_id INT,
  requested_by_admin TINYINT(1) DEFAULT 0,
  used_at DATETIME,
  expires_at DATETIME NOT NULL,
  created_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON password_reset_tokens (expires_at);

ALTER TABLE vendors
  ADD COLUMN guest_markup DECIMAL(5, 2) DEFAULT 0.55,
  ADD COLUMN member_markup DECIMAL(5, 2) DEFAULT 0.40;

CREATE TABLE IF NOT EXISTS recipes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  note TEXT,
  image_url TEXT,
  ingredients_json TEXT,
  steps_json TEXT,
  published TINYINT(1) DEFAULT 1,
  created_at DATETIME,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  user_id INT,
  rating INT NOT NULL,
  title VARCHAR(255),
  body TEXT,
  status VARCHAR(32) DEFAULT 'pending',
  created_at DATETIME,
  updated_at DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_user_product
  ON reviews (product_id, user_id);

CREATE TABLE IF NOT EXISTS product_sales (
  product_id INT PRIMARY KEY,
  on_sale TINYINT(1) DEFAULT 0,
  sale_discount DECIMAL(5, 2),
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS drop_sites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  day_of_week VARCHAR(16),
  open_time VARCHAR(16),
  close_time VARCHAR(16),
  active TINYINT(1) DEFAULT 1,
  created_at DATETIME,
  updated_at DATETIME
);
