import { test } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../schema.js";

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
    schema.localLinePackageMeta, schema.localLinePriceListEntries, schema.users]) {
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
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url), method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
    assert.ok(["localline.test", "square.test"].includes(parsed.hostname));
    const json = value => new Response(JSON.stringify(value), { status: 200 });
    if (parsed.pathname.endsWith("/token/")) return json({ access: "test" });
    if (parsed.pathname.endsWith("/vendors/")) return json({ results: [{ id: 101, name: "Deck Family Farm" }] });
    if (parsed.pathname.endsWith("/vendors/101/")) return json({ id: 101, name: "Deck Family Farm" });
    if (parsed.pathname.endsWith("/products/1001/")) {
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
  const release = await sync.createProductSyncRelease({ auditId: audit.id, actionIds: actions.map(row => row.id) }, user);
  const finished = await sync.runProductSyncRelease(release.id, { user, allowFuture: true });
  assert.equal(finished.status, "completed");
  assert.deepEqual(writes.map(row => row.platform).sort(), ["localline", "square"]);
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8, 10.8]);
  assert.equal(square.get("V1").item_variation_data.price_money.amount, 1200);
  const active = await pricing.getEnterprisePricingProduct(1);
  assert.equal(active.active?.id, draft.revisionId);
  const settingsImpact = await pricing.previewPricingSettings({ ...(await pricing.getPricingSettings()), localLineDiscountBp: 500 });
  assert.equal(settingsImpact.affected.find(row => row.productId === 1)?.after.csa, 1140);
  assert.equal(settingsImpact.affected.find(row => row.productId === 1)?.after.square, 1200);
  const migration = await pricing.enterprisePricingMigrationReport({ limit: 10 });
  assert.equal(migration.find(row => row.productId === 1)?.proposedPrice, 10.8);

  const promotions = await import("./enterprisePromotions.js");
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
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [8.64, 8.64, 8.64, 8.64]);
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.strikethrough_display_value), [10.8, 10.8, 10.8, 10.8]);
  await assert.rejects(pricing.saveEnterprisePricingDraft(1, { ...active.suggestedInput, priceEffectiveAt: "2026-10-21T12:00:00Z", overrideNote: "cost changed during sale" }, active.latest.id, { userId: 1 }), /Finish or cancel the sale/);
  const expired = await promotions.publishEnterpriseLocalLinePromotion(sale.id, { userId: 2 }, new Date("2026-11-02T17:00:00Z"));
  assert.equal(expired.status, "expired");
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8, 10.8]);
  const secondSale = await promotions.saveEnterprisePromotionDraft({ ...saleInput, name: "Cancelled market sale", startAt: "2026-11-03T16:00:00Z", endAt: "2026-11-04T16:00:00Z" }, { userId: 1 });
  await promotions.approveEnterprisePromotion(secondSale.id, { userId: 2 });
  await promotions.publishEnterprisePromotion(secondSale.id, { userId: 2 });
  await promotions.publishEnterpriseLocalLinePromotion(secondSale.id, { userId: 2 }, new Date("2026-11-03T17:00:00Z"));
  const cancelled = await promotions.cancelEnterprisePromotion(secondSale.id, { userId: 2 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.squareStatus, "cancelled");
  assert.deepEqual(remote.packages[0].price_list_entries.map(row => row.adjustment_value), [10.8, 10.8, 10.8, 10.8]);
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
});
