import React, { useEffect, useState } from "react";
import { adminPost } from "../adminApi.js";

function getProductPrice(product) {
  const prices = (product.packages || [])
    .map((pkg) => Number(pkg.price))
    .filter((value) => Number.isFinite(value));
  if (!prices.length) return "N/A";
  return `$${Math.min(...prices).toFixed(2)}`;
}

function getPackageSummary(product) {
  const packageNames = (product.packages || [])
    .map((pkg) => String(pkg.name || "").trim())
    .filter(Boolean);

  if (!packageNames.length) return "No packages";
  if (packageNames.length <= 2) return packageNames.join(", ");
  return `${packageNames.slice(0, 2).join(", ")} +${packageNames.length - 2}`;
}

function getProductDefaults(product) {
  const saleDiscount = Number.isFinite(product.saleDiscount) ? Number(product.saleDiscount) : 0;
  return {
    visible: Boolean(product.visible),
    trackInventory: Boolean(product.trackInventory),
    inventory: Number.isFinite(product.inventory) ? Number(product.inventory) : 0,
    onSale: Boolean(product.onSale),
    saleDiscount: Math.round(saleDiscount * 100)
  };
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMembershipCategoryName(value) {
  return normalizeCategoryName(value) === "membership";
}

function editsMatch(a, b) {
  return (
    a.visible === b.visible &&
    a.trackInventory === b.trackInventory &&
    Number(a.inventory) === Number(b.inventory) &&
    a.onSale === b.onSale &&
    Number(a.saleDiscount) === Number(b.saleDiscount)
  );
}

function normalizeInventoryEdit(changes, defaults) {
  return {
    visible: typeof changes.visible === "boolean" ? changes.visible : defaults.visible,
    trackInventory:
      typeof changes.trackInventory === "boolean"
        ? changes.trackInventory
        : defaults.trackInventory,
    inventory:
      changes.inventory === null || typeof changes.inventory === "undefined"
        ? defaults.inventory
        : Number(changes.inventory) || 0,
    onSale: typeof changes.onSale === "boolean" ? changes.onSale : defaults.onSale,
    saleDiscount:
      changes.saleDiscount === null || typeof changes.saleDiscount === "undefined"
        ? defaults.saleDiscount
        : Math.min(Math.max(Number(changes.saleDiscount) || 0, 0), 100)
  };
}

export function AdminInventorySection({
  token,
  products,
  categories,
  vendors,
  onDataRefresh,
  onCatalogRefresh
}) {
  const [productNameSearch, setProductNameSearch] = useState("");
  const [showProductNameSuggestions, setShowProductNameSuggestions] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [visibleFilter, setVisibleFilter] = useState("all");
  const [saleFilter, setSaleFilter] = useState("all");
  const [inventoryEdits, setInventoryEdits] = useState({});
  const [applyLoading, setApplyLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [applyState, setApplyState] = useState({
    open: false,
    updates: [],
    results: [],
    error: ""
  });

  const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const inventoryCategories = categories.filter(
    (category) => !isMembershipCategoryName(category.name)
  );
  const inventoryProducts = products.filter(
    (product) => !isMembershipCategoryName(categoryMap.get(product.categoryId))
  );
  const productMap = new Map(inventoryProducts.map((product) => [product.id, product]));
  const sortedVendors = vendors
    .slice()
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
  const productsMatchingVendorFilter = inventoryProducts.filter(
    (product) => !vendorFilter || String(product.vendorId) === vendorFilter
  );
  const categoryIdsForVendor = new Set(
    productsMatchingVendorFilter.map((product) => String(product.categoryId))
  );
  const visibleInventoryCategories = inventoryCategories.filter((category) =>
    categoryIdsForVendor.has(String(category.id))
  );

  useEffect(() => {
    if (
      categoryFilter &&
      !visibleInventoryCategories.some((category) => String(category.id) === categoryFilter)
    ) {
      setCategoryFilter("");
    }
  }, [categoryFilter, visibleInventoryCategories]);

  function getPendingInventoryEditEntries() {
    return Object.entries(inventoryEdits).filter(([id, changes]) => {
      const product = productMap.get(Number(id));
      if (!product) return false;
      const defaults = getProductDefaults(product);
      const normalized = normalizeInventoryEdit(changes || {}, defaults);
      return !editsMatch(normalized, defaults);
    });
  }

  function updateInventoryEdit(productId, patch) {
    const product = productMap.get(productId);
    if (!product) return;
    const defaults = getProductDefaults(product);

    setInventoryEdits((prev) => {
      const next = { ...prev };
      const current = next[productId] ? { ...defaults, ...next[productId] } : { ...defaults };
      const updated = normalizeInventoryEdit({ ...current, ...patch }, defaults);

      if (updated.trackInventory && updated.visible && Number(updated.inventory) === 0) {
        window.alert("If Track Inventory is on and stock is 0, set Visible to off.");
        return prev;
      }

      if (editsMatch(updated, defaults)) {
        delete next[productId];
      } else {
        next[productId] = updated;
      }
      return next;
    });
  }

  const normalizedProductNameSearch = productNameSearch.trim().toLowerCase();

  const productsMatchingOtherFilters = inventoryProducts.filter((product) => {
    const categoryMatch = !categoryFilter || String(product.categoryId) === categoryFilter;
    const vendorMatch = !vendorFilter || String(product.vendorId) === vendorFilter;
    const visibleMatch =
      visibleFilter === "all" ||
      (visibleFilter === "visible" && product.visible) ||
      (visibleFilter === "hidden" && !product.visible);
    const saleMatch =
      saleFilter === "all" ||
      (saleFilter === "onSale" && product.onSale) ||
      (saleFilter === "notOnSale" && !product.onSale);
    return categoryMatch && vendorMatch && visibleMatch && saleMatch;
  });

  const productNameMatches = normalizedProductNameSearch
    ? productsMatchingOtherFilters.filter((product) =>
        String(product.name || "").toLowerCase().includes(normalizedProductNameSearch)
      )
    : [];

  const filteredProducts = normalizedProductNameSearch
    ? productNameMatches
    : productsMatchingOtherFilters;

  const visibleProductNameSuggestions = productNameMatches.slice(0, 8);
  const pendingInventoryEditEntries = getPendingInventoryEditEntries();
  const inventoryTableWidth = "1576px";

  async function handleApplyChanges() {
    if (!pendingInventoryEditEntries.length) return;

    const updates = pendingInventoryEditEntries.map(([id, changes]) => {
      const productId = Number(id);
      const product = productMap.get(productId);
      const safeDiscount = Math.min(Math.max(Number(changes.saleDiscount) || 0, 0), 100);
      return {
        productId,
        productName: product?.name || `Product ${productId}`,
        category: categoryMap.get(product?.categoryId) || "Uncategorized",
        changes: {
          visible: changes.visible ? 1 : 0,
          trackInventory: changes.trackInventory ? 1 : 0,
          inventory: Number(changes.inventory) || 0,
          onSale: changes.onSale ? 1 : 0,
          saleDiscount: safeDiscount / 100
        },
        display: {
          visible: changes.visible ? "On" : "Off",
          trackInventory: changes.trackInventory ? "On" : "Off",
          inventory: Number(changes.inventory) || 0,
          onSale: changes.onSale ? "On" : "Off",
          saleDiscount: safeDiscount
        }
      };
    });

    setApplyState({ open: true, updates, results: [], error: "" });
    setApplyLoading(true);
    setMessage("");

    try {
      const response = await adminPost("products/bulk-update", token, {
        updates: updates.map((update) => ({
          productId: update.productId,
          changes: update.changes
        }))
      });

      setApplyState((prev) => ({ ...prev, results: response.results || [] }));
      setInventoryEdits({});
      setMessage("Inventory changes applied.");
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
      if (typeof onCatalogRefresh === "function") {
        await onCatalogRefresh();
      }
    } catch (_error) {
      setApplyState((prev) => ({ ...prev, error: "Failed to apply inventory changes." }));
      setMessage("Inventory update failed.");
    } finally {
      setApplyLoading(false);
    }
  }

  function closeApplyPanel() {
    setApplyState({ open: false, updates: [], results: [], error: "" });
  }

  return (
    <>
      <section className="admin-section inventory-section">
        <div className="inventory-toolbar">
          <div className="filters inventory-filters">
            <label className="filter-field product-search-filter">
              <span className="small">Product name</span>
              <input
                className="input"
                type="search"
                value={productNameSearch}
                placeholder="Search products"
                onChange={(event) => {
                  setProductNameSearch(event.target.value);
                  setShowProductNameSuggestions(true);
                }}
                onFocus={() => setShowProductNameSuggestions(true)}
                onBlur={() => setShowProductNameSuggestions(false)}
              />
              {showProductNameSuggestions && normalizedProductNameSearch ? (
                <div className="filter-suggestions" role="listbox" aria-label="Matching products">
                  {visibleProductNameSuggestions.length ? (
                    visibleProductNameSuggestions.map((product) => (
                      <button
                        key={`inventory-suggestion-${product.id}`}
                        className="filter-suggestion"
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setProductNameSearch(product.name || "");
                          setShowProductNameSuggestions(false);
                        }}
                      >
                        <span>{product.name}</span>
                        <span className="small">
                          {categoryMap.get(product.categoryId) || "Uncategorized"} ·{" "}
                          {vendorMap.get(product.vendorId) || "N/A"}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="filter-suggestion-empty small">No matching products</div>
                  )}
                </div>
              ) : null}
            </label>
            <label className="filter-field">
              <span className="small">Vendor</span>
              <select
                className="input"
                value={vendorFilter}
                onChange={(event) => setVendorFilter(event.target.value)}
              >
                <option value="">All vendors</option>
                {sortedVendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span className="small">Category</span>
              <select
                className="input"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="">All categories</option>
                {visibleInventoryCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span className="small">Visibility</span>
              <select
                className="input"
                value={visibleFilter}
                onChange={(event) => setVisibleFilter(event.target.value)}
              >
                <option value="visible">Visible only</option>
                <option value="hidden">Hidden only</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="filter-field">
              <span className="small">On sale</span>
              <select
                className="input"
                value={saleFilter}
                onChange={(event) => setSaleFilter(event.target.value)}
              >
                <option value="all">All</option>
                <option value="onSale">On sale only</option>
                <option value="notOnSale">Not on sale</option>
              </select>
            </label>
          </div>

          <div className="admin-actions inventory-actions">
            <div className="inventory-button-row">
              <button
                className="button"
                type="button"
                onClick={handleApplyChanges}
                disabled={applyLoading || pendingInventoryEditEntries.length === 0}
              >
                {applyLoading
                  ? "Applying inventory..."
                  : `Apply Inventory Changes (${pendingInventoryEditEntries.length})`}
              </button>
              <button
                className="button alt"
                type="button"
                disabled={applyLoading || pendingInventoryEditEntries.length === 0}
                onClick={() => {
                  if (!window.confirm("Discard all pending inventory changes? This cannot be undone.")) {
                    return;
                  }
                  setInventoryEdits({});
                  setMessage("Pending inventory changes discarded.");
                }}
              >
                Cancel Changes
              </button>
            </div>
            <div className="small inventory-count">
              Showing {filteredProducts.length} of {inventoryProducts.length} products · Pending changes:{" "}
              {pendingInventoryEditEntries.length}
            </div>
          </div>
        </div>

        {message ? <div className="small">{message}</div> : null}

        <div className="admin-table-shell inventory-table-shell">
          <table
            className="admin-table admin-table-head"
            style={{ width: inventoryTableWidth, minWidth: inventoryTableWidth }}
          >
            <colgroup>
              <col style={{ width: "160px" }} />
              <col style={{ width: "280px" }} />
              <col style={{ width: "180px" }} />
              <col style={{ width: "260px" }} />
              <col style={{ width: "110px" }} />
              <col style={{ width: "96px" }} />
              <col style={{ width: "132px" }} />
              <col style={{ width: "110px" }} />
              <col style={{ width: "96px" }} />
              <col style={{ width: "110px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Category</th>
                <th>Product</th>
                <th>Vendor</th>
                <th>Packages</th>
                <th>Price</th>
                <th>Visible</th>
                <th>Track Inventory</th>
                <th>Stock</th>
                <th>Sale</th>
                <th>Sale %</th>
              </tr>
            </thead>
          </table>

          <div className="admin-table-body-scroll inventory-table-body-scroll">
            <table
              className="admin-table admin-table-body"
              style={{ width: inventoryTableWidth, minWidth: inventoryTableWidth }}
            >
              <colgroup>
                <col style={{ width: "160px" }} />
                <col style={{ width: "280px" }} />
                <col style={{ width: "180px" }} />
                <col style={{ width: "260px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "96px" }} />
                <col style={{ width: "132px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "96px" }} />
                <col style={{ width: "110px" }} />
              </colgroup>
              <tbody>
                {filteredProducts.length ? (
                  filteredProducts.map((product) => {
                    const defaults = getProductDefaults(product);
                    const edits = inventoryEdits[product.id];
                    const rowValues = edits ? { ...defaults, ...edits } : defaults;
                    return (
                      <tr key={product.id} className={edits ? "edited" : ""}>
                        <td>{categoryMap.get(product.categoryId) || "Uncategorized"}</td>
                        <td>{product.name}</td>
                        <td>{vendorMap.get(product.vendorId) || "N/A"}</td>
                        <td className="inventory-package-cell">{getPackageSummary(product)}</td>
                        <td>{getProductPrice(product)}</td>
                        <td>
                          <button
                            className={`toggle-switch ${rowValues.visible ? "active" : ""}`}
                            type="button"
                            onClick={() =>
                              updateInventoryEdit(product.id, { visible: !rowValues.visible })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className={`toggle-switch ${rowValues.trackInventory ? "active" : ""}`}
                            type="button"
                            onClick={() =>
                              updateInventoryEdit(product.id, {
                                trackInventory: !rowValues.trackInventory
                              })
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="stock-input"
                            type="number"
                            value={rowValues.inventory}
                            onChange={(event) =>
                              updateInventoryEdit(product.id, {
                                inventory: Number(event.target.value)
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className={`toggle-switch ${rowValues.onSale ? "active" : ""}`}
                            type="button"
                            onClick={() =>
                              updateInventoryEdit(product.id, { onSale: !rowValues.onSale })
                            }
                          />
                        </td>
                        <td>
                          <span className="sale-discount-wrapper">
                            <input
                              className="sale-discount-input"
                              type="number"
                              min="0"
                              max="100"
                              step="1"
                              value={rowValues.saleDiscount}
                              onChange={(event) =>
                                updateInventoryEdit(product.id, {
                                  saleDiscount: Number(event.target.value)
                                })
                              }
                            />
                            <span className="sale-discount-suffix">%</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan="10" className="small">
                      No products match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {applyState.open && (
        <div className="modal-backdrop" onClick={closeApplyPanel}>
          <div className="modal response-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Inventory Updates Applied</h3>
            <div className="response-progress">
              Updating {applyState.results.length} of {applyState.updates.length} products
            </div>
            {applyState.error ? <div className="small">{applyState.error}</div> : null}
            <div className="response-list">
              {applyState.updates.map((update) => {
                const result = (applyState.results || []).find(
                  (item) => item.productId === update.productId
                );
                const databaseOk = result ? result.databaseUpdate : null;
                const localLineOk = result ? result.localLineUpdate : null;
                const localLinePriceOk = result ? result.localLinePriceUpdate : null;
                const dbLabel =
                  databaseOk === null || databaseOk === undefined
                    ? "Pending"
                    : databaseOk
                    ? "Updated"
                    : "Failed";
                const llLabel =
                  localLineOk === null || localLineOk === undefined
                    ? "Skipped"
                    : localLineOk
                    ? "Updated"
                    : "Failed";
                const llPriceLabel =
                  localLinePriceOk === null || localLinePriceOk === undefined
                    ? "Skipped"
                    : localLinePriceOk
                    ? "Updated"
                    : "Failed";
                const dbClass = databaseOk ? "ok" : databaseOk === null ? "pending" : "warn";
                const llClass = localLineOk ? "ok" : localLineOk === null ? "pending" : "warn";
                const llPriceClass =
                  localLinePriceOk ? "ok" : localLinePriceOk === null ? "pending" : "warn";

                return (
                  <div className="response-card" key={`inventory-result-${update.productId}`}>
                    <div className="title">{update.productName}</div>
                    <div className="small">Category: {update.category}</div>
                    <div className="small">
                      Visible: {update.display.visible} · Track: {update.display.trackInventory} ·
                      Stock: {update.display.inventory}
                    </div>
                    <div className="small">
                      Sale: {update.display.onSale} · Discount: {update.display.saleDiscount}%
                    </div>
                    <div>
                      Database: <span className={`status ${dbClass}`}>{dbLabel}</span>
                    </div>
                    <div>
                      LocalLine: <span className={`status ${llClass}`}>{llLabel}</span>
                    </div>
                    <div>
                      LocalLine Pricing:{" "}
                      <span className={`status ${llPriceClass}`}>{llPriceLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="response-actions">
              <button className="button alt" type="button" onClick={closeApplyPanel}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
