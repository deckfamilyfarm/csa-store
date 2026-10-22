import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { once } from "node:events";
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from "./env.mjs";
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
installLocalEnvironment(arg("database") ? { database: arg("database") } : {});
assertLocalDatabase();
installLoopbackNetworkGuard();
const { default: express } = await import("../../apps/api/node_modules/express/index.js");
const { getPool } = await import("../../apps/api/db.js");
const { readMigrationCatalog, migrationFingerprint } = await import("../../apps/api/lib/enterprisePricingMigration.js");
const { default: mysql } = await import("../../apps/api/node_modules/mysql2/promise.js");
const db = await mysql.createConnection({ host: "127.0.0.1", port: 33077, user: "csa_local", password: "csa-local-only",
  database: process.env.STORE_DB_DATABASE, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true });
let server;
try {
  const plan = JSON.parse(await fs.readFile(arg("plan") || ".local-pricing/production-pricing-migration.json", "utf8"));
  const current = new Map((await readMigrationCatalog(db)).map(row => [Number(row.product.id), row]));
  assert.equal(current.size, plan.rows.length);
  for (const row of plan.rows) assert.equal(migrationFingerprint(current.get(row.productId)), row.fingerprint, `Legacy source changed: ${row.productId}`);
  const [[publications]] = await db.query("SELECT COUNT(*) AS total FROM enterprise_pricing_publications");
  assert.equal(Number(publications.total), 0, "Migration must not create publication actions or verified receipts");
  const [revisions] = await db.query("SELECT output_json FROM enterprise_pricing_revisions");
  assert.equal(revisions.length, plan.summary.ready);
  for (const revision of revisions) for (const pkg of JSON.parse(revision.output_json).packages) {
    assert.equal(new Set(Object.values(pkg.localLineBasketCents)).size, 1);
  }
  const [lists] = await db.query("SELECT name,local_line_price_list_id AS id FROM price_lists");
  const keys = { "Guest Basket": "LL_PRICE_LIST_GUEST_ID", "CSA Members": "LL_PRICE_LIST_CSA_MEMBERS_ID", "Herd Share Members": "LL_PRICE_LIST_HERDSHARE_ID", SNAP: "LL_PRICE_LIST_SNAP_ID" };
  for (const list of lists) if (keys[list.name]) process.env[keys[list.name]] = String(list.id);
  const app = express();
  app.use(express.json());
  app.use("/api/admin", (await import("../../apps/api/routes/admin.js")).default);
  app.use("/api", (await import("../../apps/api/routes/catalog.js")).default);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "local.admin", password: "local-pricing-admin" }) });
  assert.equal(login.status, 200, "Local login");
  const auth = await login.json();
  assert(auth.token);
  const get = async route => {
    const response = await fetch(`${base}/${route}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    const body = await response.json();
    assert.equal(response.status, 200, `${route}: ${body.error || body.message || "request failed"}`);
    return body;
  };
  const pricing = await get("admin/enterprise-pricing/products?limit=100");
  assert.equal(pricing.total, plan.rows.filter(row => String(row.source.product.categoryName).toLowerCase() !== "membership").length);
  const example = plan.rows.find(row => row.action === "ready" && row.input.pricingUnit === "lb")
    || plan.rows.find(row => row.action === "ready");
  assert(example, "At least one valid migration example");
  const detail = await get(`admin/enterprise-pricing/products/${example.productId}`);
  assert.equal(detail.buyPrice.cents, example.buyPrice.cents);
  assert.deepEqual(detail.latest.output, example.output);
  const comparison = await get("admin/enterprise-pricing/migration-report?limit=1000");
  assert(comparison.length >= plan.rows.length);
  await get("admin/pricelist?limit=30");
  const catalog = await get("catalog");
  assert(catalog.products.length > 0);
  const [active] = await db.query(`SELECT s.product_id,r.output_json FROM enterprise_pricing_product_state s
    JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id JOIN products p ON p.id=s.product_id
    WHERE p.visible=1 AND r.status='local-preview'`);
  let verifiedCatalog = 0;
  for (const row of active) {
    const product = catalog.products.find(product => Number(product.id) === Number(row.product_id));
    if (!product) continue;
    const output = JSON.parse(row.output_json);
    assert.equal(product.guestPrice, Math.min(...output.packages.map(pkg => pkg.localLineSaleCents)) / 100);
    verifiedCatalog++;
  }
  assert(verifiedCatalog > 0);
  console.log(`Verified ${current.size} unchanged source products, ${revisions.length} new pricing proposals, local login, Pricing, migration comparison, inventory read, and ${verifiedCatalog} storefront prices. No remote calls.`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end();
  await getPool().end();
}
