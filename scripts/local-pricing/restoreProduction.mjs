import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from "./env.mjs";

const snapshotDir = process.argv.find(arg => arg.startsWith("--snapshot="))?.slice(11);
const database = process.argv.find(arg => arg.startsWith("--database="))?.slice(11)
  || `csa_pricing_local_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
if (!snapshotDir) throw new Error("Provide --snapshot=<export-directory>.");
installLocalEnvironment({ database });
assertLocalDatabase();
installLoopbackNetworkGuard();
const { default: mysql } = await import("../../apps/api/node_modules/mysql2/promise.js");
const manifest = JSON.parse(await fs.readFile(path.join(snapshotDir, "manifest.json"), "utf8"));
if (!manifest.complete || manifest.format !== 1) throw new Error("Incomplete or unsupported source snapshot.");
const local = await mysql.createConnection({ host: "127.0.0.1", port: 33077, user: "root",
  password: "csa-local-root-only", multipleStatements: false, dateStrings: true });
const q = mysql.escapeId;
try {
  // A fresh schema is mandatory: restore never drops or overwrites any database.
  await local.query(`CREATE DATABASE ${q(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await local.query(`GRANT ALL PRIVILEGES ON ${q(database)}.* TO 'csa_local'@'%'`);
  await local.query(`USE ${q(database)}`);
  await local.query("SET SESSION FOREIGN_KEY_CHECKS=0");
  await local.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO'");
  for (const table of manifest.tables) {
    if (!table.ddl.startsWith(`CREATE TABLE ${q(table.name)} `) || /REFERENCES\s+`[^`]+`\s*\./i.test(table.ddl)) {
      throw new Error(`Unexpected or cross-database table definition: ${table.name}`);
    }
    await local.query(table.ddl);
  }
  const verified = [];
  for (const table of manifest.tables) {
    if (path.basename(table.filename) !== table.filename) throw new Error("Invalid snapshot filename.");
    const file = path.join(snapshotDir, table.filename);
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== table.sha256) throw new Error(`Snapshot checksum mismatch: ${table.name}`);
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await local.query(`INSERT INTO ${q(table.name)} (${table.columns.map(q).join(",")}) VALUES ?`, [batch]);
      batch = []; bytes = 0;
    };
    await local.beginTransaction();
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      batch.push(JSON.parse(line).map(value => value && typeof value === "object" && Object.hasOwn(value, "binary")
        ? Buffer.from(value.binary, "base64") : value));
      bytes += Buffer.byteLength(line);
      if (batch.length >= 200 || bytes >= 1000000) await flush();
    }
    await flush();
    const [[count]] = await local.query(`SELECT COUNT(*) AS total FROM ${q(table.name)}`);
    if (Number(count.total) !== table.rows) throw new Error(`Row count mismatch: ${table.name}: ${count.total} restored, ${table.rows} expected`);
    await local.commit();
    verified.push({ table: table.name, rows: Number(count.total) });
    console.log(`Restored ${table.name}: ${count.total}`);
  }
  await local.query("SET SESSION FOREIGN_KEY_CHECKS=1");
  // Imported foreign keys must also hold, including relationships that were
  // temporarily unchecked to allow tables to be loaded in any order.
  const [keys] = await local.query(`SELECT TABLE_NAME AS child, CONSTRAINT_NAME AS constraintName,
    COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS parent, REFERENCED_COLUMN_NAME AS parentCol
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`);
  const groups = Map.groupBy(keys, row => `${row.child}:${row.constraintName}`);
  for (const rows of groups.values()) {
    const first = rows[0];
    const [[result]] = await local.query(`SELECT COUNT(*) AS total FROM ${q(first.child)} child
      WHERE ${rows.map(row => `child.${q(row.col)} IS NOT NULL`).join(" AND ")}
      AND NOT EXISTS (SELECT 1 FROM ${q(first.parent)} parent WHERE ${rows.map(row => `parent.${q(row.parentCol)}=child.${q(row.col)}`).join(" AND ")})`);
    if (Number(result.total)) throw new Error(`Foreign key verification failed: ${first.child}.${first.constraintName}`);
  }
  await fs.writeFile(path.join(snapshotDir, `restore-${database}.json`), JSON.stringify({ database,
    restoredAt: new Date().toISOString(), capturedAt: manifest.capturedAt, verified, foreignKeysVerified: groups.size }, null, 2), { mode: 0o600 });
  console.log(`Verified local database: ${database}. It is not selected until pricing migration completes.`);
} finally { await local.end(); }
