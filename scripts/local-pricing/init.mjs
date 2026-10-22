import { assertLocalDatabase, installLocalEnvironment, installLoopbackNetworkGuard } from "./env.mjs";

installLocalEnvironment();
assertLocalDatabase();
installLoopbackNetworkGuard();
await import("../../apps/api/scripts/bootstrapLocalPricingDb.js");
