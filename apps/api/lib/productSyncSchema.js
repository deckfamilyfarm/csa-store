import { getPool, ensureScheduledPricelistSchema, ensureSquareSyncSchema } from "../db.js";
let schemaPromise;
export async function ensureProductSyncSchema() {
  if (!schemaPromise) schemaPromise = bootstrap().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
async function bootstrap() {
  await ensureScheduledPricelistSchema();
  await ensureSquareSyncSchema();
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS product_sync_audits (
      id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(24) NOT NULL, options_json LONGTEXT NOT NULL,
      summary_json LONGTEXT, created_by INT, created_at DATETIME NOT NULL, progress_at DATETIME, finished_at DATETIME,
      localline_refreshed_at DATETIME, square_refreshed_at DATETIME, error_message TEXT
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS product_sync_actions (
      id INT AUTO_INCREMENT PRIMARY KEY, audit_id INT NOT NULL, product_id INT NOT NULL,
      product_name VARCHAR(255) NOT NULL, vendor_name VARCHAR(255), platform VARCHAR(24) NOT NULL,
      direction VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL, data_json LONGTEXT NOT NULL,
      result_json LONGTEXT, released_at DATETIME, applied_at DATETIME,
      INDEX audit_actions (audit_id, direction, status), INDEX product_actions (product_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS product_sync_releases (
      id INT AUTO_INCREMENT PRIMARY KEY, audit_id INT NOT NULL, name VARCHAR(255) NOT NULL,
      status VARCHAR(24) NOT NULL, scheduled_at DATETIME NOT NULL, is_scheduled TINYINT NOT NULL DEFAULT 0, created_by INT,
      started_at DATETIME, finished_at DATETIME, created_at DATETIME NOT NULL,
      INDEX due_releases (status, scheduled_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS product_sync_release_products (
      release_id INT NOT NULL, product_id INT NOT NULL, staged_json TEXT NOT NULL,
      original_json TEXT NOT NULL, local_applied_at DATETIME,
      PRIMARY KEY (release_id, product_id)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS product_sync_release_actions (
      id INT AUTO_INCREMENT PRIMARY KEY, release_id INT NOT NULL, action_id INT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending', message TEXT, checkpoint_json LONGTEXT,
      updated_at DATETIME, completed_at DATETIME,
      UNIQUE KEY approved_action (action_id), INDEX release_actions (release_id, status)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS product_sync_image_receipts (
      product_id INT PRIMARY KEY, sources_json LONGTEXT NOT NULL, remote_json LONGTEXT NOT NULL
    ) ENGINE=InnoDB`
  ]) await getPool().query(sql);
}
export const parseJson = (value, fallback = null) => value == null ? fallback : typeof value === "string" ? JSON.parse(value) : value;
export const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
export function isoUtc(value) { return value ? `${String(value).replace(" ", "T")}Z` : null; }
export async function withSyncLock(name, callback) {
  const connection = await getPool().getConnection();
  let acquired = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [name]);
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) throw Object.assign(new Error("Another sync operation is running. Try again shortly."), { status: 409 });
    return await callback(connection);
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK(?)", [name]).catch(() => {});
    connection.release();
  }
}
