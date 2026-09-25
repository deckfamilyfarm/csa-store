import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localLinePackageMeta,
  localLineProductMeta,
  packages,
  productImages,
  productMedia,
  productPricingProfiles,
  products,
  productSales,
  vendors
} from "./schema.js";

process.env.LL_BASEURL = "https://localline.test/api/backoffice/v2/";
process.env.LL_USERNAME = "test-user";
process.env.LL_PASSWORD = "test-password";
process.env.LL_PRICE_LIST_GUEST_ID = "1";
process.env.LOCALLINE_TEST = "false";
process.env.LOCALLINE_UPDATE_PRICES = "true";

const { createLocalLineProductFromStoreProduct, updateLocalLineForProduct } = await import("./localLine.js");

// One local product, with independent local and remote package IDs. Writes update
// the in-memory records so retries exercise the persisted link, not a fixed mock.
function fixture(t, { linked = false, images = false } = {}) {
  const records = new Map([
    [products, [{ id: 42, name: "Test Sausage", vendorId: 1, visible: 1, trackInventory: 0, inventory: 0 }]],
    [vendors, [{ id: 1, name: "Deck Family Farm" }]],
    [packages, [{ id: 43, productId: 42, name: "ea", unit: "ea", numOfItems: 1, price: "12.00" }]],
    [productPricingProfiles, [{ productId: 42, sourceUnitPrice: "10.00", sourceMultiplier: "1.2", unitOfMeasure: "each" }]],
    [productSales, []],
    [localLineProductMeta, [{ productId: 42, localLineProductId: linked ? 9001 : 0 }]],
    [localLinePackageMeta, linked ? [{ productId: 42, packageId: 43, localLinePackageId: 9002 }] : []],
    [productMedia, []],
    [productImages, images ? [{ productId: 42, url: "https://images.test/sausage.jpg" }] : []]
  ]);
  const db = {
    select: () => ({ from: (table) => ({ where: async () => structuredClone(records.get(table) || []) }) }),
    update: (table) => ({ set: (values) => ({ where: async () => {
      for (const row of records.get(table) || []) Object.assign(row, values);
    } }) }),
    insert: (table) => ({ values: async (values) => {
      records.set(table, [...(records.get(table) || []), values]);
    } })
  };
  const remoteProduct = {
    id: 9001,
    name: "Test Sausage",
    visible: true,
    track_inventory: false,
    packages: [{ id: 9002, name: "ea", unit_price: "12.00" }],
    product_price_list_entries: [{ id: 7001, price_list: 1 }]
  };
  const failures = {};
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const method = options.method || "GET";
    const path = new URL(url).pathname;
    const payload = typeof options.body === "string" ? JSON.parse(options.body) : null;
    requests.push({ method, path, payload });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (path.endsWith("/token/")) return json({ access: "test-token" });
    if (path.endsWith("/product-units/")) {
      return json({ results: [{ id: 1, name: "Each", abbrieviation: "ea", unit_type: "item" }] });
    }
    if (path.endsWith("/products/") && method === "POST") {
      if (failures.createNetwork) throw new Error("Connection lost");
      if (failures.create) return json({ name: ["Product rejected"] }, 400);
      return json(remoteProduct, 201);
    }
    if (path.endsWith("/products/9001/")) {
      if (method === "GET") {
        if (failures.read) return json({ detail: "Temporary read failure" }, 503);
        return json(remoteProduct);
      }
      if (method === "PATCH") {
        if (payload.packages && failures.price) return json({ detail: "Pricing rejected" }, 400);
        if (Object.hasOwn(payload, "visible")) remoteProduct.visible = failures.visibility ? false : payload.visible;
        if (Object.hasOwn(payload, "track_inventory")) remoteProduct.track_inventory = payload.track_inventory;
        return json(remoteProduct);
      }
    }
    if (path === "/sausage.jpg") return new Response("image bytes");
    if (path.endsWith("/product-images/") && method === "POST") {
      if (failures.image) return json({ detail: "Image rejected" }, 400);
      return json({ id: 8001 }, 201);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return { db, records, requests, failures, remoteProduct };
}

const productCreates = (requests) => requests.filter((r) => r.method === "POST" && r.path.endsWith("/products/"));

test("a local-only product is created, linked and priced using remote package IDs", async (t) => {
  const { db, records, requests } = fixture(t);
  const originalPricing = structuredClone(records.get(productPricingProfiles));
  const result = await createLocalLineProductFromStoreProduct(db, 42);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyLinked, false);
  assert.equal(result.localLineProductId, 9001);
  assert.equal(result.priceOk, true);
  assert.equal(productCreates(requests).length, 1);
  assert.equal(records.get(localLineProductMeta)[0].localLineProductId, 9001);
  assert.equal(records.get(localLinePackageMeta)[0].localLinePackageId, 9002);
  const priceRequest = requests.find((r) => r.method === "PATCH" && r.payload.packages);
  assert.equal(priceRequest.payload.packages[0].id, 9002);
  assert.deepEqual(records.get(productPricingProfiles), originalPricing);
});

