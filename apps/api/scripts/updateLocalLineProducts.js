import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { updateLocalLineForProduct } from "../localLine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(`--${flag}`);
const getArg = (name) => {
  const prefix = `--${name}=`;
  const arg = args.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
};

const isTesting = hasFlag("test") || process.env.LOCALLINE_TEST === "true";
const isLive = hasFlag("live") || process.env.LOCALLINE_LIVE === "true";
const idsArg = getArg("ids");
const sinceArg = getArg("since");
const limitArg = Number(getArg("limit") || 50);

if (isLive) {
  process.env.LOCALLINE_TEST = "false";
} else if (isTesting) {
  process.env.LOCALLINE_TEST = "true";
}

async function fetchProducts(conn) {
  if (idsArg) {
    const ids = idsArg
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
    if (!ids.length) return [];
    const [rows] = await conn.query(
      "SELECT id, name, updated_at AS updatedAt FROM products WHERE id IN (?)",
      [ids]
    );
    return rows;
  }

  if (sinceArg) {
    const [rows] = await conn.query(
      "SELECT id, name, updated_at AS updatedAt FROM products WHERE updated_at >= ? ORDER BY updated_at ASC",
      [sinceArg]
    );
    return rows;
  }

  const limit = Number.isFinite(limitArg) ? limitArg : 50;
  const [rows] = await conn.query(
    "SELECT id, name, updated_at AS updatedAt FROM products WHERE updated_at IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
    [limit]
  );
  return rows;
}

async function run() {
  if (!isTesting && !isLive) {
    console.log("Defaulting to TEST mode. Use --live to send updates.");
  }

  const pool = mysql.createPool({
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store"
  });
  const db = drizzle(pool);

  try {
    const products = await fetchProducts(pool);
    console.log(`Found ${products.length} products to evaluate.`);

    for (const product of products) {
      try {
        const result = await updateLocalLineForProduct(db, product.id, {});
        if (result.inventoryOk === null && result.priceOk === null) {
          console.log(`[TEST] Evaluated LocalLine update for product ${product.id}.`);
        } else if (result.inventoryOk === false || result.priceOk === false) {
          console.log(`LocalLine update failed for product ${product.id}.`);
        } else {
          console.log(`Updated LocalLine for product ${product.id}.`);
        }
      } catch (err) {
        console.error(`Failed LocalLine update for product ${product.id}: ${err.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
