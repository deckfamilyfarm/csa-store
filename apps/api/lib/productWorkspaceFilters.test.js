import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildPricelistWhereClause } from "./productWorkspaceFilters.js";

function matches(filters) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE products (id INT, name TEXT, vendor_id INT, category_id INT, visible INT, is_deleted INT);
    CREATE TABLE vendors (id INT, name TEXT);
    CREATE TABLE product_sales (product_id INT, on_sale INT);
    CREATE TABLE product_pricing_profiles (product_id INT, remote_sync_status TEXT, updated_at TEXT, remote_synced_at TEXT);
    CREATE TABLE local_line_product_meta (product_id INT, local_line_product_id INT, visible INT);
    INSERT INTO vendors VALUES (1, 'Deck Family Farm'), (2, 'Creamy Cow'), (3, 'Hyland Processing'), (4, 'Other');
    INSERT INTO products VALUES (1,'Sausage',1,2,1,0),(2,'Jar deposit',2,2,0,0),(3,'Chops',3,2,1,0),(4,'Bread',4,2,NULL,0),(5,'Membership',4,9,1,0),(6,'Removed',1,2,1,1);
    INSERT INTO product_sales VALUES (1,1);
    INSERT INTO product_pricing_profiles VALUES (1,'pending','2026-01-02',NULL),(3,'failed','2026-01-02',NULL),(4,'applied','2026-01-01','2026-01-02');
    INSERT INTO local_line_product_meta VALUES (1,100,NULL),(2,0,NULL),(3,103,NULL),(4,104,1),(5,105,NULL),(6,106,NULL);`);
  const query = buildPricelistWhereClause({
    membershipCategoryIds: [9],
    ...filters,
  });
  // mysql2 expands arrays; these fixtures use one Membership category for SQLite.
  const params = query.params.map((value) =>
    Array.isArray(value) ? value[0] : value,
  );
  try {
    return db
      .prepare(
        `SELECT p.id FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id
      LEFT JOIN product_sales ps ON ps.product_id=p.id
      LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id ${query.whereSql} ORDER BY p.id`,
      )
      .all(...params)
      .map((row) => row.id);
  } finally {
    db.close();
  }
}

test("default catalog includes every vendor and excludes Membership and deleted products", () => {
  assert.deepEqual(matches({}), [1, 2, 3, 4]);
});
test("visibility, sale and pricing filters compose with existing vendor/category filters", () => {
  assert.deepEqual(matches({ pricingType: "formula" }), [1, 2, 3]);
  assert.deepEqual(
    matches({
      pricingType: "formula",
      visibility: "visible",
      saleFilter: "onSale",
    }),
    [1],
  );
  assert.deepEqual(matches({ pricingType: "standard" }), [4]);
  assert.deepEqual(
    matches({ pricingType: "deposit", visibility: "hidden" }),
    [2],
  );
  assert.deepEqual(matches({ vendorId: 3, categoryId: 2 }), [3]);
  assert.deepEqual(matches({ vendorId: 4, visibility: "visible" }), [4]);
  assert.deepEqual(matches({ vendorId: 4, visibility: "hidden" }), []);
});
test("pending review includes new products without a pricing profile and failed updates", () => {
  assert.deepEqual(matches({ statusFilter: "needsApply" }), [1, 2, 3]);
  assert.deepEqual(matches({ statusFilter: "local-only" }), [2]);
  assert.deepEqual(matches({ statusFilter: "applied" }), [4]);
});
test("Deck Enterprises limits both products and pending review to its three vendors", () => {
  assert.deepEqual(matches({ vendorGroup: "deck-enterprises" }), [1, 2, 3]);
  assert.deepEqual(matches({ vendorGroup: "deck-enterprises", statusFilter: "needsApply" }), [1, 2, 3]);
  assert.deepEqual(matches({ vendorGroup: "deck-enterprises", vendorId: 4 }), []);
});
test("search remains a bound value even when it contains SQL punctuation", () => {
  assert.deepEqual(matches({ search: "Sausage" }), [1]);
  assert.deepEqual(matches({ search: "' OR 1=1 --" }), []);
});
