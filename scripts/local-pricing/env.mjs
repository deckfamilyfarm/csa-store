import net from "node:net";
import fs from "node:fs";
import { isLocalPricingDatabaseName } from "../../apps/api/lib/localPricingDatabase.js";

export const activeDatabaseFile = new URL("../../.local-pricing/active.json", import.meta.url);
export function selectedLocalDatabase() {
  if (!fs.existsSync(activeDatabaseFile)) return "csa_pricing_local";
  const name = JSON.parse(fs.readFileSync(activeDatabaseFile, "utf8")).database;
  if (!isLocalPricingDatabaseName(name)) throw new Error("Invalid local database selection.");
  return name;
}

const LOCAL_DB = Object.freeze({
  host: "127.0.0.1",
  port: "33077",
  user: "csa_local",
  password: "csa-local-only",
  database: "csa_pricing_local"
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function installLocalEnvironment({ database = selectedLocalDatabase() } = {}) {
  if (!isLocalPricingDatabaseName(database)) throw new Error("Invalid local database selection.");
  // Keep only process basics. In particular, discard NODE_OPTIONS and all
  // inherited database, platform, payment, mail, and cloud credentials.
  const kept = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]])
  );
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, kept, {
    CSA_LOCAL_ONLY: "true",
    NODE_ENV: "development",
    PORT: "5177",
    STORE_DB_HOST: LOCAL_DB.host,
    STORE_DB_PORT: LOCAL_DB.port,
    STORE_DB_USER: LOCAL_DB.user,
    STORE_DB_PASSWORD: LOCAL_DB.password,
    STORE_DB_DATABASE: database,
    CSA_ADMIN_AUTH_MODE: "local",
    AUTO_SEED_ADMIN: "true",
    ADMIN_USER: "local.admin",
    ADMIN_EMAIL: "local-admin@example.invalid",
    ADMIN_NAME: "Local Pricing Admin",
    ADMIN_PASS: "local-pricing-admin",
    JWT_SECRET: "local-pricing-only-secret",
    LL_BASEURL: "http://127.0.0.1:9/api/backoffice/v2/",
    LL_USERNAME: "",
    LL_PASSWORD: "",
    LOCALLINE_TEST: "true",
    LOCALLINE_UPDATE_PRICES: "false",
    SQUARE_BASE_URL: "http://127.0.0.1:9",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "",
    STOREFRONT_CHECKOUT_ENABLED: "false"
  });
}

export function assertLocalDatabase() {
  const actual = {
    host: process.env.STORE_DB_HOST,
    port: process.env.STORE_DB_PORT,
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE
  };
  if (process.env.CSA_LOCAL_ONLY !== "true" ||
      !isLocalPricingDatabaseName(actual.database) ||
      Object.keys(LOCAL_DB).filter(key => key !== "database").some(key => actual[key] !== LOCAL_DB[key])) {
    throw new Error("Local pricing mode requires the dedicated localhost MySQL database and credentials.");
  }
}

export function installLoopbackNetworkGuard() {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof first === "object" && first !== null
      ? first.host || first.hostname || (first.path ? "localhost" : "localhost")
      : typeof first === "number" && typeof args[1] === "string"
        ? args[1]
        : "localhost";
    if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) {
      throw new Error(`Local pricing mode blocked outbound connection to ${host}`);
    }
    return originalConnect.apply(this, args);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (resource, options) {
    const target = resource instanceof URL ? resource : new URL(typeof resource === "string" ? resource : resource.url);
    if (!LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
      throw new Error(`Local pricing mode blocked outbound request to ${target.hostname}`);
    }
    return originalFetch(resource, options);
  };
}
