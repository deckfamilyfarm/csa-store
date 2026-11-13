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
  const { previewSquareProductCreation: preview, applySquareProductCreation: apply, getSquareProductCreation } = await import("./squareProductCreation.js");
  const receipts = new Map(), objects = new Map(), requests = [];
  const {migrateSquareCategorySchema} = await import('./squareCategorySchema.js');
  const {squareCategoryTarget,getSquareCategorySetup,saveSquareProductCategory,refreshSquareCategoryRegistry,importSquareCategoryCrosswalk} = await import('./squareCategoryCrosswalk.js');
  await migrateSquareCategorySchema(pool);
  const category={id:'MEAT-CATEGORY',type:'CATEGORY',version:1,category_data:{name:'Meat',category_type:'REGULAR_CATEGORY'}};
  objects.set(category.id,category);
  const categoryTarget=squareCategoryTarget();
  await pool.query('INSERT INTO square_category_registry(target_hash,square_category_id,name,raw_json,updated_at) VALUES (?,?,?,?,NOW())',
    [categoryTarget,category.id,'Meat',JSON.stringify(category)]);
  await pool.query("INSERT INTO square_category_crosswalk(target_hash,scope,source_id,assignment_json,evidence_json,updated_at) VALUES (?,'category','1',?,'{}',NOW())",
    [categoryTarget,JSON.stringify({categoryIds:[category.id],reportingCategoryId:category.id})]);
  let loseResponse = false, failRead = false, rejectNext = false, pauseCreate = null;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url); assert.equal(parsed.hostname, "square.test");
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path: parsed.pathname, method: options.method || "GET", body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (parsed.pathname === "/v2/catalog/list") return json({ objects: [...objects.values()].filter(object => object.type === parsed.searchParams.get('types')) });
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
      if (failRead && !objects.get(parsed.pathname.split('/').pop())?.category_data) { failRead = false; throw new Error("Confirmation unavailable"); }
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
    assert.deepEqual(draft.squareCategory.categoryIds,[category.id]);
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
    const readsBefore = requests.length;
    assert.equal((await getSquareProductCreation(2)).id, draft.id);
    assert.equal((await getSquareProductCreation(2)).status, 'sending');
    assert.equal(requests.length, readsBefore, 'Reading a creation receipt must not call Square.');
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
  await t.test('per-pound creation freezes and confirms its unit, including after lost responses', async () => {
    const pound = { id: 'LB', type: 'MEASUREMENT_UNIT', measurement_unit_data: { measurement_unit: { type: 'TYPE_WEIGHT', weight_unit: 'IMPERIAL_POUND' }, precision: 3 } };
    objects.set('LB', pound);
    await product(12);
    await pool.query("UPDATE product_pricing_profiles SET unit_of_measure='lbs' WHERE product_id=12");
    const draft = await preview(12, 7);
    assert.equal(draft.variations[0].sellingUnit.id, 'LB');
    loseResponse = true;
    await assert.rejects(apply(draft.id, 7), /Connection lost/);
    await pool.query("UPDATE product_pricing_profiles SET unit_of_measure='each' WHERE product_id=12");
    const done = await apply(draft.id, 7);
    assert.equal(done.status, 'completed');
    const attempts = writes().filter(row => row.body.idempotency_key === draft.id);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
    assert.equal(attempts[0].body.object.item_data.variations[0].item_variation_data.measurement_unit_id, 'LB');
    await product(13);
    await pool.query("UPDATE product_pricing_profiles SET unit_of_measure='lbs' WHERE product_id=13");
    const stale = await preview(13, 7);
    const count = writes().length;
    pound.measurement_unit_data.precision = 1;
    await assert.rejects(apply(stale.id, 7), /changed/);
    assert.equal(writes().length, count);
  });
  await t.test('enterprise creation routes use approved revision rates and units, hold drift, and recover frozen requests', async () => {
    const { default: router } = await import('../routes/admin.js');
    async function route(path, { body = {}, params = {} } = {}) {
      const handler = router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
      let status = 200, result;
      await handler({ body, params, admin: { userId: 7, adminRoles: ['admin'] } }, {
        status(code) { status = code; return this; }, json(value) { result = value; }
      });
      return { status, result };
    }
    await product(14);
    // Deliberately stale legacy price, unit and sale must not set creation prices.
    await pool.query("UPDATE product_pricing_profiles SET source_unit_price=99,unit_of_measure='each',on_sale=1,sale_discount=.5 WHERE product_id=14");
    const input = { squareEnabled: true, pricingUnit: 'lb' };
    const output = { saleBp: 0, packages: [140,141].map(packageId => ({ packageId, squareVariationCents: 1200 })) };
    const [insert] = await pool.query(`INSERT INTO enterprise_pricing_revisions(product_id,settings_version_id,status,input_json,output_json,editor_id,created_at)
      VALUES(14,1,'partial',?,?,7,UTC_TIMESTAMP())`, [JSON.stringify(input), JSON.stringify(output)]);
    const revisionId = insert.insertId;
    await pool.query('INSERT INTO enterprise_pricing_product_state(product_id,latest_revision_id,active_revision_id,updated_at) VALUES(14,?,?,UTC_TIMESTAMP())', [revisionId, revisionId]);
    const draft = await route('/square/products/preview', { body: { productId: 14 } });
    assert.equal(draft.status, 200);
    assert.equal(draft.result.enterpriseRevisionId, revisionId);
    assert.ok(draft.result.variations.every(row => row.amount === 1200 && row.sellingUnit.id === 'LB'));
    const count = writes().length;
    await pool.query("UPDATE enterprise_pricing_revisions SET status='pending' WHERE id=?", [revisionId]);
    const held = await route('/square/products/:id/create', { params: { id: draft.result.id } });
    assert.equal(held.status, 409);
    assert.match(held.result.error, /approve the current enterprise/);
    assert.equal(writes().length, count);
    await pool.query("UPDATE enterprise_pricing_revisions SET status='partial' WHERE id=?", [revisionId]);
    // A different revision with identical prices must still invalidate approval.
    const [newRevision] = await pool.query(`INSERT INTO enterprise_pricing_revisions(product_id,settings_version_id,status,input_json,output_json,editor_id,created_at)
      VALUES(14,1,'approved',?,?,7,UTC_TIMESTAMP())`, [JSON.stringify(input), JSON.stringify(output)]);
    await pool.query('UPDATE enterprise_pricing_product_state SET latest_revision_id=?,active_revision_id=? WHERE product_id=14', [newRevision.insertId, newRevision.insertId]);
    assert.equal((await route('/square/products/:id/create', { params: { id: draft.result.id } })).status, 409);
    assert.equal(writes().length, count);
    const refreshed = await route('/square/products/preview', { body: { productId: 14 } });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.result.id, draft.result.id);
    loseResponse = true;
    const lost = await route('/square/products/:id/create', { params: { id: refreshed.result.id } });
    assert.equal(lost.status, 400);
    await pool.query("UPDATE enterprise_pricing_revisions SET status='pending' WHERE id=?", [newRevision.insertId]);
    const resumed = await route('/square/products/preview', { body: { productId: 14 } });
    assert.equal(resumed.result.id, refreshed.result.id);
    const done = await route('/square/products/:id/create', { params: { id: resumed.result.id } });
    assert.equal(done.status, 200);
    assert.equal(done.result.status, 'completed');
    assert.equal((await links(14)).length, 2);
    const attempts = writes().filter(row => row.body.idempotency_key === resumed.result.id);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    assert.equal(attempts[0].body.object.item_data.variations[0].item_variation_data.price_money.amount, 1200);
    assert.equal(attempts[0].body.object.item_data.variations[0].item_variation_data.measurement_unit_id, 'LB');
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
  await t.test('category mappings require review, freeze at creation, reject stale edits and survive lost responses', async () => {
    await product(31);
    const alternate={id:'OTHER-CATEGORY',type:'CATEGORY',version:1,category_data:{name:'Variety & Other',category_type:'REGULAR_CATEGORY'}};
    objects.set(alternate.id,alternate);
    await pool.query('INSERT INTO square_category_registry(target_hash,square_category_id,name,raw_json,updated_at) VALUES (?,?,?,?,NOW())',
      [categoryTarget,alternate.id,alternate.category_data.name,JSON.stringify(alternate)]);
    const initial=await getSquareCategorySetup(31);
    assert.equal(initial.source,'category');
    const count=writes().length;
    const explicit=await saveSquareProductCategory(31,{categoryId:alternate.id,expectedRevision:initial.revision},7);
    assert.equal(explicit.source,'product');assert.deepEqual(explicit.assignment.categoryIds,[alternate.id]);
    assert.equal(writes().length,count,'Saving local mapping must never publish.');
    await assert.rejects(saveSquareProductCategory(31,{categoryId:category.id,expectedRevision:initial.revision},7),/changed/);
    const draft=await preview(31,7);
    await saveSquareProductCategory(31,{categoryId:category.id,expectedRevision:explicit.revision},7);
    await assert.rejects(apply(draft.id,7),/changed/);
    const revised=await preview(31,7); loseResponse=true;
    await assert.rejects(apply(revised.id,7),/Connection lost/);
    const saved=await getSquareCategorySetup(31);
    await saveSquareProductCategory(31,{categoryId:alternate.id,expectedRevision:saved.revision},7);
    await apply(revised.id,7);
    const attempts=writes().filter(row=>row.body.idempotency_key===revised.id);
    assert.equal(attempts.length,2); assert.deepEqual(attempts[0].body,attempts[1].body);
    assert.deepEqual(attempts[0].body.object.item_data.categories,[{id:category.id}]);
    await product(32); await pool.query('UPDATE products SET category_id=NULL WHERE id=32');
    await assert.rejects(preview(32,7),/Choose a Square category/);
    const unassigned=await getSquareCategorySetup(32);
    await saveSquareProductCategory(32,{categoryId:alternate.id,expectedRevision:unassigned.revision},7);
    const pending=await preview(32,7);
    alternate.is_deleted=true;
    await assert.rejects(apply(pending.id,7),/changed or was deleted/);
    delete alternate.is_deleted;
    const current=await getSquareCategorySetup(32);
    await saveSquareProductCategory(32,{categoryId:null,expectedRevision:current.revision},7);
    assert.equal((await getSquareCategorySetup(32)).assignment,null);
  });
  await t.test('legacy in-flight creation keeps its original uncategorized body during recovery', async()=>{
    await product(33); const draft=await preview(33,7);
    const [[saved]]=await pool.query('SELECT preview_json,request_json FROM square_product_creations WHERE id=?',[draft.id]);
    const oldPreview=JSON.parse(saved.preview_json),oldRequest=JSON.parse(saved.request_json);
    delete oldPreview.squareCategory;delete oldRequest.object.item_data.categories;delete oldRequest.object.item_data.reporting_category;
    await pool.query("UPDATE square_product_creations SET status='sending',preview_json=?,request_json=? WHERE id=?",[JSON.stringify(oldPreview),JSON.stringify(oldRequest),draft.id]);
    await apply(draft.id,7);
    assert.deepEqual(writes().find(row=>row.body.idempotency_key===draft.id).body,oldRequest);
  });
  await t.test('category name refresh preserves assignments, tracks deleted IDs and never guesses replacement IDs',async()=>{
    await product(34);
    const before=await getSquareCategorySetup(34);
    const [[savedBefore]]=await pool.query("SELECT assignment_json FROM square_category_crosswalk WHERE target_hash=? AND scope='category' AND source_id='1'",[categoryTarget]);
    const count=writes().length;
    category.category_data.name='Renamed Meat';
    await assert.rejects(preview(34,7),/category changed/);
    await refreshSquareCategoryRegistry();
    const renamed=await getSquareCategorySetup(34);
    assert.deepEqual(renamed.categoryNames,['Renamed Meat']);assert.notEqual(renamed.revision,before.revision);
    const draft=await preview(34,7);
    assert.equal(draft.squareCategory.categories[0].name,'Renamed Meat');
    category.is_deleted=true;
    await refreshSquareCategoryRegistry();
    assert.match((await getSquareCategorySetup(34)).issue,/unavailable/);
    const [[savedAfter]]=await pool.query("SELECT assignment_json FROM square_category_crosswalk WHERE target_hash=? AND scope='category' AND source_id='1'",[categoryTarget]);
    assert.equal(savedAfter.assignment_json,savedBefore.assignment_json);
    assert.equal(writes().length,count);
    delete category.is_deleted;category.category_data.name='Meat';await refreshSquareCategoryRegistry();
    await assert.rejects(importSquareCategoryCrosswalk({registry:[],bindings:[]},categoryTarget),/already exists/);
    await assert.rejects(importSquareCategoryCrosswalk({registry:[],bindings:[]},'different-target'),/connection changed/);
  });
  await t.test('pricing popup setup is scoped, searchable, read-only and recovers the durable creation receipt', async () => {
    const { default: router } = await import('../routes/enterprisePricing.js');
    const { upsertReturnedSquareObjects } = await import('./squareStoreSync.js');
    const route = router.stack.find(layer => layer.route?.path === '/products/:id/square-setup').route;
    const handlers = route.stack.map(layer => layer.handle);
    await product(15);
    await pool.query("INSERT INTO vendors(id,name) VALUES(2,'Other supplier')");
    await pool.query('UPDATE products SET vendor_id=2 WHERE id=15');
    const manual = { type: 'ITEM', id: 'manual-item', item_data: { name: 'Unrelated catalog item', variations: [
      { type: 'ITEM_VARIATION', id: 'manual-variation', version: 1, item_variation_data: { item_id: 'manual-item', name: 'Distinct option', sku: 'EXACT-MANUAL', pricing_type: 'FIXED_PRICING', price_money: { amount: 500, currency: 'USD' } } }
    ] } };
    await upsertReturnedSquareObjects(pool, [manual], new Date());
    const before = requests.length;
    async function read(id, search = '') {
      let status = 200, result;
      await handlers.at(-1)({ params: { id: String(id) }, query: { search } }, {
        status(code) { status = code; return this; }, json(value) { result = value; }
      });
      return { status, result };
    }
    const setup = await read(15);
    assert.equal(setup.status, 200);
    assert.equal(setup.result.enabled, true);
    assert.equal(setup.result.productId, 15);
    assert.equal(setup.result.rows.length, 2);
    assert.ok(setup.result.rows.every(row => row.productId === 15));
    assert.equal(setup.result.creation, null);
    assert.equal(setup.result.categoryMapping.source,'category');
    assert.equal((await links(15)).length, 0);
    const searched = await read(15, 'EXACT-MANUAL');
    assert.ok(searched.result.rows.every(row => row.candidates.length === 1 && row.candidates[0].squareVariationId === 'manual-variation'));
    const absent = await read(15, 'nothing-matches-this-query');
    assert.ok(absent.result.rows.every(row => row.candidates.length === 0));
    const completed = await read(14);
    assert.equal(completed.result.creation.status, 'completed');
    assert.equal(completed.result.creation.enterpriseRevisionId > 0, true);
    assert.equal((await read('15,1')).status, 400);
    assert.equal(requests.length, before, 'Setup reads must not fetch or publish remote objects.');
    for (const roles of [['pricing_editor'], ['square_pull'], ['square_push'], ['pricing_admin'], ['admin']]) {
      let allowed = false, status = 200;
      await handlers[0]({ admin: { adminRoles: roles } }, { status(code) { status = code; return this; }, json() {} }, () => { allowed = true; });
      assert.equal(allowed, roles[0] !== 'pricing_editor');
      assert.equal(status, allowed ? 200 : 403);
    }
    for (const path of ['/products/:id/square-category','/square-categories/refresh']) {
      const permission=router.stack.find(layer=>layer.route?.path===path).route.stack[0].handle;
      for (const role of ['square_pull','square_push','pricing_editor','admin']) {
        let allowed=false;
        await permission({admin:{adminRoles:[role]}},{status(){return this;},json(){}},()=>{allowed=true;});
        assert.equal(allowed,['square_pull','admin'].includes(role));
      }
    }
  });
});
