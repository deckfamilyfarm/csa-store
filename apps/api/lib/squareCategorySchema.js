import { getPool } from '../db.js';

export const squareCategoryTables = ['square_category_registry', 'square_category_crosswalk'];
export async function squareCategoryPreflight(connection = getPool()) {
  const [rows] = await connection.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)`, squareCategoryTables);
  return { missing: squareCategoryTables.filter(name => !rows.some(row => row.name === name)) };
}
export async function requireSquareCategorySchema(connection = getPool()) {
  const result = await squareCategoryPreflight(connection);
  if (result.missing.length) throw Object.assign(new Error('Install Square category mappings with migrate:square-categories -- --check, then --apply.'), { status: 503 });
}
export async function migrateSquareCategorySchema(connection = getPool()) {
  await connection.query(`CREATE TABLE IF NOT EXISTS square_category_registry (
    target_hash CHAR(64) NOT NULL, square_category_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL, raw_json LONGTEXT NOT NULL, updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(target_hash,square_category_id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS square_category_crosswalk (
    target_hash CHAR(64) NOT NULL, scope VARCHAR(16) NOT NULL, source_id VARCHAR(255) NOT NULL,
    assignment_json LONGTEXT NOT NULL, evidence_json LONGTEXT NOT NULL,
    updated_by INT, updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(target_hash,scope,source_id)
  ) ENGINE=InnoDB`);
  return squareCategoryPreflight(connection);
}
