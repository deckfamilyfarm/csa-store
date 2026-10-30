import { test } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../schema.js";

const nativeFetch = globalThis.fetch;
const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test("saved prices activate locally before independently approved channel publication", { skip: !socket }, async t => {
  assert.ok(socket.startsWith("/tmp/csa-product-sync-") || socket.startsWith("/private/tmp/csa-product-sync-"));
  const database = `csa_enterprise_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: "root" });
  await root.query(`CREATE DATABASE \`${database}\``);
  await root.end();
  Object.assign(process.env, {
    STORE_DB_HOST: "127.0.0.1", STORE_DB_PORT: "1", STORE_DB_DATABASE: database, STORE_DB_USER: "root", STORE_DB_PASSWORD: "",
    LL_BASEURL: "https://localline.test/api/backoffice/v2/", LL_USERNAME: "test", LL_PASSWORD: "test",
    LL_PRICE_LIST_GUEST_ID: "1", LL_PRICE_LIST_CSA_MEMBERS_ID: "2", LL_PRICE_LIST_HERDSHARE_ID: "3", LL_PRICE_LIST_SNAP_ID: "4",
    LOCALLINE_TEST: "false", LOCALLINE_UPDATE_PRICES: "true", SQUARE_BASE_URL: "https://square.test", SQUARE_ACCESS_TOKEN: "test", SQUARE_ENVIRONMENT: "sandbox"
  });
  const { getPool } = await import("../db.js");
  const pool = getPool();
  pool.pool.config.connectionConfig.socketPath = socket;
  t.after(() => pool.end());
  for (const table of [schema.products, schema.packages, schema.vendors, schema.categories, schema.productPricingProfiles,
    schema.productSales, schema.productTags, schema.productImages, schema.productMedia, schema.localLineProductMeta,
    schema.localLinePackageMeta, schema.localLinePriceListEntries, schema.priceLists, schema.users]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(col => `\`${col.name}\` ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${col.autoIncrement ? " AUTO_INCREMENT" : ""}${col.primary ? " PRIMARY KEY" : ""}${col.default !== undefined && (typeof col.default !== "object" || col.default === null) ? ` DEFAULT ${pool.escape(col.default)}` : ""}`);
    for (const index of config.indexes.filter(index => index.config.unique)) columns.push(`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map(col => `\`${col.name}\``).join(",")})`);
    await pool.query(`CREATE TABLE \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`);
  }
  await pool.query("INSERT INTO categories (id,name) VALUES (1,'Meat')");
  await pool.query("INSERT INTO vendors (id,name) VALUES (1,'Deck Family Farm')");
  await pool.query("INSERT INTO products (id,name,vendor_id,category_id,visible,track_inventory,inventory,is_deleted) VALUES (1,'Sausage 12 oz',1,1,1,0,0,0)");
  await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items,visible) VALUES (10,1,'12 oz package',10,'each',1,1)");
  await pool.query("INSERT INTO product_pricing_profiles (product_id,unit_of_measure,source_unit_price,source_multiplier,on_sale,sale_discount) VALUES (1,'each',10,1,0,0)");
  await pool.query("INSERT INTO product_sales (product_id,on_sale,sale_discount) VALUES (1,0,0)");
  await pool.query("INSERT INTO local_line_product_meta (product_id,local_line_product_id) VALUES (1,1001)");
  await pool.query("INSERT INTO local_line_package_meta (product_id,package_id,local_line_package_id) VALUES (1,10,2001)");
  const { ensureProductSyncSchema } = await import("./productSyncSchema.js");
  const { ensureEnterprisePricingSchema } = await import("./enterprisePricingSchema.js");
  await ensureProductSyncSchema(); await ensureEnterprisePricingSchema();
  await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at) VALUES (1,10,'I1','V1',UTC_TIMESTAMP())");

  const remote = { id: 1001, vendor: 101, name: "Sausage 12 oz", description: "", visible: true, track_inventory: false, inventory: 0,
    packages: [{ id: 2001, name: "12 oz package", unit_price: 10, package_price: 10, package_unit_price: 10, inventory_per_unit: 1,
      price_list_entries: [1, 2, 3, 4].map(n => ({ id: 3000 + n, product_price_list_entry: 3000 + n,
        price_list: n, adjustment: true, adjustment_type: 3, adjustment_value: 10, calculated_value: 10, on_sale: false })) }] };
  const variation = { id: "V1", type: "ITEM_VARIATION", version: 1, item_variation_data: { item_id: "I1", name: "12 oz package", pricing_type: "FIXED_PRICING", price_money: { amount: 1100, currency: "USD" } } };
  const item = { id: "I1", type: "ITEM", version: 1, item_data: { name: "Sausage 12 oz", variations: [variation] } };
  const square = new Map([["I1", item], ["V1", variation]]);
  const writes = [];
  let failNextSaleRestore = false;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url), method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
    assert.ok(["localline.test", "square.test"].includes(parsed.hostname));
    const json = value => new Response(JSON.stringify(value), { status: 200 });
    if (parsed.pathname.endsWith("/token/")) return json({ access: "test" });
    if (parsed.pathname.endsWith("/vendors/")) return json({ results: [{ id: 101, name: "Deck Family Farm" }] });
    if (parsed.pathname.endsWith("/vendors/101/")) return json({ id: 101, name: "Deck Family Farm" });
    if (parsed.pathname.endsWith("/products/1001/")) {
      if (method === 'PATCH' && failNextSaleRestore && body.packages?.[0]?.price_list_entries?.every(e => e.on_sale_toggle === false)) {
        throw new Error('Restore connection interrupted');
      }
      if (method === "PATCH") { writes.push({ platform: "localline", body }); Object.assign(remote, structuredClone(body)); }
      return json(remote);
    }
    if (parsed.pathname === "/v2/catalog/list") return json({ objects: parsed.searchParams.get("types") === "ITEM" ? [item] : [] });
    if (parsed.pathname.endsWith("/batch-retrieve")) return json({ objects: body.object_ids.map(value => square.get(value)).filter(Boolean) });
    if (method === "DELETE" && parsed.pathname.startsWith("/v2/catalog/object/")) {
      const objectId = parsed.pathname.split("/").at(-1);
      square.set(objectId, { ...square.get(objectId), is_deleted: true });
      return json({ deleted_object_ids: [objectId] });
    }
    if (parsed.pathname.endsWith("/batch-upsert")) {
      writes.push({ platform: "square", body });
      if (body.batches[0].objects.some(value => value.type === "DISCOUNT")) {
        const id_mappings = body.batches[0].objects.map((value, index) => ({ client_object_id: value.id, object_id: `PROMO${index}` }));
        const objects = body.batches[0].objects.map((value, index) => ({ ...value, id: `PROMO${index}`, version: 1 }));
        objects.forEach(value => square.set(value.id, value));
        return json({ id_mappings, objects });
      }
      for (const value of body.batches[0].objects) {
        const updated = { ...value, version: Number(value.version || 0) + 1 };
        square.set(value.id, updated);
        item.item_data.variations = item.item_data.variations.map(current => current.id === value.id ? updated : current);
      }
      return json({ objects: body.batches[0].objects.map(value => square.get(value.id)) });
    }
    throw new Error(`Unhandled test request ${method} ${parsed.pathname}`);
  });

  const pricing = await import("./enterprisePricingService.js");
  const sync = await import("./productSync.js");
  const detail = await pricing.getEnterprisePricingProduct(1);
  const ffcsa = detail.enterprises.find(row => row.code === "ffcsa");
  const deck = detail.enterprises.find(row => row.code === "deck");
  const input = { ...detail.suggestedInput, pricingUnit: "each", markupCategory: "custom", customMarkupBp: 14000,
    squareEnabled: true, purchaseCosts: [
      { enterpriseId: ffcsa.id, cost: "5.00", effectiveAt: "2026-10-21", documentationRef: "test transfer" },
      { enterpriseId: deck.id, cost: "4.00", effectiveAt: "2026-10-21", documentationRef: "test production cost" }
    ], wholesale: [
      { sellingEnterpriseId: deck.id, mode: "fixed", fixedPrice: "8.00" },
      { sellingEnterpriseId: ffcsa.id, mode: "markup", costEnterpriseId: ffcsa.id, markupBp: 8000 }
    ] };
  const draft = await pricing.saveEnterprisePricingDraft(1, input, null, { userId: 1 });
  assert.equal((await pricing.getEnterprisePricingProduct(1)).active?.id, draft.revisionId);
  assert.equal(writes.length, 0, "saving does not publish");
  const {readSavedEnterprisePricing}=await import("./enterprisePricingReads.js");
  assert.equal((await readSavedEnterprisePricing(pool,[1])).get(1).output.csaUnitCents,1080,"public catalog/export reads the saved price before channel approval");
  assert.equal(await pricing.enterpriseRevisionMarker(1, draft.revisionId), null, "local activation is not approval");
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM enterprise_purchase_cost_history WHERE revision_id=?", [draft.revisionId]))[0][0].n), 2, "purchase history is recorded at save");
  assert.equal(draft.output.squareUnitCents, 1200);
  assert.equal(draft.output.csaUnitCents, 1080);
  assert.deepEqual(draft.output.wholesale.map(row => row.priceCents), [800, 900]);
  await assert.rejects(pricing.approveEnterprisePricingRevision(draft.revisionId, { userId: 1 }), /different/);
  await pricing.approveEnterprisePricingRevision(draft.revisionId, { userId: 2 });
  assert.equal(writes.length, 0);
  const user = { userId: 2, adminRoles: ["pricing_publisher", "localline_push", "square_push"] };
  const audit = await sync.createProductSyncAudit({ platforms: ["localline", "square"], productIds: [1], productScope: "selected", vendorGroup: "all", enterpriseRevisionId: draft.revisionId }, user);
  let auditResult;
  for (let i = 0; i < 100; i += 1) {
    auditResult = await sync.getProductSyncAudit(audit.id);
    if (auditResult.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(auditResult.status, "completed", auditResult.error);
  const actions = (await sync.listProductSyncActions(audit.id, { direction: "outgoing", pageSize: 100 })).rows;
  assert.deepEqual(actions.map(row => [row.platform, row.status]).sort(), [["localline", "changed"], ["square", "changed"]], JSON.stringify(actions.map(row => ({platform:row.platform,message:row.message}))));
  assert.equal(writes.length, 0);
  const { readEnterpriseReviewChecks } = await import("./enterprisePricingReview.js");
  const reviewRows = await pricing.listEnterprisePricingReview();
  assert.equal(reviewRows.find(row => row.id === draft.revisionId)?.check?.auditId, audit.id);
  assert.equal(reviewRows.find(row => row.id === draft.revisionId)?.comparison.length, 4);
  const restoredCheck = (await readEnterpriseReviewChecks(pool, [draft.revisionId])).get(draft.revisionId);
  assert.equal(restoredCheck.auditId, audit.id);
  assert.deepEqual(restoredCheck.actions.map(action => action.id), actions.map(action => action.id));
  assert.equal((await readEnterpriseReviewChecks(pool, [999999])).size, 0, "old approval does not authorize a different revision");
  const release = await sync.createProductSyncRelease({ auditId: audit.id, actionIds: actions.map(row => row.id) }, user);
  const finished = await sync.runProductSyncRelease(release.id, { user, allowFuture: true });
  assert.equal(finished.status, "completed");
  const restoredRelease = (await readEnterpriseReviewChecks(pool, [draft.revisionId])).get(draft.revisionId);
  assert.ok(restoredRelease.actions.every(action => action.releaseId === release.id && action.releaseStatus === "completed" && action.publicationStatus === "completed"));
  const [interruptedAudit] = await pool.query("INSERT INTO product_sync_audits (status,options_json,created_at,error_message) VALUES ('failed',?,UTC_TIMESTAMP(),'Check interrupted')", [JSON.stringify({ enterpriseRevisionId: draft.revisionId })]);
  const interrupted = (await readEnterpriseReviewChecks(pool, [draft.revisionId])).get(draft.revisionId);
  assert.equal(interrupted.auditId, interruptedAudit.insertId);
  assert.equal(interrupted.error, 'Check interrupted');
  assert.deepEqual(interrupted.actions, [], "never fall back to an older successful audit");
  await pool.query("DELETE FROM product_sync_audits WHERE id=?", [interruptedAudit.insertId]);

  assert.deepEqual(writes.map(row => row.platform).sort(), ["localline", "square"]);
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8]);
  assert.equal(square.get("V1").item_variation_data.price_money.amount, 1200);
  const active = await pricing.getEnterprisePricingProduct(1);
  assert.equal(active.active?.id, draft.revisionId);
  const settingsImpact = await pricing.previewPricingSettings({ ...(await pricing.getPricingSettings()), localLineDiscountBp: 500 });
  assert.equal(settingsImpact.affected.find(row => row.productId === 1)?.after.csa, 1140);
  assert.equal(settingsImpact.affected.find(row => row.productId === 1)?.after.square, 1200);
  const migration = await pricing.enterprisePricingMigrationReport({ limit: 10 });
  assert.equal(migration.find(row => row.productId === 1)?.proposedPrice, 10.8);

  const promotions = await import("./enterprisePromotions.js");
  await t.test("FF visibility filters compose with sale and sync filters before pagination", async () => {
    assert.equal((await pricing.listEnterprisePricingProducts({visibility:'visible'})).rows.find(r=>r.id===1).ffVisible,true);
    const untracked=(await pricing.listEnterprisePricingProducts({})).rows.find(r=>r.id===1);
    assert.equal(untracked.ffTrackInventory,false);
    await pool.query('UPDATE products SET track_inventory=1,inventory=5 WHERE id=1');
    const stock=(await pricing.listEnterprisePricingProducts({sort:'inventory'})).rows.find(r=>r.id===1);
    assert.equal(stock.ffTrackInventory,true);assert.equal(stock.ffInventory,5);
    await pool.query('UPDATE products SET track_inventory=0,inventory=0 WHERE id=1');
    await pool.query('UPDATE products SET visible=0 WHERE id=1');
    await pool.query('UPDATE product_sales SET on_sale=1,sale_discount=0.10 WHERE product_id=1');
    assert.equal((await pricing.listEnterprisePricingProducts({visibility:'visible',sale:'on'})).total,0);
    const hidden=await pricing.listEnterprisePricingProducts({visibility:'hidden',sale:'on',limit:1});
    assert.equal(hidden.total,1);assert.equal(hidden.rows[0].ffVisible,false);
    assert.equal((await pricing.listEnterprisePricingProducts({visibility:'hidden',sale:'on',limit:1,offset:1})).rows.length,0);
    assert.equal((await pricing.listEnterprisePricingProducts({visibility:'visible',syncStatus:'square'})).total,0);
    await pool.query('UPDATE products SET visible=1 WHERE id=1');
    await pool.query('UPDATE product_sales SET on_sale=0,sale_discount=0 WHERE product_id=1');
  });
  await t.test("inline sale saves locally, filters, publishes, and turns off without changing regular prices", async () => {
    const {saveProductSale}=await import('./enterpriseProductSales.js');
    process.env.SQUARE_LOCATION_ID='L1';
    const baseline=writes.length;
    await pool.query('UPDATE product_sales SET on_sale=1,sale_discount=0.10 WHERE product_id=1');
    assert.equal((await pricing.listEnterprisePricingProducts({sale:'on'})).rows.find(r=>r.id===1).sale.discountBp,1000);
    assert.equal((await readSavedEnterprisePricing(pool,[1])).get(1).output.packages[0].localLineSaleCents,972);
    await pool.query('UPDATE product_sales SET on_sale=0 WHERE product_id=1');
    await pool.query('UPDATE product_pricing_profiles SET on_sale=1,sale_discount=0.10 WHERE product_id=1');
    assert.equal((await pricing.listEnterprisePricingProducts({sale:'on'})).rows.some(r=>r.id===1),false,'explicit off wins over stale profile flag');
    const saved=await saveProductSale(1,{discountBp:2000,expectedRevision:0,expectedPricingRevision:draft.revisionId},{userId:1});
    assert.equal(writes.length,baseline);
    const listed=(await pricing.listEnterprisePricingProducts({sale:'on'})).rows.find(r=>r.id===1);
    assert.equal(listed.output.packages[0].localLineSaleCents,864);
    assert.equal(listed.output.squareSaleUnitCents,960);
    assert.equal((await pricing.listEnterprisePricingProducts({sale:'off'})).rows.some(r=>r.id===1),false);
    assert.equal((await readSavedEnterprisePricing(pool,[1])).get(1).output.packages[0].localLineSaleCents,864);
    await assert.rejects(saveProductSale(1,{discountBp:1500,expectedRevision:0,expectedPricingRevision:draft.revisionId},{userId:1}),/another window/);
    await promotions.approveEnterprisePromotion(saved.promotionId,{userId:2});
    await promotions.publishEnterprisePromotion(saved.promotionId,{userId:2});
    assert.equal(square.get('V1').item_variation_data.price_money.amount,1200);
    const off=await saveProductSale(1,{discountBp:0,expectedRevision:1,expectedPricingRevision:draft.revisionId},{userId:1});
    assert.equal((await readSavedEnterprisePricing(pool,[1])).get(1).output.packages[0].localLineSaleCents,1080);
    await promotions.approveEnterprisePromotion(off.promotionId,{userId:2});
    await promotions.publishEnterprisePromotion(off.promotionId,{userId:2});
    assert.equal((await promotions.getEnterprisePromotion(saved.promotionId)).status,'cancelled');
    await pool.query('DELETE FROM enterprise_product_sales WHERE product_id=1');
  });
  const saleInput = { name: "Market sausage", discountBp: 2000, packageIds: [10],
    startAt: "2026-11-01T16:00:00Z", endAt: "2026-11-02T16:00:00Z", timezone: "America/Los_Angeles",
    channels: ["localline", "square"], squareLocationIds: ["MARKET"] };
  const sale = await promotions.saveEnterprisePromotionDraft(saleInput, { userId: 1 });
  await assert.rejects(promotions.approveEnterprisePromotion(sale.id, { userId: 1 }), /different/);
  await promotions.approveEnterprisePromotion(sale.id, { userId: 2 });
  const scheduled = await promotions.publishEnterprisePromotion(sale.id, { userId: 2 });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.squareStatus, "verified");
  assert.equal(square.get("V1").item_variation_data.price_money.amount, 1200, "regular Square price stays unchanged");
  const activated = await promotions.publishEnterpriseLocalLinePromotion(sale.id, { userId: 2 }, new Date("2026-11-01T17:00:00Z"));
  assert.equal(activated.status, "active");
  assert.equal(await pricing.enterpriseRevisionMarker(1, draft.revisionId), null, "approved sale freezes regular-price publication");
  assert.equal((await pricing.listEnterprisePricingProducts({ limit: 10 })).rows.find(row => row.id === 1)?.saleStatus, "active");
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [8.64, 8.64, 8.64]);
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.strikethrough_display_value), [10.8, 10.8, 10.8]);
  await assert.rejects(pricing.saveEnterprisePricingDraft(1, { ...active.suggestedInput, priceEffectiveAt: "2026-10-21T12:00:00Z", overrideNote: "cost changed during sale" }, active.latest.id, { userId: 1 }), /Finish or cancel the sale/);
  const expired = await promotions.publishEnterpriseLocalLinePromotion(sale.id, { userId: 2 }, new Date("2026-11-02T17:00:00Z"));
  assert.equal(expired.status, "expired");
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8]);
  const secondSale = await promotions.saveEnterprisePromotionDraft({ ...saleInput, name: "Until turned off", startAt: "2026-11-03T16:00:00Z", endAt: null }, { userId: 1 });
  await promotions.approveEnterprisePromotion(secondSale.id, { userId: 2 });
  await promotions.publishEnterprisePromotion(secondSale.id, { userId: 2 });
  await promotions.publishEnterpriseLocalLinePromotion(secondSale.id, { userId: 2 }, new Date("2026-11-03T17:00:00Z"));
  const future = new Date('2099-12-31T00:00:00Z');
  assert.equal((await promotions.runDueEnterprisePromotions(future)).find(row=>row.id===secondSale.id).status,'active');
  const ongoing = (await readSavedEnterprisePricing(pool,[1],future.getTime())).get(1).output.packages[0];
  assert.equal(ongoing.localLineSaleCents,864);assert.equal(ongoing.squareSaleCents,960);
  assert.equal((await promotions.getEnterprisePromotion(secondSale.id)).input.endAt,null);
  await assert.rejects(promotions.saveEnterprisePromotionDraft({...saleInput,startAt:future.toISOString(),endAt:null},{userId:1}),/overlaps/);
  failNextSaleRestore=true;
  await assert.rejects(promotions.cancelEnterprisePromotion(secondSale.id, { userId: 2 }),/Restore connection interrupted/);
  failNextSaleRestore=false;
  assert.equal((await promotions.getEnterprisePromotion(secondSale.id)).status,'cancelling');
  await assert.rejects(promotions.saveEnterprisePromotionDraft({...saleInput,startAt:future.toISOString(),endAt:null},{userId:1}),/overlaps/);
  assert.equal((await promotions.runDueEnterprisePromotions(future)).find(row=>row.id===secondSale.id).status,'cancelled');
  const cancelled = await promotions.getEnterprisePromotion(secondSale.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.squareStatus, "cancelled");
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8]);
  assert.equal((await readSavedEnterprisePricing(pool,[1],future.getTime())).get(1).output.packages[0].localLineSaleCents,1080);
  assert.equal((await promotions.cancelEnterprisePromotion(secondSale.id,{userId:2})).status,'cancelled','turning off twice is safe');
  const squareOnly = await promotions.saveEnterprisePromotionDraft({ ...saleInput, name: "Square only", channels: ["square"],
    startAt: "2026-11-05T16:00:00Z", endAt: "2026-11-06T16:00:00Z" }, { userId: 1 });
  await promotions.approveEnterprisePromotion(squareOnly.id, { userId: 2 });
  const beforeSquareOnly = writes.filter(row => row.platform === "localline").length;
  assert.equal((await promotions.publishEnterprisePromotion(squareOnly.id, { userId: 2 })).status, "scheduled");
  assert.equal(writes.filter(row => row.platform === "localline").length, beforeSquareOnly);
  assert.equal((await promotions.cancelEnterprisePromotion(squareOnly.id, { userId: 2 })).status, "cancelled");

  const nextInput = { ...active.suggestedInput,
    purchaseCosts: [{ enterpriseId: ffcsa.id, cost: "6.00", effectiveAt: "2026-10-21", documentationRef: "second test transfer" }],
    priceEffectiveAt: "2026-10-21T12:00:00Z" };
  const nextDraft = await pricing.saveEnterprisePricingDraft(1, nextInput, active.latest.id, { userId: 1 });
  assert.equal(await pricing.getApprovedEnterpriseRevision(1, draft.revisionId), null, "a new save invalidates prior channel approval");
  await pricing.approveEnterprisePricingRevision(nextDraft.revisionId, { userId: 2 });
  const secondAudit = await sync.createProductSyncAudit({ platforms: ["localline", "square"], productIds: [1], productScope: "selected", vendorGroup: "all", enterpriseRevisionId: nextDraft.revisionId }, user);
  let secondAuditResult;
  for (let i = 0; i < 100; i += 1) {
    secondAuditResult = await sync.getProductSyncAudit(secondAudit.id);
    if (secondAuditResult.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(secondAuditResult.status, "completed", secondAuditResult.error);
  const secondActions = (await sync.listProductSyncActions(secondAudit.id, { direction: "outgoing", pageSize: 100 })).rows;
  const baselineWrites = writes.length;
  const drifted = structuredClone(square.get("V1"));
  drifted.item_variation_data.price_money.amount = 777;
  square.set("V1", drifted);
  item.item_data.variations = [drifted];
  const secondRelease = await sync.createProductSyncRelease({ auditId: secondAudit.id, actionIds: secondActions.map(row => row.id) }, user);
  const held = await sync.runProductSyncRelease(secondRelease.id, { user, allowFuture: true });
  assert.equal(held.status, "held");
  assert.equal(writes.length, baselineWrites, "Local Line must not publish when Square preflight detects drift");
  assert.equal((await pricing.getEnterprisePricingProduct(1)).active?.id, nextDraft.revisionId, "remote failure does not undo the saved local price");
  const [beforeVendorCheck] = await pool.query("SELECT COUNT(*) AS count FROM enterprise_pricing_revisions");
  await pool.query("UPDATE products SET vendor_id = NULL WHERE id = 1");
  const missingVendor = await pricing.getEnterprisePricingProduct(1);
  assert.equal(missingVendor.product.vendorRequired, true, "details remain accessible so the vendor can be repaired");
  await assert.rejects(pricing.previewEnterprisePricing(1, nextInput), /needs a vendor/);
  await assert.rejects(pricing.saveEnterprisePricingDraft(1, nextInput, nextDraft.revisionId, { userId: 1 }), /needs a vendor/);
  await assert.rejects(pricing.saveEnterpriseBuyPrice(1, "7.00", nextDraft.revisionId, { userId: 1 }), /needs a vendor/);
  const [afterVendorCheck] = await pool.query("SELECT COUNT(*) AS count FROM enterprise_pricing_revisions");
  assert.equal(afterVendorCheck[0].count, beforeVendorCheck[0].count, "blocked edits create no pricing history");
  assert.equal(writes.length, baselineWrites, "vendor checks never publish");
  await pool.query("UPDATE products SET vendor_id = 1 WHERE id = 1");
  assert.equal((await pricing.getEnterprisePricingProduct(1)).product.vendorRequired, false);
  await t.test("new enterprise products save atomically, recover retries, and support weighted third-party pricing", async () => {
    const creation = await import("./enterpriseProductCreation.js");
    await pool.query("INSERT INTO vendors (id,name) VALUES (2,'Test Produce Vendor')");
    const enterpriseId = (await pricing.listPricingEnterprises())[0].id;
    const body = { product: { name: "Test Shallots", vendorId: 2, categoryId: 1, description: "Farm produce", excludeFromSnap: true, excludeFromGuest: false },
      input: { retailEnterpriseId: enterpriseId, priceEffectiveAt: "2026-01-02T00:00:00Z", pricingUnit: "lb",
        markupCategory: "perishable", customMarkupBp: null, squareEnabled: false, saleBp: 0,
        purchaseCosts: [{ enterpriseId, cost: "2.00", effectiveAt: "2026-01-01" }],
        packages: [{ packageId: 1, name: "1–2 lb bag", minWeight: 1, maxWeight: 2 }, { packageId: 2, name: "3 lb bag", avgWeightOverride: 3 }],
        wholesale: [{ sellingEnterpriseId: enterpriseId, mode: "markup", markupBp: 2500, costEnterpriseId: enterpriseId }] },
      creationKey: "test-weighted-product-create" };
    const preview = await creation.previewEnterpriseProductCreation(body);
    body.previewHash = preview.previewHash;
    assert.equal(preview.output.squareUnitCents, null);
    assert.equal(preview.output.csaUnitCents, 330);
    assert.equal(preview.output.packages[0].localLineRegularCents, 495);
    const writesBefore = writes.length;
    const [created, retry] = await Promise.all([creation.createEnterpriseProduct(body, { userId: 1 }), creation.createEnterpriseProduct(body, { userId: 1 })]);
    assert.equal(created.productId, retry.productId);
    const saved = await pricing.getEnterprisePricingProduct(created.productId);
    assert.equal(saved.active.id, created.revisionId);
    assert.equal(saved.active.input.pricingUnit, "lb");
    assert.equal(saved.active.output.wholesale[0].priceCents, 250);
    assert.equal(saved.active.output.packages[0].localLineRegularCents, 495);
    assert.equal(saved.active.approverId ?? null, null);
    const [[catalog]] = await pool.query("SELECT * FROM products WHERE id=?", [created.productId]);
    assert.equal(catalog.visible, 0); assert.equal(catalog.inventory, 0); assert.equal(catalog.track_inventory, 0);
    assert.equal(catalog.stock_on_farm, null); assert.equal(catalog.stock_on_farm_lbs, null);
    assert.equal(catalog.exclude_from_snap, 1); assert.equal(catalog.exclude_from_guest, 0);
    const exclusions = await pricing.listEnterprisePricingProducts({ snapEligibility: 'excluded', guestEligibility: 'included', search: 'Test Shallots', limit: 1 });
    assert.equal(exclusions.total, 1); assert.equal(exclusions.rows[0].excludeFromSnap, true);
    assert.equal((await pricing.listEnterprisePricingProducts({snapEligibility:'included',search:'Test Shallots'})).total, 0);
    const [packages] = await pool.query("SELECT * FROM packages WHERE product_id=? ORDER BY id", [created.productId]);
    assert.deepEqual(packages.map(row => Number(row.price)), [3, 6]);
    assert.deepEqual(packages.map(row => row.id), saved.active.input.packages.map(row => row.packageId));
    assert.ok(packages.every(row => row.visible === 0 && row.package_code === null));
    assert.equal((await pool.query("SELECT COUNT(*) n FROM enterprise_purchase_cost_history WHERE product_id=?", [created.productId]))[0][0].n, 1);
    assert.equal((await pool.query("SELECT COUNT(*) n FROM square_variation_links WHERE product_id=?", [created.productId]))[0][0].n, 0);
    assert.equal((await pool.query("SELECT local_line_product_id FROM local_line_product_meta WHERE product_id=?", [created.productId]))[0][0].local_line_product_id, 0);
    await assert.rejects(creation.createEnterpriseProduct({ ...body, product: { ...body.product, name: "Changed" } }, { userId: 1 }), /already used/);
    await assert.rejects(creation.createEnterpriseProduct(body, { userId: 2 }), /already used/);
    await assert.rejects(creation.createEnterpriseProduct({ ...body, creationKey: "test-stale-preview-create", previewHash: "stale" }, { userId: 1 }), /rules changed/);
    await assert.rejects(creation.previewEnterpriseProductCreation({ ...body, product: { ...body.product, vendorId: 999 } }), /vendor/);
    await assert.rejects(creation.previewEnterpriseProductCreation({ ...body, product: { ...body.product, name: "Deposit" } }), /deposit pricing/);
    await assert.rejects(creation.previewEnterpriseProductCreation({ ...body, input: { ...body.input, saleBp: 2000 } }), /separately approved/);
    const each = { ...body, creationKey: "test-each-product-create", product: { ...body.product, vendorId: 1, name: "Test Sausage" },
      input: { ...body.input, pricingUnit: "each", squareEnabled: true, markupCategory: "deckHyland", packages: [{ packageId: 1, name: "12 oz", quantity: 1 }] } };
    each.previewHash = (await creation.previewEnterpriseProductCreation(each)).previewHash;
    // Force a late SQL failure after catalog/packages/revision have been inserted.
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM products");
    await pool.query("CREATE TRIGGER test_fail_cost BEFORE INSERT ON enterprise_purchase_cost_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test late creation failure'");
    await assert.rejects(creation.createEnterpriseProduct(each, { userId: 1 }), /test late creation failure/);
    await pool.query("DROP TRIGGER test_fail_cost");
    assert.equal((await pool.query("SELECT COUNT(*) n FROM products"))[0][0].n, before.n);
    assert.equal((await pool.query("SELECT COUNT(*) n FROM enterprise_product_creations WHERE creation_key=?", [each.creationKey]))[0][0].n, 0);
    const eachSaved = await creation.createEnterpriseProduct(each, { userId: 1 });
    const eachDetail = await pricing.getEnterprisePricingProduct(eachSaved.productId);
    assert.equal(eachDetail.active.output.squareUnitCents, 350);
    assert.equal(eachDetail.active.output.csaUnitCents, 315);
    assert.equal(eachDetail.active.output.packages[0].localLineRegularCents, 315);
    assert.equal(eachDetail.active.input.packages[0].quantity, 1, "12 oz is descriptive, not a pound conversion");
    const packBody={...body,creationKey:'test-package-buy-prices',product:{...body.product,name:'Test distinct pack costs'},input:{...body.input,pricingUnit:'each',markupCategory:'shelfStable',squareEnabled:false,
      packages:[{packageId:1,name:'2 pack',quantity:1,packageBuyPrice:'3.00'},{packageId:2,name:'5 pack',quantity:1,packageBuyPrice:'5.00'}]}};
    packBody.previewHash=(await creation.previewEnterpriseProductCreation(packBody)).previewHash;
    const packSaved=await creation.createEnterpriseProduct(packBody,{userId:1});
    const packDetail=await pricing.getEnterprisePricingProduct(packSaved.productId);
    assert.deepEqual(packDetail.active.output.packages.map(p=>p.localLineRegularCents),[450,750]);
    assert.deepEqual((await pool.query('SELECT price FROM packages WHERE product_id=? ORDER BY id',[packSaved.productId]))[0].map(p=>Number(p.price)),[3,5]);
    const edited=await pricing.saveEnterprisePricingDraft(packSaved.productId,{...packDetail.active.input,customMarkupBp:10000},packDetail.latest.id,{userId:1},packDetail.buyPrice.revision);
    assert.deepEqual(edited.output.packages.map(p=>p.localLineRegularCents),[600,1000]);
    assert.equal(edited.input.packages[1].packageBuyPrice,'5.00');
    const {readSavedEnterprisePricing:readPackages}=await import('./enterprisePricingReads.js');
    assert.equal((await readPackages(pool,[packSaved.productId])).get(packSaved.productId).output.packages[1].localLineRegularCents,1000);
    assert.equal(writes.length, writesBefore, "creation never calls either channel");
    const { default: express } = await import("express");
    const { default: router } = await import("../routes/enterprisePricing.js");
    const { default: adminRouter } = await import("../routes/admin.js");
    const app = express(); app.use(express.json()); app.use((req,res,next) => { req.admin = { userId: 1, adminRoles: [req.headers['x-test-role'] || 'pricing_publisher'] }; next(); }); app.use("/admin",adminRouter); app.use(router);
    const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const response = await nativeFetch(`${url}/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(each) });
      assert.equal(response.status, 403, "a publisher cannot create products");
      const permitted = await nativeFetch(`${url}/products`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-role": "pricing_editor" }, body: JSON.stringify(each) });
      assert.equal(permitted.status, 200); assert.equal((await permitted.json()).productId, eachSaved.productId);
      const editBasket = (body,role='pricing_editor') => nativeFetch(`${url}/admin/products/${created.productId}`, {method:'PUT',headers:{'Content-Type':'application/json','x-test-role':role},body:JSON.stringify(body)});
      assert.equal((await editBasket({excludeFromGuest:true},'pricing_publisher')).status,403);
      assert.equal((await editBasket({excludeFromGuest:'true'})).status,400);
      assert.equal((await editBasket({excludeFromGuest:true})).status,409);
      const basketSaved=await editBasket({excludeFromGuest:true,expectedBasketEligibility:{excludeFromGuest:false,excludeFromSnap:true}});
      assert.equal(basketSaved.status,200,await basketSaved.text());
      assert.equal((await editBasket({excludeFromGuest:false,expectedBasketEligibility:{excludeFromGuest:false,excludeFromSnap:true}})).status,409);
      assert.equal((await editBasket({name:'Renamed shallots'})).status,200);
      const [[basketRow]]=await pool.query('SELECT exclude_from_guest,exclude_from_snap FROM products WHERE id=?',[created.productId]);
      assert.equal(basketRow.exclude_from_guest,1);assert.equal(basketRow.exclude_from_snap,1);
      assert.equal(writes.length,writesBefore,'Editing basket exclusions never publishes');

    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('Local Line-only prices include sales, preserve inventory, freeze sale edits, and never publish Square', async () => {
    await pool.query("INSERT INTO price_lists (local_line_price_list_id,name) VALUES (1,'Guest Basket'),(3,'Herd Share Members'),(4,'SNAP')");
    await pool.query('DELETE FROM local_line_price_list_entries WHERE product_id=1');
    await pool.query("UPDATE enterprise_promotions SET status='cancelled'");
    await pool.query("UPDATE product_sync_release_actions SET status='cancelled' WHERE status IN ('pending','working','failed','held')");
    const current = await pricing.getEnterprisePricingProduct(1);
    const draft = await pricing.saveEnterprisePricingDraft(1, { ...(current.latest || current.active).input, priceEffectiveAt: '2026-10-21',
      squareEnabled: true, saleBp: 0 }, current.latest.id, { userId: 1 });
    const { saveProductSale } = await import('./enterpriseProductSales.js');
    const [[saleState]] = await pool.query('SELECT revision FROM enterprise_product_sales WHERE product_id=1');
    await saveProductSale(1, {discountBp:1000, expectedRevision:Number(saleState?.revision||0), expectedPricingRevision:draft.revisionId}, {userId:1});
    // Historical disabled sale discounts must not fabricate staged local drift.
    await pool.query('UPDATE product_sales SET sale_discount=NULL,on_sale=0 WHERE product_id=1');
    await pool.query('UPDATE product_pricing_profiles SET sale_discount=0.1,on_sale=0 WHERE product_id=1');
    const express = (await import('express')).default;
    const router = (await import('../routes/enterprisePricing.js')).default;
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.admin = {userId:Number(req.headers['x-test-user'] || 2),
      adminRoles: String(req.headers['x-test-roles'] || '').split(',')}; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const approve = (roles, actor=2) => nativeFetch(`http://127.0.0.1:${server.address().port}/revisions/${draft.revisionId}/approve-localline`,
        {method:'POST',headers:{'x-test-roles':roles,'x-test-user':String(actor)}});
      assert.equal((await approve('pricing_editor,localline_push')).status,403);
      assert.equal((await approve('pricing_publisher')).status,403);
      assert.equal((await approve('pricing_publisher,localline_push',1)).status,403, 'separation of duties still applies');
      assert.equal((await approve('pricing_publisher,localline_push')).status,200);
    } finally { await new Promise(resolve => server.close(resolve)); }
    const popup = await pricing.getEnterprisePricingSync(1);
    assert.equal(popup.sale.discountBp, 1000);
    assert.equal(popup.revisionStatus, 'approved');
    assert.equal(popup.syncBlocker, null);
    assert.ok(popup.comparison.filter(row => row.destination === 'Local Line').every(row =>
      row.localCents === Math.round(popup.output.packages[0].localLineRegularCents * 0.9)), 'popup includes the saved sale');
    assert.ok(popup.comparison.filter(row => row.destination === 'Square').every(row =>
      row.localCents === popup.output.squareUnitCents), 'Local Line sync does not discount Square catalog prices');
    const opts = {platforms:['localline'], productIds:[1], productScope:'selected', vendorGroup:'all',
      enterpriseRevisionId:draft.revisionId, publicationScope:'localline-prices-and-sales'};
    await assert.rejects(sync.createProductSyncAudit({...opts,platforms:['square']},user), /Local Line only/);
    const check = async () => {
      const a = await sync.createProductSyncAudit(opts,user);
      for(let i=0;i<100;i++){if((await sync.getProductSyncAudit(a.id)).status!=='running')break; await new Promise(r=>setTimeout(r,20));}
      const rows=(await sync.listProductSyncActions(a.id, {})).rows;
      assert.equal(rows.length,1); assert.equal(rows[0].platform,'localline');
      assert.ok(['changed','synced'].includes(rows[0].status), rows[0].message);
      return {a,rows};
    };
    const before = writes.length;
    remote.inventory=7; remote.track_inventory=true; remote.visible=false; remote.description='Remote description';
    let {a,rows}=await check();
    assert.deepEqual(Object.keys(rows[0].payload).sort(),['packages','vendor']);
    assert.equal(rows[0].imageSources.length,0);
    assert.deepEqual(rows[0].localBefore,rows[0].localAfter,'a price-only release stages no legacy sale normalization');
    assert.ok(rows[0].payload.packages[0].price_list_entries.every(e=>e.on_sale_toggle===true));
    const r=await sync.createProductSyncRelease({auditId:a.id,actionIds:rows.map(a=>a.id),localWorkerOnly:true},user);
    assert.match((await sync.getProductSyncRelease(r.id)).scheduledAt,/^9999/);
    const done=await sync.runProductSyncRelease(r.id,{user,allowFuture:true});
    assert.equal(done.status,'completed',JSON.stringify(done.actions.map(a=>a.message)));
    assert.equal(Number((await pricing.getEnterprisePricingSync(1)).latestLocalLineReleaseId), r.id, 'popup can recover a durable receipt after closing');
    const [[cached]] = await pool.query('SELECT COUNT(*) AS count FROM local_line_price_list_entries WHERE product_id=1');
    assert.equal(cached.count,3,'Repeated checks create missing cache rows once per active basket');
    const table = await pricing.listEnterprisePricingProducts({search:'Sausage 12 oz'});
    const product = table.rows.find(row=>row.id===1);
    assert.equal(product.sync.channels.find(c=>c.platform==='localline').state,'matched','Table shows Local Line success after cache repair');
    assert.ok(writes.slice(before).every(w=>w.platform==='localline'));
    assert.equal(remote.inventory,7);assert.equal(remote.visible,false);assert.equal(remote.description,'Remote description');
    const [[publication]]=await pool.query("SELECT status FROM enterprise_pricing_publications WHERE revision_id=? AND platform='square'",[draft.revisionId]);
    assert.equal(publication.status,'pending');
    const [[sale]]=await pool.query("SELECT p.status,p.square_status,p.localline_status FROM enterprise_product_sales s JOIN enterprise_promotions p ON p.id=s.promotion_id WHERE s.product_id=1");
    assert.equal(sale.status,'pending');assert.notEqual(sale.square_status,'verified');assert.equal(sale.localline_status,'active');
    assert.equal((await sync.runProductSyncRelease(r.id,{user,allowFuture:true})).status,'completed');
    ({a,rows}=await check());
    const stale=await sync.createProductSyncRelease({auditId:a.id,actionIds:rows.map(a=>a.id),localWorkerOnly:true},user);
    await pool.query('UPDATE enterprise_product_sales SET discount_bp=2000,revision=revision+1 WHERE product_id=1');
    const held=await sync.runProductSyncRelease(stale.id,{user,allowFuture:true});
    assert.equal(held.status,'held');
    assert.match(held.actions[0].message,/Local inputs changed/);
  });

});
