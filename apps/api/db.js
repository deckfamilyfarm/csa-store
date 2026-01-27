import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { relations } from "drizzle-orm";
import * as schema from "./schema.js";

let db;

export function initDb() {
  if (db) return db;

  const pool = mysql.createPool({
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

export function getDb() {
  return db ?? initDb();
}

export { schema, relations };
