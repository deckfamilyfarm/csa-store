import { test } from "node:test";
import assert from "node:assert/strict";
import { auditVendorGroup, auditProductScope, auditProducts, scopeLocalLineCatalogs } from "./productSyncScope.js";

const catalog = [
  { id: 1, vendorName: "Deck Family Farm" },
  { id: 2, vendorName: "Creamy Cow, LLC" },
  { id: 3, vendorName: "Hyland Artisanal Meats" },
  { id: 4, vendorName: "Other farm" },
  { id: 5, vendorName: "Deck Family Farm", categoryName: " Membership " },
  { id: 6, vendorName: null }
];
test("an empty pending or selected audit cannot become a full-catalog audit", () => {
  assert.throws(() => auditProductScope({ productScope: "pending" }, []), /no products/);
  assert.throws(() => auditProductScope({ productScope: "selected" }, []), /no products/);
  assert.equal(auditProductScope({ productScope: "pending" }, [1, 2]), "pending");
  assert.equal(auditProductScope({}, [1]), "selected");
  assert.equal(auditProductScope({}, []), "all", "Existing API clients retain their full-catalog audits");
  assert.throws(() => auditProductScope({ productScope: "all" }, [1]), /cannot include/);
});
test("audits default to the complete Deck Enterprises group and intersect product selections", () => {
  assert.equal(auditVendorGroup(), "deck-enterprises");
  assert.deepEqual(auditProducts(catalog).map(row => row.id), [1, 2, 3]);
  assert.deepEqual(auditProducts(catalog, { productIds: [2, 4, 5] }).map(row => row.id), [2]);
  assert.deepEqual(auditProducts(catalog, { productIds: [4] }), []);
  assert.deepEqual(auditProducts(catalog, { vendorGroup: "all" }).map(row => row.id), [1, 2, 3, 4, 6]);
  assert.equal(auditVendorGroup({ includeAllProducts: true }), "all", "Historical release reviews retain their selected vendors");
  assert.throws(() => auditVendorGroup({ vendorGroup: "typo" }), /Choose/);
});
test("incoming comparison scopes both catalogs using remote links, without false missing-product proposals", () => {
  const storeCatalog = { products: catalog, packages: [{ productId: 1 }, { productId: 2 }, { productId: 4 }],
    productMetaRows: [{ productId: 1, localLineProductId: 101 }, { productId: 4, localLineProductId: 104 }],
    packageMetaRows: [{ productId: 1 }, { productId: 4 }] };
  const exportCatalog = { productsById: new Map([1, 2, 101, 104, 999].map(id => [id, { productId: id }])),
    packagesByProductId: new Map([1, 2, 101, 104, 999].map(id => [id, [{ productId: id }]])), productCount: 5, packageCount: 5 };
  const result = scopeLocalLineCatalogs(exportCatalog, storeCatalog, [1, 2]);
  assert.deepEqual([...result.exportCatalog.productsById.keys()], [2, 101]);
  assert.deepEqual(result.storeCatalog.products.map(row => row.id), [1, 2]);
  assert.equal(result.exportCatalog.packageCount, 2);
  assert.equal(result.storeCatalog.packages.length, 2);
  assert.equal(result.storeCatalog.productMetaRows.length, 1);
  assert.equal(result.storeCatalog.packageMetaRows.length, 1);
  const empty = scopeLocalLineCatalogs(exportCatalog, storeCatalog, []);
  assert.equal(empty.exportCatalog.productCount, 0);
  assert.equal(empty.storeCatalog.products.length, 0);
  assert.equal(scopeLocalLineCatalogs(exportCatalog, storeCatalog).exportCatalog, exportCatalog);
  assert.equal(scopeLocalLineCatalogs(exportCatalog, storeCatalog, [999]).exportCatalog.productCount, 1, "Approved missing local creates can be rechecked");
});
