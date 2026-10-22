// Standalone source reader: never imports application bootstraps or API clients.
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

const env = dotenv.parse(await fs.readFile(new URL("../../../.env", import.meta.url)));
const out = process.argv.find(arg => arg.startsWith("--out="))?.slice(6);
const inspect = process.argv.includes("--inspect");
const canonicalize = process.argv.includes("--canonicalize-schema");
if (!inspect && !out) throw new Error("Use --inspect or --out=/absolute/private/snapshot-directory.");
const config = { host: env.STORE_DB_HOST, port: Number(env.STORE_DB_PORT || 3306),
  user: env.STORE_DB_USER, password: env.STORE_DB_PASSWORD, database: env.STORE_DB_DATABASE,
  multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  jsonStrings: true };
if (!config.host || !config.user || !config.database || config.database.startsWith("csa_pricing_local")) {
  throw new Error("The source must be the production database configured in .env.");
}
const source = await mysql.createConnection(config);
try {
  await source.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await source.query("SET SESSION TRANSACTION READ ONLY");
  await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const [tables] = await source.query(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
    TABLE_ROWS AS estimatedRows, DATA_LENGTH AS bytes FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`);
  const [objects] = await source.query(`SELECT 'trigger' AS kind, TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
    UNION ALL SELECT ROUTINE_TYPE, ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()
    UNION ALL SELECT 'event', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()`);
  if (canonicalize) {
    const filename = path.join(out, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
    for (const table of manifest.tables) {
      const [ddl] = await source.query(`SHOW CREATE TABLE ${mysql.escapeId(table.name)}`);
      if (ddl[0]["Create Table"] !== table.ddl) throw new Error(`Source schema changed since snapshot: ${table.name}`);
    }
    await source.query("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'");
    for (const table of manifest.tables) {
      const [ddl] = await source.query(`SHOW CREATE TABLE ${mysql.escapeId(table.name)}`);
      table.ddl = ddl[0]["Create Table"];
    }
    await fs.writeFile(filename, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log("Verified original schema and saved canonical MySQL DDL including table options.");
  } else if (inspect) {
    console.log(JSON.stringify({ tables, executableObjects: objects }, null, 2));
  } else {
    await source.query("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'");
    if (objects.length || tables.some(table => table.type !== "BASE TABLE" || table.engine !== "InnoDB")) {
      throw new Error("Source contains views, executable objects, or non-InnoDB tables; review their restore behavior before cloning.");
    }
    await fs.mkdir(out, { recursive: true, mode: 0o700 });
    const manifest = { format: 1, capturedAt: new Date().toISOString(), sourceDatabase: config.database,
      transaction: "REPEATABLE READ, READ ONLY, consistent snapshot", tables: [], complete: false };
    for (const [index, table] of tables.entries()) {
      const identifier = mysql.escapeId(table.name);
      const [ddl] = await source.query(`SHOW CREATE TABLE ${identifier}`);
      const [columns] = await source.query(`SHOW FULL COLUMNS FROM ${identifier}`);
      const writable = columns.filter(column => !/VIRTUAL GENERATED|STORED GENERATED/.test(column.Extra));
      const filename = `${String(index).padStart(4, "0")}.jsonl`;
      const output = createWriteStream(path.join(out, filename), { flags: "wx", mode: 0o600 });
      const hash = crypto.createHash("sha256");
      let count = 0;
      const stream = source.connection.query(`SELECT ${writable.map(column => mysql.escapeId(column.Field)).join(",")} FROM ${identifier}`).stream({ highWaterMark: 64 });
      try {
        for await (const row of stream) {
          const values = writable.map(column => {
            const value = row[column.Field];
            if (Buffer.isBuffer(value)) return { binary: value.toString("base64") };
            return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
          });
          const line = JSON.stringify(values) + "\n";
          hash.update(line);
          if (!output.write(line)) await once(output, "drain");
          count++;
        }
        output.end();
        await finished(output);
      } catch (error) { output.destroy(); throw error; }
      const [after] = await source.query(`SHOW CREATE TABLE ${identifier}`);
      if (after[0]["Create Table"] !== ddl[0]["Create Table"]) throw new Error(`Schema changed during export: ${table.name}`);
      manifest.tables.push({ name: table.name, ddl: ddl[0]["Create Table"],
        columns: writable.map(column => column.Field), filename, rows: count, sha256: hash.digest("hex") });
      console.log(`${index + 1}/${tables.length} ${table.name}: ${count} rows`);
    }
    manifest.complete = true;
    await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Read-only snapshot complete: ${manifest.tables.length} tables, ${manifest.tables.reduce((sum, table) => sum + table.rows, 0)} rows.`);
  }
  await source.query("ROLLBACK");
} finally { await source.end(); }
