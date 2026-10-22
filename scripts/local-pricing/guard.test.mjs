import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { assertLocalDatabase, installLocalEnvironment, installLoopbackNetworkGuard } from "./env.mjs";

test("versioned local clones are allowed, arbitrary databases are refused", () => {
  installLocalEnvironment({ database: "csa_pricing_local_20261021000300" });
  assertLocalDatabase();
  assert.throws(() => installLocalEnvironment({ database: "store" }), /Invalid local database/);
  assert.throws(() => installLocalEnvironment({ database: "csa_pricing_local_other" }), /Invalid local database/);
});

test("local pricing mode strips inherited credentials and rejects remote connections", () => {
  process.env.STORE_DB_HOST = "production.example.invalid";
  process.env.SQUARE_ACCESS_TOKEN = "sensitive-test-value";
  process.env.LL_PASSWORD = "sensitive-test-value";
  installLocalEnvironment();
  assertLocalDatabase();
  assert.equal(process.env.STORE_DB_HOST, "127.0.0.1");
  assert.equal(process.env.SQUARE_ACCESS_TOKEN, "");
  assert.equal(process.env.LL_PASSWORD, "");

  installLoopbackNetworkGuard();
  assert.throws(() => fetch("https://connect.squareup.com/v2/catalog/list"), /blocked outbound request/);
  assert.throws(() => fetch("https://localline.ca/api/backoffice/v2/products/"), /blocked outbound request/);
  assert.throws(() => net.connect({ host: "connect.squareup.com", port: 443 }), /blocked outbound connection/);

  process.env.STORE_DB_HOST = "production.example.invalid";
  assert.throws(assertLocalDatabase, /dedicated localhost MySQL/);
});
