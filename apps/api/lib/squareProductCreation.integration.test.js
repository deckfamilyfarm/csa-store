import { test } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../schema.js";

// Disposable MySQL only; no .env, real credentials, or external platform requests.
const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test("Square creation previews, explicit approval, durable recovery, and guarded linking", { skip: !socket }, async t => {
  assert.match(socket, /^\/(private\/)?tmp\/csa-product-sync-/);
  const database = `csa_square_create_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: "root" });
  await root.query(`CREATE DATABASE \`${database}\``);
  Object.assign(process.env, { STORE_DB_HOST: "127.0.0.1", STORE_DB_PORT: "1", STORE_DB_DATABASE: database,
    STORE_DB_USER: "root", STORE_DB_PASSWORD: "", SQUARE_BASE_URL: "https://square.test",
    SQUARE_ACCESS_TOKEN: "test", SQUARE_ENVIRONMENT: "sandbox", SQUARE_CURRENCY: "USD", SQUARE_LOCATION_ID: "" });
  const { getPool } = await import("../db.js");
  const pool = getPool(); pool.pool.config.connectionConfig.socketPath = socket;
  t.after(async () => { await pool.end(); await root.query(`DROP DATABASE \`${database}\``); await root.end(); });
  for (const table of [schema.products, schema.packages, schema.vendors, schema.categories, schema.productPricingProfiles, schema.productSales]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(col => `\`${col.name}\` ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${col.autoIncrement ? " AUTO_INCREMENT" : ""}${col.primary ? " PRIMARY KEY" : ""}${col.default !== undefined && (typeof col.default !== "object" || col.default === null) ? ` DEFAULT ${pool.escape(col.default)}` : ""}`);
    for (const index of config.indexes.filter(index => index.config.unique)) columns.push(`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map(col => `\`${col.name}\``).join(",")})`);
    await pool.query(`CREATE TABLE \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`);
  }
  await pool.query("INSERT INTO categories (id,name) VALUES (1,'Meat'),(2,'Membership')");
  await pool.query("INSERT INTO vendors (id,name) VALUES (1,'Hyland')");
  const { previewSquareProductCreation: preview, applySquareProductCreation: apply } = await import("./squareProductCreation.js");
  const receipts = new Map(), objects = new Map(), requests = [];
  let loseResponse = false, failRead = false, rejectNext = false, pauseCreate = null;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url); assert.equal(parsed.hostname, "square.test");
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path: parsed.pathname, method: options.method || "GET", body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (parsed.pathname === "/v2/catalog/list") return json({ objects: [...objects.values()] });
    if (parsed.pathname === "/v2/catalog/object") {
      if (rejectNext) { rejectNext = false; return json({ errors: [{ detail: "Unauthorized" }] }, 401); }
      if (pauseCreate) { pauseCreate.entered(); await pauseCreate.wait; }
      let receipt = receipts.get(body.idempotency_key);
      if (!receipt) {
        const item = structuredClone(body.object), mappings = [];
        const convert = obj => { const id = `square-${obj.id.slice(1)}`; mappings.push({ client_object_id: obj.id, object_id: id }); obj.id = id; obj.version = 1; };
        convert(item); item.item_data.variations.forEach(row => { convert(row); row.item_variation_data.item_id = item.id; });
        receipt = { catalog_object: item, id_mappings: mappings };
        receipts.set(body.idempotency_key, receipt); objects.set(item.id, item);
      }
      if (loseResponse) { loseResponse = false; throw new Error("Connection lost after Square creation"); }
      return json(receipt);
    }
    if (parsed.pathname.startsWith("/v2/catalog/object/")) {
      if (failRead) { failRead = false; throw new Error("Confirmation unavailable"); }
      return json({ object: objects.get(parsed.pathname.split("/").pop()) });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  async function product(id) {
    await pool.query("INSERT INTO products (id,name,vendor_id,category_id,is_deleted) VALUES (?,?,1,1,0)", [id, `Product ${id}`]);
    await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items) VALUES (?,?,'Small',50,'ea',1),(?,?,'Large',100,'ea',2)", [id * 10, id, id * 10 + 1, id]);
    await pool.query("INSERT INTO product_pricing_profiles (product_id,source_unit_price,unit_of_measure,source_multiplier) VALUES (?,10,'each',0.54)", [id]);
  }
  const writes = () => requests.filter(row => row.method === "POST");
  async function links(id) { return (await pool.query("SELECT * FROM square_variation_links WHERE product_id=?", [id]))[0]; }

  await t.test("preview does not publish; approve creates and confirms all packages once", async () => {
    await product(1); const draft = await preview(1, 7);
    assert.equal(writes().length, 0); assert.equal(draft.variations[0].amount, 1000);
    assert.equal((await preview(1, 8)).id, draft.id);
    const done = await apply(draft.id, 7);
    assert.equal(done.status, "completed"); assert.equal((await links(1)).length, 2);
    assert.equal(writes().length, 1); await apply(draft.id, 7); assert.equal(writes().length, 1);
    await pool.query("DELETE FROM square_variation_links WHERE product_id=1");
    assert.equal((await preview(1, 7)).status, "completed"); assert.equal(writes().length, 1);
  });
  await t.test("lost responses resume frozen request across previews, drift, and rejected retries", async () => {
    await product(2); const draft = await preview(2, 7); loseResponse = true;
    await assert.rejects(apply(draft.id, 7), /Connection lost/);
    await pool.query("UPDATE product_pricing_profiles SET source_unit_price=99 WHERE product_id=2");
    assert.equal((await preview(2, 8)).id, draft.id);
    rejectNext = true; await assert.rejects(apply(draft.id, 7), /Unauthorized/);
    assert.equal((await preview(2, 8)).id, draft.id);
    const done = await apply(draft.id, 7); assert.equal(done.variations[0].amount, 1000);
    const attempts = writes().filter(row => row.body.idempotency_key === draft.id);
    assert.equal(attempts.length, 3); assert.deepEqual(attempts[0].body, attempts[2].body);
    assert.equal((await links(2)).length, 2);
  });
  await t.test("confirmation failure checkpoints receipt and retries reads without another create", async () => {
    await product(3); const draft = await preview(3, 7); failRead = true;
    await assert.rejects(apply(draft.id, 7), /Confirmation unavailable/);
    assert.equal((await preview(3, 7)).status, "created");
    const count = writes().length; await apply(draft.id, 7); assert.equal(writes().length, count);
  });
  await t.test("drift, duplicates, and stale preview IDs block creation", async () => {
    await product(4); const draft = await preview(4, 7);
    await pool.query("UPDATE product_pricing_profiles SET source_unit_price=12 WHERE product_id=4");
    const count = writes().length; await assert.rejects(apply(draft.id, 7), /changed/); assert.equal(writes().length, count);
    const revised = await preview(4, 7); assert.notEqual(revised.id, draft.id);
    await assert.rejects(apply(draft.id, 7), /expired/);
    objects.set("duplicate", { type: "ITEM", id: "duplicate", item_data: { name: "Product 4" } });
    await assert.rejects(apply(revised.id, 7), /already contains/); assert.equal(writes().length, count);
    await product(5); await pool.query("UPDATE packages SET package_code='DUP' WHERE product_id=5");
    objects.set("sku-duplicate", { type: "ITEM", id: "sku-duplicate", item_data: { name: "Another name", variations: [{ item_variation_data: { sku: "DUP" } }] } });
    await assert.rejects(preview(5, 7), /already contains/);
  });
  await t.test("concurrent approvals use one creation lock", async () => {
    await product(6); const draft = await preview(6, 7);
    await product(11); await pool.query("UPDATE products SET name='Product 6' WHERE id=11");
    const duplicateDraft = await preview(11, 7);
    let entered, release; const ready = new Promise(resolve => { entered = resolve; });
    pauseCreate = { entered, wait: new Promise(resolve => { release = resolve; }) };
    const first = apply(draft.id, 7); await ready;
    await assert.rejects(apply(draft.id, 7), /Another sync operation/);
    await assert.rejects(apply(duplicateDraft.id, 7), /Another sync operation/);
    release(); await first; pauseCreate = null;
    await assert.rejects(apply(duplicateDraft.id, 7), /already contains/);
    assert.equal(writes().filter(row => row.body.idempotency_key === draft.id).length, 1);
  });
  await t.test("changed target and conflicting package links never create again or overwrite links", async () => {
    await product(7); const draft = await preview(7, 7); loseResponse = true;
    await assert.rejects(apply(draft.id, 7)); const count = writes().length;
    process.env.SQUARE_ACCESS_TOKEN = "other-account";
    await assert.rejects(apply(draft.id, 7), /connection settings changed/); assert.equal(writes().length, count);
    process.env.SQUARE_ACCESS_TOKEN = "test";
    await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at,created_at,updated_at) VALUES (7,70,'other','other',NOW(),NOW(),NOW())");
    await assert.rejects(apply(draft.id, 7), /links changed/);
    assert.equal((await links(7))[0].square_variation_id, "other");
    const after = writes().length; await assert.rejects(apply(draft.id, 7), /links changed/); assert.equal(writes().length, after);
  });
  await t.test("known initial rejections can be reviewed again; existing links and ineligible products block previews", async () => {
    await product(8); const draft = await preview(8, 7); rejectNext = true;
    await assert.rejects(apply(draft.id, 7), /Unauthorized/);
    const revised = await preview(8, 7); assert.notEqual(revised.id, draft.id);
    await apply(revised.id, 7);
    await product(9);
    await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at,created_at,updated_at) VALUES (9,90,'existing','existing',NOW(),NOW(),NOW())");
    await assert.rejects(preview(9, 7), /already has a Square link/);
    await product(10); await pool.query("UPDATE products SET category_id=2 WHERE id=10");
    await assert.rejects(preview(10, 7), /not eligible/);
  });
  await t.test("both preview and create routes enforce both Square grants", async () => {
    const { default: router } = await import("../routes/admin.js");
    for (const path of ["/square/products/preview", "/square/products/:id/create"]) {
      const handlers = router.stack.find(layer => layer.route?.path === path).route.stack.map(layer => layer.handle);
      for (const roles of [[], ["square_pull"], ["square_push"], ["pricing_admin"], ["square_pull", "square_push"], ["admin"]]) {
        let status = 200, reachedHandler = false;
        const req = { admin: { adminRoles: roles } };
        const res = { status(code) { status = code; return this; }, json() {} };
        await handlers[0](req, res, () => handlers[1](req, res, () => { reachedHandler = true; }));
        const allowed = roles.includes("admin") || (roles.includes("square_pull") && roles.includes("square_push"));
        assert.equal(reachedHandler, allowed, `${path}: ${roles}`);
        assert.equal(status, allowed ? 200 : 403);
      }
    }
  });
});
