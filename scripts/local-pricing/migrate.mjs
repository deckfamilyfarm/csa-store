import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from "./env.mjs";
const database = process.argv.find(arg => arg.startsWith("--database="))?.slice(11);
installLocalEnvironment(database ? { database } : {});
assertLocalDatabase();
installLoopbackNetworkGuard();
await import("../../apps/api/scripts/migrateEnterprisePricing.js");
