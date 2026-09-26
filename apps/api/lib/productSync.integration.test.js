import { test } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../schema.js";

// Opt-in, disposable MySQL only. Never reads .env or connects to the application database.
const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test("persisted audits, pagination, mixed releases, retries, drift, and legacy compatibility", { skip: !socket }, async t => {
  assert.ok(socket.startsWith("/tmp/csa-product-sync-") || socket.startsWith("/private/tmp/csa-product-sync-"));
  const database = `csa_sync_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: "root" });
  await root.query(`CREATE DATABASE \`${database}\``);
  await root.end();
  Object.assign(process.env, { STORE_DB_HOST: "127.0.0.1", STORE_DB_PORT: "1", STORE_DB_DATABASE: database, STORE_DB_USER: "root", STORE_DB_PASSWORD: "",
    LL_BASEURL: "https://localline.test/api/backoffice/v2/", LL_USERNAME: "test", LL_PASSWORD: "test", LL_PRICE_LIST_GUEST_ID: "1", LL_PRICE_LIST_GUEST_MARKUP: "0",
    SQUARE_BASE_URL: "https://square.test", SQUARE_ACCESS_TOKEN: "test", LOCALLINE_TEST: "false", LOCALLINE_UPDATE_PRICES: "true" });
  const { getPool } = await import("../db.js");
  const pool = getPool();
  pool.pool.config.connectionConfig.socketPath = socket;
  t.after(() => pool.end());
  for (const table of [schema.products, schema.packages, schema.vendors, schema.categories, schema.productPricingProfiles, schema.productSales, schema.productImages, schema.productMedia, schema.localLineProductMeta, schema.localLinePackageMeta, schema.users]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(col => `\`${col.name}\` ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${col.autoIncrement ? " AUTO_INCREMENT" : ""}${col.primary ? " PRIMARY KEY" : ""}${col.default !== undefined && (typeof col.default !== "object" || col.default === null) ? ` DEFAULT ${pool.escape(col.default)}` : ""}`);
    for (const index of config.indexes.filter(index => index.config.unique)) columns.push(`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map(col => `\`${col.name}\``).join(",")})`);
    await pool.query(`CREATE TABLE \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`);
  }
  await pool.query("INSERT INTO categories (id,name) VALUES (1,'Meat'),(2,'Membership')");
  await pool.query("INSERT INTO vendors (id,name) VALUES (1,'Deck Family Farm')");
  const { ensureProductSyncSchema } = await import("./productSyncSchema.js");
  await ensureProductSyncSchema();
  const service = await import("./productSync.js");
  const { createScheduledPricelistBatch, getActiveScheduledPricelistProductChangeMap } = await import("./scheduledPricelistReleases.js");
  const { prepareLocalLineAction } = await import("./productSyncAdapters.js");
  const remoteProducts = new Map();
  const squareObjects = new Map();
  const requests = [];
  let failSquare = false, loseCreateResponse = false, failCreateReads = 0, pausePublication = null;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url); assert.ok(["localline.test", "square.test"].includes(parsed.hostname), `Unexpected external request: ${parsed.hostname}`);
    const method = options.method || "GET"; const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path: parsed.pathname, method, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (parsed.pathname.endsWith("/token/")) return json({ access: "test" });
    if (parsed.pathname.endsWith("/product-units/")) return json({ results: [{ id: 1, name: "Each", abbrieviation: "ea", unit_type: "item" }] });
    if (parsed.pathname.endsWith("/products/") && method === "POST") {
      if (loseCreateResponse) throw new Error("Lost create response");
      const id = 99000 + requests.length;
      const remote = { ...body, id, inventory: body.set_inventory, packages: body.packages.map((pkg, i) => ({ ...pkg, id: id + i + 100, price_list_entries: [{ id: id + i + 200, product_price_list_entry: id + i + 200, price_list: 1, adjustment_type: 2, adjustment_value: 0, on_sale: false, on_sale_toggle: false, calculated_value: pkg.unit_price, strikethrough_display_value: null, max_units_per_order: null }] })) };
      remoteProducts.set(id, remote);
      return json(remote);
    }
    const productMatch = parsed.pathname.match(/\/products\/(\d+)\//);
    if (productMatch) {
      const id = Number(productMatch[1]); const remote = remoteProducts.get(id);
      if (!remote) return json({ error: "missing" }, 404);
      if (method === "GET" && id > 99000 && failCreateReads > 0) { failCreateReads -= 1; throw new Error("Interrupted after confirmed creation"); }
      if (method === "PATCH") {
        if (pausePublication?.id === id) { pausePublication.entered(); await pausePublication.wait; }
        Object.assign(remote, body); if (Object.hasOwn(body, "set_inventory")) remote.inventory = body.set_inventory;
      }
      return json(remote);
    }
    if (parsed.pathname === "/v2/catalog/list") return json({ objects: [...squareObjects.values()].filter(obj => obj.type === "ITEM") });
    if (parsed.pathname.endsWith("/batch-retrieve")) return json({ objects: body.object_ids.map(id => squareObjects.get(id)).filter(Boolean) });
    if (parsed.pathname.endsWith("/batch-upsert")) {
      if (failSquare) throw new Error("Temporary Square outage");
      for (const object of body.batches[0].objects) squareObjects.set(object.id, { ...object, version: object.version + 1 });
      return json({ objects: body.batches[0].objects.map(object => squareObjects.get(object.id)) });
    }
    throw new Error(`Unhandled mock path ${parsed.pathname}`);
  });
  async function product(id, linked = true) {
    await pool.query("INSERT INTO products (id,name,vendor_id,category_id,visible,track_inventory,inventory,is_deleted) VALUES (?, ?, 1,1,1,1,20,0)", [id, `Product ${id}`]);
    await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items,visible,track_inventory,inventory) VALUES (?,?,'ea',10,'ea',1,1,0,0)", [id * 10, id]);
    await pool.query("INSERT INTO product_pricing_profiles (product_id,unit_of_measure,source_unit_price,source_multiplier,on_sale,sale_discount) VALUES (?,'each',10,1,0,0)", [id]);
    await pool.query("INSERT INTO product_sales (product_id,on_sale,sale_discount) VALUES (?,0,0)", [id]);
    if (linked) {
      await pool.query("INSERT INTO local_line_product_meta (product_id,local_line_product_id) VALUES (?,?)", [id, id + 1000]);
      await pool.query("INSERT INTO local_line_package_meta (product_id,package_id,local_line_package_id) VALUES (?,?,?)", [id, id * 10, id + 2000]);
      remoteProducts.set(id + 1000, { id: id + 1000, name: `Product ${id}`, description: "", visible: true, track_inventory: true, inventory: 20, package_codes_enabled: true,
        packages: [{ id: id + 2000, name: "ea", unit_price: 8, package_price: 8, package_unit_price: 8, inventory_per_unit: 1,
          price_list_entries: [{ id: id + 3000, product_price_list_entry: id + 3000, price_list: 1, adjustment_type: 2, adjustment_value: 0, on_sale: false, on_sale_toggle: false, calculated_value: 8, strikethrough_display_value: null, max_units_per_order: null, adjustment: true }] }] });
    } else await pool.query("INSERT INTO local_line_product_meta (product_id,local_line_product_id) VALUES (?,0)", [id]);
    const variation = { id: `V${id}`, type: "ITEM_VARIATION", version: 1, item_variation_data: { item_id: `I${id}`, name: "ea", pricing_type: "FIXED_PRICING", price_money: { amount: 1100, currency: "USD" } } };
    const item = { id: `I${id}`, type: "ITEM", version: 1, item_data: { name: `Product ${id}`, variations: [variation] } };
    squareObjects.set(item.id, item); squareObjects.set(variation.id, variation);
    await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at) VALUES (?,?,?,?,UTC_TIMESTAMP())", [id,id*10,item.id,variation.id]);
  }
  const user = { userId: 1, adminRoles: ["admin"] };
  async function audit(ids, staged = [], options = {}) {
    const started = await service.createProductSyncAudit({ platforms: ["localline", "square"], productIds: ids, staged, ...options }, user);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await service.getProductSyncAudit(started.id);
      if (result.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.status, "completed", JSON.stringify(result));
    return { audit: result, ...(await service.listProductSyncActions(started.id, { status: "changed" })) };
  }
  await product(1);
  const first = await audit([1], [{ productId: 1, changes: { inventory: 15, onSale: 1, saleDiscount: 0.1 } }]);
  assert.equal(first.rows.length, 2);
  assert.equal(first.audit.options.auditedProductCount, 1);
  assert.equal(first.audit.overview.find(row => row.platform === "square").changedProducts, 1);
  assert.equal(requests.filter(request => request.method === "PATCH" || request.path.endsWith("/batch-upsert")).length, 0, "Audits cannot publish");
  const [[before]] = await pool.query("SELECT inventory FROM products WHERE id=1"); assert.equal(before.inventory, 20);
  await assert.rejects(service.createProductSyncRelease({ auditId: first.audit.id, actionIds: first.rows.map(row => row.id) }, { adminRoles: ["square_push"] }), /Push permission/);
  await assert.rejects(service.createProductSyncRelease({ auditId: first.audit.id, actionIds: [99999] }, user), /belong/);
  const created = await service.createProductSyncRelease({ auditId: first.audit.id, actionIds: first.rows.map(row => row.id), name: "Both platforms" }, user);
  assert.equal((await service.listProductSyncActions(first.audit.id, {status:"changed"})).productCount, 0, "Approved changes leave the awaiting-approval view");
  assert.equal((await service.listProductSyncActions(first.audit.id, {status:"all"})).productCount, 1, "All results preserve released products");
  assert.ok((await service.getProductSyncAudit(first.audit.id)).overview.every(row => row.changedProducts===0));
  await assert.rejects(service.createProductSyncRelease({ auditId: first.audit.id, actionIds: first.rows.map(row => row.id) }, user), /unreleased/);
  failSquare = true;
  let release = await service.runProductSyncRelease(created.id, { user, allowFuture: true });
  assert.equal(release.status, "partial", JSON.stringify(release.actions.map(a => ({ status: a.status, message: a.message }))));
  assert.equal(release.actions.find(a => a.platform === "localline").status, "completed");
  const [[staged]] = await pool.query("SELECT inventory FROM products WHERE id=1"); assert.equal(staged.inventory, 15);
  const llWrites = requests.filter(request => request.method === "PATCH").length;
  failSquare = false;
  release = await service.runProductSyncRelease(created.id, { user, allowFuture: true });
  assert.equal(release.status, "completed", JSON.stringify(release.actions.map(a => ({ status: a.status, message: a.message }))));
  assert.equal(requests.filter(request => request.method === "PATCH").length, llWrites);
  assert.equal(squareObjects.get("V1").item_variation_data.price_money.amount, 900);
  await assert.rejects(service.cancelProductSyncRelease(created.id, user), /Only unstarted/);
  const state = await service.productSyncStatus(); assert.ok(state.platforms.every(platform => platform.lastPush));

  await product(2); await product(3);
  const drift = await audit([2,3]);
  const future = new Date(Math.ceil((Date.now()+7200000)/3600000)*3600000).toISOString();
  const heldRelease = await service.createProductSyncRelease({ auditId: drift.audit.id, actionIds: drift.rows.map(row => row.id), scheduledAt: future }, user);
  await pool.query("UPDATE product_pricing_profiles SET source_unit_price=99 WHERE product_id=2");
  squareObjects.get("V3").item_variation_data.price_money.amount = 1200;
  const held = await service.runProductSyncRelease(heldRelease.id, { user, allowFuture: true });
  assert.equal(held.actions.filter(a => a.productId===2 && a.status==="held").length, 2);
  assert.equal(held.actions.find(a => a.productId===3 && a.platform==="square").status, "held");
  assert.equal(held.actions.find(a => a.productId===3 && a.platform==="localline").status, "completed");

  await product(4);
  const links = await audit([4]);
  const linkRelease = await service.createProductSyncRelease({ auditId: links.audit.id, actionIds: links.rows.filter(a=>a.platform==="square").map(a=>a.id) }, user);
  await pool.query("DELETE FROM square_variation_links WHERE product_id=4");
  const changedLink = await service.runProductSyncRelease(linkRelease.id, { user, allowFuture: true });
  assert.equal(changedLink.actions[0].status,"held");

  await product(5, false);
  const createAudit = await audit([5]);
  const createRelease = await service.createProductSyncRelease({ auditId: createAudit.audit.id, actionIds: createAudit.rows.filter(a=>a.platform==="localline").map(a=>a.id) }, user);
  const newProduct = await service.runProductSyncRelease(createRelease.id, { user, allowFuture: true });
  assert.equal(newProduct.status, "completed", JSON.stringify(newProduct.actions.map(a=>({status:a.status,message:a.message}))));
  assert.ok(newProduct.actions[0].checkpoint.remoteId);

  await product(6, false);
  const uncertainAudit = await audit([6]);
  const uncertainRelease = await service.createProductSyncRelease({ auditId: uncertainAudit.audit.id, actionIds: uncertainAudit.rows.filter(a=>a.platform==="localline").map(a=>a.id) }, user);
  loseCreateResponse = true;
  await service.runProductSyncRelease(uncertainRelease.id, { user, allowFuture: true });
  const attempts = requests.filter(r=>r.method==="POST" && r.path.endsWith("/products/")).length;
  loseCreateResponse = false;
  const uncertain = await service.runProductSyncRelease(uncertainRelease.id, { user, allowFuture: true });
  assert.equal(uncertain.status,"held");
  assert.equal(requests.filter(r=>r.method==="POST" && r.path.endsWith("/products/")).length, attempts);
  await assert.rejects(prepareLocalLineAction({ id:6,name:"Product 6" }), /reconciliation/);

  await product(7);
  const cancelAudit = await audit([7]);
  const cancelRelease = await service.createProductSyncRelease({ auditId:cancelAudit.audit.id, actionIds:cancelAudit.rows.map(a=>a.id), scheduledAt:future },user);
  await service.cancelProductSyncRelease(cancelRelease.id,user);
  await assert.rejects(service.runProductSyncRelease(cancelRelease.id,{user,allowFuture:true}),/cancelled/);
  const legacy = await createScheduledPricelistBatch({ name:"Existing Local Line release", scheduledAt:future, rows:[{productId:7, changes:{inventory:10}}] });
  const history = await service.listProductSyncReleases();
  assert.ok(history.legacy.some(item=>item.id===legacy.id));
  assert.ok(history.releases.some(item=>item.id===created.id));

  await product(8, false);
  const restartAudit = await audit([8]);
  const restartRelease = await service.createProductSyncRelease({ auditId: restartAudit.audit.id, actionIds: restartAudit.rows.filter(a=>a.platform==="localline").map(a=>a.id) }, user);
  failCreateReads = 2;
  const interrupted = await service.runProductSyncRelease(restartRelease.id,{user,allowFuture:true});
  assert.equal(interrupted.status,"failed");
  assert.ok(interrupted.actions[0].checkpoint.remoteId);
  const createCount = requests.filter(r=>r.method==="POST"&&r.path.endsWith("/products/")).length;
  const resumed = await service.runProductSyncRelease(restartRelease.id,{user,allowFuture:true});
  assert.equal(resumed.status,"completed", JSON.stringify(resumed.actions.map(a=>({status:a.status,message:a.message}))));
  assert.equal(requests.filter(r=>r.method==="POST"&&r.path.endsWith("/products/")).length,createCount);

  await product(9);
  const { readIncomingSnapshot, applyIncomingAction } = await import("./productSyncIncoming.js");
  const { fingerprint } = await import("./productSyncCore.js");
  const proposals = [
    {action:"update-store-product-from-localline",productId:9,localLineProductId:1009,changes:{name:{from:"Product 9",to:"Renamed product"}}},
    {action:"update-store-package-from-localline",productId:9,packageId:90,localLineProductId:1009,changes:{name:{from:"ea",to:"Each"}}}
  ];
  const incoming = [];
  for (const proposal of proposals) {
    const action={kind:proposal.action,productId:proposal.productId,proposal,proposalHash:fingerprint(proposal),localBefore:await readIncomingSnapshot(proposal)};
    const [inserted] = await pool.query("INSERT INTO product_sync_actions (audit_id,product_id,product_name,platform,direction,status,data_json) VALUES (?,9,'Product 9','localline','incoming','changed',?)",[restartAudit.audit.id,JSON.stringify(action)]);
    incoming.push({...action,id:Number(inserted.insertId)});
  }
  const connection = await pool.getConnection();
  try {
    for (const action of incoming) assert.equal((await applyIncomingAction(action,new Set([action.proposalHash]),connection)).status,"applied");
    const [[row]] = await pool.query("SELECT name FROM products WHERE id=9"); assert.equal(row.name,"Renamed product");
    const [[pkg]] = await pool.query("SELECT name, price FROM packages WHERE id=90"); assert.equal(pkg.name,"Each"); assert.equal(Number(pkg.price),10);
    const stale = await applyIncomingAction(incoming[0],new Set([incoming[0].proposalHash]),connection);
    assert.equal(stale.status,"held","Reapplying stale incoming snapshots is held");
  } finally {connection.release();}

  assert.ok((await getActiveScheduledPricelistProductChangeMap()).has(2));
  const reviewed = await service.reviewProductSyncRelease(heldRelease.id,user);
  assert.equal((await getActiveScheduledPricelistProductChangeMap()).has(2),false,"Superseded actions must release incoming field protection");
  for (let attempt=0; attempt<300; attempt++) {
    if ((await service.getProductSyncAudit(reviewed.id)).status!=="running") break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  // Full stored audits paginate by product without splitting platform rows or returning samples.
  for (let id=10; id<45; id++) await product(id);
  const many = await audit(Array.from({length:35},(_,i)=>i+10));
  assert.equal(many.productCount,35); assert.equal(many.rows.length,60);
  const page2 = await service.listProductSyncActions(many.audit.id,{status:"changed",page:2}); assert.equal(page2.rows.length,10);
  const selected = await service.listProductSyncActions(many.audit.id,{status:"changed"},true,["square_push"]); assert.equal(selected.ids.length,35);
  // The same vendor scope governs both destinations, including new local-only products.
  await pool.query("INSERT INTO vendors (id,name) VALUES (2,'Creamy Cow, LLC'),(3,'Hyland Meats'),(4,'Other Farm')");
  for (const id of [100, 101, 102, 103]) await product(id, false);
  await pool.query("UPDATE products SET vendor_id=2 WHERE id=100");
  await pool.query("UPDATE products SET vendor_id=3 WHERE id=101");
  await pool.query("UPDATE products SET vendor_id=4 WHERE id=102");
  await pool.query("UPDATE products SET category_id=2 WHERE id=103");
  await pool.query("DELETE FROM product_pricing_profiles WHERE product_id=102");
  const pending = await service.pendingProductSync();
  assert.ok(pending.rows.some(row => row.productId===100 && row.kind==="create"));
  assert.ok(pending.rows.some(row => row.productId===101 && row.kind==="create"));
  assert.ok(!pending.rows.some(row => [102,103].includes(row.productId)));
  assert.ok((await service.pendingProductSync({vendorGroup:"all"})).rows.some(row => row.productId===102), "New standard products need no pricing profile to be pending");
  const scoped = await audit([100,101,102,103]);
  assert.deepEqual([...new Set(scoped.rows.map(row => row.productId))].sort(), [100,101]);
  assert.equal(scoped.rows.length,4, "Creamy Cow and Hyland are audited on both platforms");
  const requestCount = requests.length;
  const emptyScope = await audit([102]);
  assert.equal(emptyScope.productCount,0);
  assert.equal(requests.length,requestCount, "An empty vendor intersection cannot audit all Square products");
  assert.equal((await audit([102],[],{vendorGroup:"all"})).rows.length,2);
  // Nine pending products must stay nine across destinations even with multiple Square packages.
  const pendingIds = Array.from({length:9}, (_,i) => 110+i);
  for (const id of pendingIds) await product(id);
  await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items,visible,track_inventory,inventory) VALUES (1101,110,'large',10,'ea',1,1,0,0)");
  await pool.query("INSERT INTO local_line_package_meta (product_id,package_id,local_line_package_id) VALUES (110,1101,50000)");
  remoteProducts.get(1110).packages.push({...structuredClone(remoteProducts.get(1110).packages[0]), id:50000, name:"large"});
  const extraVariation = structuredClone(squareObjects.get("V110"));
  extraVariation.id="V110large"; extraVariation.item_variation_data.name="large";
  squareObjects.set(extraVariation.id,extraVariation); squareObjects.get("I110").item_data.variations.push(extraVariation);
  await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at) VALUES (110,1101,'I110','V110large',UTC_TIMESTAMP())");
  squareObjects.get("V118").item_variation_data.price_money.amount=1000;
  const nine = await audit(pendingIds,[],{productScope:"pending"});
  assert.equal(nine.audit.options.productScope,"pending");
  assert.equal(nine.audit.options.auditedProductCount,9);
  assert.equal(nine.productCount,9); assert.equal(nine.total,18);
  assert.deepEqual(nine.platformCounts,[{platform:"localline",productCount:9,updateCount:9},{platform:"square",productCount:8,updateCount:9}]);
  assert.ok(nine.rows.every(row => pendingIds.includes(row.productId)), "Unrelated pending catalog products stay outside the audit");
  const squareOverview=nine.audit.overview.find(row=>row.platform==="square");
  assert.equal(squareOverview.productCount,9); assert.equal(squareOverview.changedProducts,8); assert.equal(squareOverview.syncedProducts,1);
  const squareResults=await service.listProductSyncActions(nine.audit.id,{direction:"outgoing",platform:"square",status:"changed",pageSize:1});
  assert.equal(squareResults.productCount,8); assert.equal(squareResults.total,9);
  assert.equal(squareResults.rows.length,2,"Packages stay grouped while totals cover every page");
  await assert.rejects(service.createProductSyncAudit({platforms:["localline","square"],productScope:"pending",productIds:[]},user),/no products/);
  // A slow destination must not hold the approval response or hide durable progress.
  await product(120); await product(121);
  const asyncAudit = await audit([120,121]);
  const approval = await service.createProductSyncRelease({auditId:asyncAudit.audit.id, actionIds:asyncAudit.rows.filter(row=>row.productId===120).map(row=>row.id)},user);
  const nextApproval = await service.createProductSyncRelease({auditId:asyncAudit.audit.id, actionIds:asyncAudit.rows.filter(row=>row.productId===121).map(row=>row.id)},user);
  await assert.rejects(service.queueProductSyncRelease(approval.id,{adminRoles:["square_push"]}),/Push permission/);
  let resume, entered;
  const entry = new Promise(resolve => { entered=resolve; });
  pausePublication={id:1120,entered,wait:new Promise(resolve=>{resume=resolve;})};
  failSquare=true;
  const receipt=await service.queueProductSyncRelease(approval.id,user);
  assert.ok(["queued","running"].includes(receipt.status));
  await entry;
  const progress=await service.getProductSyncReleaseProgress(approval.id);
  assert.equal(progress.status,"running");
  assert.ok(progress.actions.some(row=>row.status==="working" && row.message.includes("Applying")));
  assert.ok(progress.actions.every(row=>!Object.hasOwn(row,"payload")&&!Object.hasOwn(row,"localBefore")),"Progress responses omit frozen payloads");
  assert.ok((await service.activeProductSyncReleases()).releases.some(row=>row.id===approval.id));
  const queued=await service.queueProductSyncRelease(nextApproval.id,user);
  assert.equal(queued.status,"queued","Another release keeps its receipt while waiting for the shared execution lock");
  await service.queueProductSyncRelease(approval.id,user); // Duplicate start/poll must not publish twice.
  resume(); pausePublication=null;
  async function waitForRelease(id) {
    for (let i=0;i<600;i++) {
      const result=await service.getProductSyncReleaseProgress(id);
      if (!["queued","running"].includes(result.status)) return result;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail("Background release did not finish");
  }
  const partial=await waitForRelease(approval.id);
  assert.equal(partial.status,"partial"); assert.ok(partial.finishedAt);
  failSquare=false;
  await service.queueProductSyncRelease(approval.id,user);
  assert.equal((await waitForRelease(approval.id)).status,"completed");
  assert.equal((await waitForRelease(nextApproval.id)).status,"completed");
  assert.equal(requests.filter(row=>row.path.endsWith('/products/1120/')&&row.method==='PATCH').length,1,"Retries and status polling never resend the confirmed Local Line change");
  const {saveInventoryToLocalLine}=await import('./inventorySync.js');
  await product(130);
  await pool.query("UPDATE product_pricing_profiles SET remote_sync_status='synced', updated_at='2026-01-01', remote_synced_at='2026-01-02' WHERE product_id=130");
  const [[profileBefore]]=await pool.query("SELECT * FROM product_pricing_profiles WHERE product_id=130");
  const [[saleBefore]]=await pool.query("SELECT * FROM product_sales WHERE product_id=130");
  const pricingAudit=await audit([130]);
  const llPriceAction=pricingAudit.rows.find(row=>row.platform==='localline');
  assert.equal(llPriceAction.includeInventory,false);
  assert.equal(llPriceAction.includeVisibility,false);
  assert.ok(!Object.hasOwn(llPriceAction.payload,'set_inventory'));
  assert.ok(!Object.hasOwn(llPriceAction.payload,'track_inventory'));
  assert.ok(!Object.hasOwn(llPriceAction.payload,'visible'));
  const startRequests=requests.length;
  const inventoryResult=await saveInventoryToLocalLine(130,{inventory:7,trackInventory:1,visible:0},user);
  assert.equal(inventoryResult.localLineUpdate,true);
  const inventoryRequests=requests.slice(startRequests);
  assert.deepEqual(inventoryRequests.filter(row=>row.method==='PATCH').map(row=>row.body),[{set_inventory:7,track_inventory:true,visible:false}]);
  assert.ok(!inventoryRequests.some(row=>row.path.includes('/v2/catalog/')),"Inventory never contacts Square");
  const [[inventoryAfter]]=await pool.query("SELECT inventory, track_inventory, visible FROM products WHERE id=130");
  assert.deepEqual(inventoryAfter,{inventory:7,track_inventory:1,visible:0});
  const [[profileAfter]]=await pool.query("SELECT * FROM product_pricing_profiles WHERE product_id=130");
  const [[saleAfter]]=await pool.query("SELECT * FROM product_sales WHERE product_id=130");
  assert.deepEqual(profileAfter,profileBefore);assert.deepEqual(saleAfter,saleBefore);
  assert.equal((await service.pendingProductSync()).rows.some(row=>row.productId===130),false,"Inventory success does not create pending Product Sync work");
  const priceRelease=await service.createProductSyncRelease({auditId:pricingAudit.audit.id,actionIds:[llPriceAction.id]},user);
  assert.equal((await service.runProductSyncRelease(priceRelease.id,{user,allowFuture:true})).status,'completed',"An ordinary pricing approval survives an independent inventory update");
  assert.equal(remoteProducts.get(1130).inventory,7,"Product Sync must not overwrite inventory");
  assert.equal(remoteProducts.get(1130).visible,false,"An unrelated pricing release must not overwrite visibility");
  await pool.query("UPDATE product_pricing_profiles SET remote_sync_status='pending' WHERE product_id=130");
  await saveInventoryToLocalLine(130,{inventory:6},user);
  await saveInventoryToLocalLine(130,{visible:1},user);
  assert.equal(remoteProducts.get(1130).visible,true);
  assert.equal((await service.pendingProductSync()).rows.some(row=>row.productId===130),true,"Inventory does not clear pending pricing changes");
  await assert.rejects(saveInventoryToLocalLine(130,{inventory:4},{adminRoles:['inventory_admin']}),/permissions/);
  await assert.rejects(saveInventoryToLocalLine(130,{inventory:4,onSale:0},user),/stock, inventory tracking, and visibility only/);
  await product(131,false);
  await assert.rejects(saveInventoryToLocalLine(131,{inventory:1},user),/Create and link/);
  remoteProducts.delete(1130);
  await assert.rejects(saveInventoryToLocalLine(130,{inventory:1},user),/PATCH failed/);
  const [[unchangedInventory]]=await pool.query("SELECT inventory FROM products WHERE id=130");
  assert.equal(unchangedInventory.inventory,6,"A failed remote update preserves the previously confirmed local inventory");
  console.log(`Validated isolated MySQL database ${database}`);
});
