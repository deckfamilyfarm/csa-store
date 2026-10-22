import { assertLocalDatabase, installLocalEnvironment, installLoopbackNetworkGuard } from "./env.mjs";

installLocalEnvironment();
assertLocalDatabase();
installLoopbackNetworkGuard();
// Price-list IDs are catalog configuration, loaded only from the isolated clone.
const { getPool } = await import("../../apps/api/db.js");
try {
  const [lists] = await getPool().query("SELECT name,local_line_price_list_id AS id FROM price_lists");
  const keys = { "Guest Basket": "LL_PRICE_LIST_GUEST_ID", "CSA Members": "LL_PRICE_LIST_CSA_MEMBERS_ID",
    "Herd Share Members": "LL_PRICE_LIST_HERDSHARE_ID", SNAP: "LL_PRICE_LIST_SNAP_ID" };
  for (const row of lists) if (keys[row.name] && Number(row.id) > 0) process.env[keys[row.name]] = String(row.id);
} catch (error) { if (error.code !== "ER_NO_SUCH_TABLE") throw error; }
await import("../../apps/api/index.js");
