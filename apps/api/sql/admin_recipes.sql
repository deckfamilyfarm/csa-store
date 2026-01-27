-- Add admin/recipe tables if missing (run in `store` database)
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) DEFAULT 'member',
  created_at DATETIME,
  updated_at DATETIME
);

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
  rating INT NOT NULL,
  title VARCHAR(255),
  body TEXT,
  status VARCHAR(32) DEFAULT 'pending',
  created_at DATETIME,
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
