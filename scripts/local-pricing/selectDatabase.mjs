import fs from "node:fs/promises";
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard, activeDatabaseFile, selectedLocalDatabase } from "./env.mjs";
const previous = selectedLocalDatabase();
const state = await fs.readFile(activeDatabaseFile, "utf8").then(JSON.parse).catch(error => {
  if (error.code !== "ENOENT") throw error;
  return { database: "csa_pricing_local" };
});
const database = process.argv.includes("--previous") ? state.previousDatabase
  : process.argv.find(arg => arg.startsWith("--database="))?.slice(11);
if (!database) throw new Error("Provide --database=<local-schema> or --previous.");
installLocalEnvironment({ database });
assertLocalDatabase();
installLoopbackNetworkGuard();
const { getPool } = await import("../../apps/api/db.js");
try {
  const [[identity]] = await getPool().query("SELECT DATABASE() AS name, CURRENT_USER() AS account");
  if (identity.name !== database || !identity.account.startsWith("csa_local@")) throw new Error("Unexpected local database identity.");
  await getPool().query("SELECT COUNT(*) FROM products");
  if (database !== "csa_pricing_local") {
    const [[migrated]] = await getPool().query("SELECT COUNT(*) AS total FROM enterprise_pricing_migration_rows");
    if (!Number(migrated.total)) throw new Error("Complete pricing migration before selecting the clone.");
  }
  await fs.mkdir(new URL("../../.local-pricing/", import.meta.url), { recursive: true, mode: 0o700 });
  const temporary = new URL("../../.local-pricing/active.json.tmp", import.meta.url);
  await fs.writeFile(temporary, JSON.stringify({ database, previousDatabase: previous, selectedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  await fs.rename(temporary, activeDatabaseFile);
  console.log(`Local database selected: ${database}. Restart npm run dev to use it. Previous: ${previous}`);
} finally { await getPool().end(); }
