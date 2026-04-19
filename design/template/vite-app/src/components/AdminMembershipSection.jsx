import React, { useMemo, useState } from "react";
import { adminPost, adminPut } from "../adminApi.js";

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMembershipCategory(value) {
  return normalizeCategoryName(value) === "membership";
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

function editsMatch(a, b) {
  return (
    a.visible === b.visible &&
    a.trackInventory === b.trackInventory &&
    Number(a.inventory) === Number(b.inventory) &&
    a.onSale === b.onSale &&
    Number(a.saleDiscount) === Number(b.saleDiscount)
  );
}

function normalizeMembershipEdit(changes, defaults) {
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

function normalizePrice(value) {
  if (value === null || typeof value === "undefined" || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function formatPrice(value) {
  const normalized = normalizePrice(value);
  return normalized ? `$${normalized}` : "n/a";
}

export function AdminMembershipSection({
  token,
  products,
  categories,
  onDataRefresh,
  onCatalogRefresh
}) {
  const [productSearch, setProductSearch] = useState("");
  const [membershipEdits, setMembershipEdits] = useState({});
  const [packageEdits, setPackageEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const categoryMap = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories]
  );
  const membershipProducts = useMemo(
    () =>
      products.filter((product) =>
        isMembershipCategory(categoryMap.get(product.categoryId))
      ),
    [products, categoryMap]
  );
  const productMap = useMemo(
    () => new Map(membershipProducts.map((product) => [product.id, product])),
    [membershipProducts]
  );
  const packageMap = useMemo(() => {
    const rows = [];
    for (const product of membershipProducts) {
      for (const pkg of product.packages || []) {
        rows.push([pkg.id, pkg]);
      }
    }
    return new Map(rows);
  }, [membershipProducts]);

  const normalizedSearch = productSearch.trim().toLowerCase();
  const filteredProducts = normalizedSearch
    ? membershipProducts.filter((product) =>
        String(product.name || "").toLowerCase().includes(normalizedSearch)
      )
    : membershipProducts;

  const pendingMembershipEditEntries = Object.entries(membershipEdits).filter(([id, changes]) => {
    const product = productMap.get(Number(id));
    if (!product) return false;
    const defaults = getProductDefaults(product);
    const normalized = normalizeMembershipEdit(changes || {}, defaults);
    return !editsMatch(normalized, defaults);
  });

  const pendingPackageEditEntries = Object.entries(packageEdits).filter(([id, price]) => {
    const pkg = packageMap.get(Number(id));
    if (!pkg) return false;
    return normalizePrice(price) !== normalizePrice(pkg.price);
  });

  function updateMembershipEdit(productId, patch) {
    const product = productMap.get(productId);
    if (!product) return;
    const defaults = getProductDefaults(product);

    setMembershipEdits((prev) => {
      const next = { ...prev };
      const current = next[productId] ? { ...defaults, ...next[productId] } : { ...defaults };
      const updated = normalizeMembershipEdit({ ...current, ...patch }, defaults);

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

  function updatePackagePrice(packageId, price) {
    setPackageEdits((prev) => ({
      ...prev,
      [packageId]: price
    }));
  }

  async function saveMembershipLevels() {
    if (!pendingMembershipEditEntries.length && !pendingPackageEditEntries.length) return;
    setSaving(true);
    setMessage("");

    try {
      for (const [id, price] of pendingPackageEditEntries) {
        await adminPut(`packages/${id}`, token, {
          price: price === "" ? null : Number(price)
        });
      }

      if (pendingMembershipEditEntries.length) {
        await adminPost("products/bulk-update", token, {
          updates: pendingMembershipEditEntries.map(([id, changes]) => {
            const productId = Number(id);
            const safeDiscount = Math.min(Math.max(Number(changes.saleDiscount) || 0, 0), 100);
            return {
              productId,
              changes: {
                visible: changes.visible ? 1 : 0,
                trackInventory: changes.trackInventory ? 1 : 0,
                inventory: Number(changes.inventory) || 0,
                onSale: changes.onSale ? 1 : 0,
                saleDiscount: safeDiscount / 100
              }
            };
          })
        });
      }

      setMembershipEdits({});
      setPackageEdits({});
      setMessage("Membership levels saved.");
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
      if (typeof onCatalogRefresh === "function") {
        await onCatalogRefresh();
      }
    } catch (error) {
      setMessage(error?.message || "Failed to save membership levels.");
    } finally {
      setSaving(false);
    }
  }

  const pendingCount = pendingMembershipEditEntries.length + pendingPackageEditEntries.length;

  return (
    <section className="admin-section membership-section">
      <div className="membership-toolbar">
        <div className="filters membership-filters">
          <label className="filter-field product-search-filter">
            <span className="small">Membership level</span>
            <input
              className="input"
              type="search"
              value={productSearch}
              placeholder="Search memberships"
              onChange={(event) => setProductSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="admin-actions membership-actions">
          <div className="small membership-count">
            Showing {filteredProducts.length} of {membershipProducts.length} levels · Pending changes:{" "}
            {pendingCount}
          </div>
          <button
            className="button"
            type="button"
            onClick={saveMembershipLevels}
            disabled={saving || pendingCount === 0}
          >
            {saving ? "Saving..." : `Save Membership Levels (${pendingCount})`}
          </button>
          <button
            className="button alt"
            type="button"
            disabled={saving || pendingCount === 0}
            onClick={() => {
              setMembershipEdits({});
              setPackageEdits({});
              setMessage("Pending membership changes discarded.");
            }}
          >
            Cancel Changes
          </button>
        </div>
      </div>

      {message ? <div className="small">{message}</div> : null}

      <div className="admin-table-shell membership-table-shell">
        <table className="admin-table membership-table">
          <thead>
            <tr>
              <th>Membership Level</th>
              <th>Packages</th>
              <th>Visible</th>
              <th>Track Inventory</th>
              <th>Stock</th>
              <th>Sale</th>
              <th>Sale %</th>
            </tr>
          </thead>
          <tbody>
            {filteredProducts.length ? (
              filteredProducts.map((product) => {
                const defaults = getProductDefaults(product);
                const edits = membershipEdits[product.id];
                const rowValues = edits ? { ...defaults, ...edits } : defaults;
                const packageDirty = (product.packages || []).some(
                  (pkg) =>
                    Object.prototype.hasOwnProperty.call(packageEdits, pkg.id) &&
                    normalizePrice(packageEdits[pkg.id]) !== normalizePrice(pkg.price)
                );
                return (
                  <tr
                    key={`membership-${product.id}`}
                    className={edits || packageDirty ? "edited" : ""}
                  >
                    <td>{product.name}</td>
                    <td>
                      <div className="membership-package-list">
                        {(product.packages || []).length ? (
                          (product.packages || []).map((pkg) => (
                            <label className="membership-package-row" key={`membership-package-${pkg.id}`}>
                              <span className="small">{pkg.name || `Package ${pkg.id}`}</span>
                              <input
                                className="input membership-price-input"
                                type="number"
                                step="0.01"
                                value={
                                  Object.prototype.hasOwnProperty.call(packageEdits, pkg.id)
                                    ? packageEdits[pkg.id]
                                    : pkg.price ?? ""
                                }
                                placeholder={formatPrice(pkg.price)}
                                onChange={(event) => updatePackagePrice(pkg.id, event.target.value)}
                              />
                            </label>
                          ))
                        ) : (
                          <span className="small">No packages</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <button
                        className={`toggle-switch ${rowValues.visible ? "active" : ""}`}
                        type="button"
                        onClick={() =>
                          updateMembershipEdit(product.id, { visible: !rowValues.visible })
                        }
                      />
                    </td>
                    <td>
                      <button
                        className={`toggle-switch ${rowValues.trackInventory ? "active" : ""}`}
                        type="button"
                        onClick={() =>
                          updateMembershipEdit(product.id, {
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
                          updateMembershipEdit(product.id, {
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
                          updateMembershipEdit(product.id, { onSale: !rowValues.onSale })
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
                            updateMembershipEdit(product.id, {
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
                <td colSpan="7" className="small">
                  No membership levels found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
