import { fileURLToPath } from "url";
import path from "path";
import { getPool } from "../db.js";
import { runDueScheduledPricelistBatches } from "../lib/scheduledPricelistReleases.js";

const __filename = fileURLToPath(import.meta.url);
const LOCK_NAME = "csa-store:scheduled-pricelist-releases";

async function acquireLock() {
  const connection = await getPool().getConnection();
  let released = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [LOCK_NAME]);
    if (Number(rows?.[0]?.acquired || 0) !== 1) {
      connection.release();
      released = true;
      return null;
    }
    return connection;
  } catch (error) {
    if (!released) {
      connection.release();
    }
    throw error;
  }
}

async function releaseLock(connection) {
  if (!connection) return;
  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
  } finally {
    connection.release();
  }
}

async function main() {
  const lockConnection = await acquireLock();
  if (!lockConnection) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "Another scheduled release run is active." }));
    return;
  }

  try {
    const result = await runDueScheduledPricelistBatches();
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await releaseLock(lockConnection);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main()
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end().catch(() => {});
    });
}
