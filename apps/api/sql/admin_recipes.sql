-- Add admin/recipe tables if missing (run in `store` database)
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME
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