test("an already-linked product is updated without creating a duplicate", async (t) => {
  const { db, requests } = fixture(t, { linked: true });
  const result = await createLocalLineProductFromStoreProduct(db, 42);
  assert.equal(result.alreadyLinked, true);
  assert.equal(result.localLineProductId, 9001);
  assert.equal(result.priceOk, true);
  assert.equal(productCreates(requests).length, 0);
});

test("Local Line create rejection is surfaced and leaves the product unlinked", async (t) => {
  const { db, records, failures } = fixture(t);
  failures.create = true;
  await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), /POST failed: 400.*Product rejected/);
  assert.equal(records.get(localLineProductMeta)[0].localLineProductId, 0);
});

test("an uncertain create response is not automatically retried", async (t) => {
  const { db, requests, failures } = fixture(t);
  failures.createNetwork = true;
  await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), /Check Local Line for the product before retrying/);
  assert.equal(productCreates(requests).length, 1);
});

for (const [failure, expected] of [
  ["read", /503.*Temporary read failure/],
  ["price", /400.*Pricing rejected/],
  ["image", /400.*Image rejected/],
  ["visibility", /visibility\/inventory/]
]) {
  test(`a post-create ${failure} failure is reported and a retry reuses the link`, async (t) => {
    const { db, records, requests, failures } = fixture(t, { images: failure === "image" });
    failures[failure] = true;
    await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), (error) => {
      assert.match(error.message, /Local Line product 9001 was created, but completing the push failed/);
      assert.match(error.message, expected);
      return true;
    });
    assert.equal(records.get(localLineProductMeta)[0].localLineProductId, 9001);
    failures[failure] = false;
    const result = await createLocalLineProductFromStoreProduct(db, 42);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyLinked, true);
    assert.equal(productCreates(requests).length, 1);
  });
}

test("missing price-list matches cannot be reported as a successful push", async (t) => {
  const { db, remoteProduct } = fixture(t, { linked: true });
  remoteProduct.product_price_list_entries = [];
  await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), /No matching Local Line package price-list entries/);
});

test("the update-only path fails clearly for an unlinked product", async (t) => {
  const { db, requests } = fixture(t);
  await assert.rejects(updateLocalLineForProduct(db, 42, { forcePriceSync: true }), /only exists locally/);
  assert.equal(requests.length, 0);
});

test("database link read errors cannot trigger remote creation", async (t) => {
  const { db, requests } = fixture(t);
  const originalSelect = db.select;
  db.select = () => ({ from: (table) => table === localLineProductMeta
    ? { where: async () => { throw new Error("Database unavailable"); } }
    : originalSelect().from(table)
  });
  await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), /Database unavailable/);
  assert.equal(productCreates(requests).length, 0);
});

test("missing authentication is reported before any remote request", async (t) => {
  const { db, requests } = fixture(t);
  const username = process.env.LL_USERNAME;
  delete process.env.LL_USERNAME;
  try {
    await assert.rejects(createLocalLineProductFromStoreProduct(db, 42), /authentication is not configured/);
    await assert.rejects(updateLocalLineForProduct(db, 42), /authentication is not configured/);
    assert.equal(requests.length, 0);
  } finally {
    process.env.LL_USERNAME = username;
  }
});

test("test mode never claims a real product was pushed", async (t) => {
  const { db, requests } = fixture(t);
  process.env.LOCALLINE_TEST = "true";
  const previewModule = await import("./localLine.js?test-mode");
  process.env.LOCALLINE_TEST = "false";
  await assert.rejects(previewModule.createLocalLineProductFromStoreProduct(db, 42), /test mode is enabled/);
  assert.equal(requests.length, 0);
});

test("disabled price updates fail before creating a remote product", async (t) => {
  const { db, requests } = fixture(t);
  process.env.LOCALLINE_UPDATE_PRICES = "false";
  const disabledModule = await import("./localLine.js?prices-disabled");
  process.env.LOCALLINE_UPDATE_PRICES = "true";
  await assert.rejects(disabledModule.createLocalLineProductFromStoreProduct(db, 42), /price updates are disabled/);
  assert.equal(requests.length, 0);
});
