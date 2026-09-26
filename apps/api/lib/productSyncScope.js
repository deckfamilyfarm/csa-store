import { isSourcePricingVendor } from "./productPricing.js";
import { fail } from "./productSyncCore.js";

export function auditVendorGroup(options = {}) {
  const group = options.vendorGroup ?? (options.includeAllProducts ? "all" : "deck-enterprises");
  if (!["deck-enterprises", "all"].includes(group)) fail("Choose Deck Enterprises or All vendors for the audit.");
  return group;
}

export function auditProducts(catalog, { productIds = [], ...options } = {}) {
  const group = auditVendorGroup(options);
  const ids = new Set(productIds.map(Number));
  return catalog.filter(row => row.categoryName?.trim().toLowerCase() !== "membership"
    && (!ids.size || ids.has(Number(row.id)))
    && (group === "all" || isSourcePricingVendor({ name: row.vendorName })));
}

// Scope both sides before comparing. Local and remote IDs can differ.
// null means unrestricted; an empty list deliberately compares nothing.
export function scopeLocalLineCatalogs(exportCatalog, storeCatalog, productIds = null) {
  if (productIds === null) return { exportCatalog, storeCatalog };
  const ids = new Set(productIds.map(Number));
  const productMetaRows = storeCatalog.productMetaRows.filter(row => ids.has(Number(row.productId)));
  const links = new Map(productMetaRows.filter(row => Number(row.localLineProductId) > 0)
    .map(row => [Number(row.productId), Number(row.localLineProductId)]));
  const remoteIds = new Set([...ids].map(id => links.get(id) || id));
  const productsById = new Map([...exportCatalog.productsById].filter(([id]) => remoteIds.has(Number(id))));
  const packagesByProductId = new Map([...exportCatalog.packagesByProductId].filter(([id]) => remoteIds.has(Number(id))));
  return {
    exportCatalog: { ...exportCatalog, productsById, packagesByProductId, productCount: productsById.size,
      packageCount: [...packagesByProductId.values()].reduce((sum, rows) => sum + rows.length, 0) },
    storeCatalog: { ...storeCatalog, products: storeCatalog.products.filter(row => ids.has(Number(row.id))),
      packages: storeCatalog.packages.filter(row => ids.has(Number(row.productId))), productMetaRows,
      packageMetaRows: storeCatalog.packageMetaRows.filter(row => ids.has(Number(row.productId))) }
  };
}
