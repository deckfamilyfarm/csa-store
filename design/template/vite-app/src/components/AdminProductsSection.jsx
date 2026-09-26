import React, { useEffect, useRef, useState } from "react";
import { adminGet } from "../adminApi.js";
import { categoryLabel } from "../categoryLabel.js";
import { ProductActionsMenu } from "./ProductActionsMenu.jsx";
import {
  dirtyFields,
  hydrateProductDraft,
  patchProductDraft,
  previewProductPrices,
} from "./productWorkspace.js";
import "./AdminProductsSection.css";

const DECK_ENTERPRISES = "deck-enterprises";

const PRODUCT_COLUMNS = [
  {
    key: "product",
    label: "Product",
    width: 260,
    sticky: "left",
    required: true,
    defaultVisible: true,
  },
  {
    key: "sourceUnitPrice",
    label: "Retail Price",
    description:
      "Vendor retail price before CSA adjustments; standard products show their package prices.",
    width: 164,
    defaultVisible: true,
  },
  {
    key: "unit",
    label: "Vendor's Unit Type",
    width: 128,
    defaultVisible: true,
  },
  {
    key: "basePrice",
    label: "CSA Base Price / Unit",
    width: 126,
    defaultVisible: true,
  },
  {
    key: "memberPrice",
    label: "Member Adjusted $",
    width: 126,
    defaultVisible: true,
  },
  { key: "visible", label: "Visible", width: 72, defaultVisible: true },
  {
    key: "trackInventory",
    label: "Track Inventory",
    width: 132,
    defaultVisible: true,
  },
  { key: "inventory", label: "Stock", width: 92, defaultVisible: true },
  { key: "onSale", label: "Sale", width: 82, defaultVisible: true },
  { key: "saleDiscount", label: "Sale %", width: 96, defaultVisible: true },

  { key: "category", label: "Category", width: 160, defaultVisible: false },
  { key: "vendor", label: "Vendor", width: 170, defaultVisible: false },
  { key: "pricingRule", label: "Rule", width: 150, defaultVisible: false },
  { key: "minWeight", label: "Min Wt", width: 100, defaultVisible: false },
  { key: "maxWeight", label: "Max Wt", width: 100, defaultVisible: false },
  {
    key: "avgWeightOverride",
    label: "Avg Wt",
    width: 100,
    defaultVisible: false,
  },
  {
    key: "sourceMultiplier",
    label: "FFCSA Factor",
    width: 116,
    defaultVisible: false,
  },
  {
    key: "guestMarkup",
    label: "Guest Adj %",
    width: 112,
    defaultVisible: false,
  },
  {
    key: "guestPrice",
    label: "Guest Adjusted $",
    width: 126,
    defaultVisible: false,
  },
  {
    key: "memberMarkup",
    label: "Member Adj %",
    width: 118,
    defaultVisible: false,
  },
  {
    key: "herdShareMarkup",
    label: "Herd Adj %",
    width: 110,
    defaultVisible: false,
  },
  {
    key: "herdSharePrice",
    label: "Herd Adjusted $",
    width: 144,
    defaultVisible: false,
  },
  { key: "snapMarkup", label: "SNAP Adj %", width: 110, defaultVisible: false },
  {
    key: "snapPrice",
    label: "SNAP Adjusted $",
    width: 144,
    defaultVisible: false,
  },
  { key: "packages", label: "Packages", width: 220, defaultVisible: false },

  {
    key: "actions",
    label: "Actions",
    width: 156,
    sticky: "right",
    required: true,
    defaultVisible: true,
  },
];

const VIEW_COLUMNS = {
  pricing: [
    "product",
    "sourceUnitPrice",
    "unit",
    "minWeight",
    "maxWeight",
    "avgWeightOverride",
    "basePrice",
    "memberPrice",
    "onSale",
    "saleDiscount",
    "actions",
  ],
  inventory: [
    "product",
    "vendor",
    "inventory",
    "trackInventory",
    "visible",
    "onSale",
    "saleDiscount",
    "actions",
  ],
};
const COLUMN_MAP = new Map(
  PRODUCT_COLUMNS.map((column) => [column.key, column]),
);
function columnRequired(column, view) {
  return (
    column.required || (view === "pricing" && column.key === "sourceUnitPrice")
  );
}
function pinColumns(keys) {
  const middle = [...new Set(keys)].filter(
    (key) => COLUMN_MAP.has(key) && !["product", "actions"].includes(key),
  );
  return ["product", ...middle, "actions"];
}
function loadColumns(view, defaults = false) {
  try {
    const key = `adminProducts.columns.${view}${defaults ? ".default" : ""}.v1`;
    const raw =
      window.localStorage.getItem(key) ||
      (!defaults
        ? window.localStorage.getItem(
            `adminProducts.columns.${view}.default.v1`,
          )
        : null) ||
      (view === "pricing"
        ? window.localStorage.getItem(
            defaults
              ? "adminPricelistColumnDefaultPrefs.v2"
              : "adminPricelistColumnPrefs.v2",
          ) ||
          window.localStorage.getItem("adminPricelistColumnDefaultPrefs.v2")
        : null);
    if (raw) {
      const value = JSON.parse(raw);
      const order = [
        ...new Set([
          ...(value.columnOrder || []),
          ...PRODUCT_COLUMNS.map((c) => c.key),
        ]),
      ];
      return pinColumns(
        order.filter(
          (key) =>
            COLUMN_MAP.has(key) &&
            (columnRequired(COLUMN_MAP.get(key), view) ||
              value.visibleColumns?.[key]),
        ),
      );
    }
  } catch {
    /* A missing or old preference falls back to this view's defaults. */
  }
  return VIEW_COLUMNS[view];
}
function saveColumns(view, keys, defaults = false) {
  window.localStorage.setItem(
    `adminProducts.columns.${view}${defaults ? ".default" : ""}.v1`,
    JSON.stringify({
      columnOrder: keys,
      visibleColumns: Object.fromEntries(
        PRODUCT_COLUMNS.map((c) => [c.key, keys.includes(c.key)]),
      ),
    }),
  );
}
const money = (value) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? "—"
    : `$${Number(value).toFixed(2)}`;
const toggleId = (ids, id) =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];

export function AdminProductsSection({
  token,
  categories = [],
  vendors = [],
  capabilities,
  drafts,
  setDrafts,
  onSave,
  saving,
  refreshNonce,
  onDataRefresh,
  onCatalogRefresh,
  onOpenProductDetails,
  onAddProduct,
  onDuplicateProduct,
  onDeleteProduct,
  selected,
  setSelected,
}) {
  const [view, setView] = useState("pricing");
  const [columnsByView, setColumnsByView] = useState(() =>
    Object.fromEntries(
      Object.keys(VIEW_COLUMNS).map((key) => [key, loadColumns(key)]),
    ),
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState({
    categoryId: "",
    vendorId: "",
    visibility: "all",
    sale: "all",
    pricingType: "all",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState({ key: "product", direction: "asc" });
  const [data, setData] = useState({ rows: [], pagination: {}, summary: {} });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const rowCache = useRef(new Map());
  const requestId = useRef(0);
  const [reload, setReload] = useState(0);
  const [saveResults, setSaveResults] = useState([]);
  const pendingDrafts = Object.values(drafts).filter(
    (entry) => dirtyFields(entry).length,
  );
  const columns = (columnsByView[view] || VIEW_COLUMNS[view])
    .map((key) => COLUMN_MAP.get(key))
    .filter(Boolean);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    const params = new URLSearchParams({
      ...filters,
      vendorId: filters.vendorId === DECK_ENTERPRISES ? "" : filters.vendorId,
      vendorGroup:
        filters.vendorId === DECK_ENTERPRISES ? DECK_ENTERPRISES : "",
      search: debouncedSearch,
      page: String(page),
      pageSize: String(pageSize),
      sortKey: sort.key,
      sortDirection: sort.direction,
    });
    setLoading(true);
    adminGet(`pricelist?${params}`, token)
      .then((response) => {
        if (cancelled || requestId.current !== id) return;
        for (const row of response.rows || [])
          rowCache.current.set(row.productId, row);
        setData(response);
        if (response.pagination?.page && response.pagination.page !== page)
          setPage(response.pagination.page);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error.message || "Unable to load products.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    token,
    filters,
    debouncedSearch,
    page,
    pageSize,
    sort,
    refreshNonce,
    reload,
  ]);

  function filter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }
  function changeView(nextView) {
    if (nextView === view) return;
    setView(nextView);
    if (nextView === "inventory") filter("vendorId", DECK_ENTERPRISES);
  }
  function changeColumns(keys) {
    keys = pinColumns(keys);
    setColumnsByView((prev) => ({ ...prev, [view]: keys }));
    saveColumns(view, keys);
  }
  function moveColumn(key, delta) {
    const keys = [...columnsByView[view]];
    const index = keys.indexOf(key);
    const target = index + delta;
    if (
      index <= 0 ||
      index >= keys.length - 1 ||
      target <= 0 ||
      target >= keys.length - 1
    )
      return;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    changeColumns(keys);
  }
  function patch(row, values) {
    setDrafts((prev) => patchProductDraft(prev, row, values));
  }
  async function refresh() {
    setReload((value) => value + 1);
    await onDataRefresh?.();
    await onCatalogRefresh?.();
  }
  async function save() {
    const results = await onSave();
    setSaveResults(results);
    setMessage(
      results.some((result) => !result.ok)
        ? "Some changes could not be saved. The remaining edits are still available below."
        : "Local changes saved.",
    );
    setReload((value) => value + 1);
  }
  async function deleteRow(row) {
    setBusy(true);
    try {
      const result = await onDeleteProduct(row.productId, {
        localLineProductId: row.localLineProductId,
      });
      if (result?.ok) {
        setSelected((prev) => prev.filter((id) => id !== row.productId));
        setReload((value) => value + 1);
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  function cell(column, row) {
    const values =
      drafts[row.productId]?.values || hydrateProductDraft(null, row).values;
    const prices = previewProductPrices(row, values);
    const disabled = saving || busy;
    const numericInput = (key, pricing = false) => (
      <input
        aria-label={`${column.label}: ${row.name}`}
        className="input products-number"
        type="number"
        step="any"
        min="0"
        disabled={
          disabled || !(pricing ? capabilities.pricing : capabilities.edit)
        }
        value={values[key]}
        onChange={(event) =>
          patch(row, {
            [key]: pricing ? event.target.value : Number(event.target.value),
          })
        }
      />
    );
    switch (column.key) {
      case "product":
        return (
          <div className="products-name">
            {row.thumbnailUrl ? (
              <img src={row.thumbnailUrl} alt="" loading="lazy" />
            ) : null}
            <div>
              <strong>{values.name}</strong>
              <div className="small products-product-meta">
                {[
                  !columnsByView[view].includes("vendor") && row.vendorName,
                  !columnsByView[view].includes("category") &&
                    categoryLabel(row.categoryName),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {!columnsByView[view].includes("packages") &&
              row.packageSummary ? (
                <div className="small products-product-meta">
                  {row.packageSummary}
                </div>
              ) : null}
              {dirtyFields(drafts[row.productId]).length ? (
                <div className="small">Unsaved changes</div>
              ) : null}
            </div>
          </div>
        );
      case "vendor":
        return row.vendorName;
      case "category":
        return categoryLabel(row.categoryName);
      case "visible":
      case "trackInventory":
      case "onSale":
        return (
          <input
            type="checkbox"
            aria-label={`${column.label}: ${row.name}`}
            checked={values[column.key]}
            disabled={disabled || !capabilities.edit}
            onChange={(event) =>
              patch(row, { [column.key]: event.target.checked })
            }
          />
        );
      case "inventory":
      case "saleDiscount":
        return numericInput(column.key);
      case "sourceUnitPrice":
        if (row.usesSourcePricing) {
          return (
            <div className="products-retail-price">
              <span aria-hidden="true">$</span>
              {numericInput(column.key, true)}
              <span className="small">
                / {values.unitOfMeasure === "lbs" ? "lb" : "each"}
              </span>
            </div>
          );
        }
        return values.packages.length ? (
          <div>
            {values.packages.map((pkg, index) => (
              <div key={pkg.id ?? index}>
                {money(pkg.price)}
                <span className="small">
                  {" "}
                  /{" "}
                  {pkg.chargeType === "unit"
                    ? pkg.unit || "unit"
                    : pkg.name || "package"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          "—"
        );
      case "minWeight":
      case "maxWeight":
      case "avgWeightOverride":
        return row.usesSourcePricing ? numericInput(column.key, true) : "—";
      case "sourceMultiplier":
        return row.usesSourcePricing ? values.sourceMultiplier : "—";
      case "unit":
        return row.usesSourcePricing ? (
          <select
            className="input"
            aria-label={`Vendor unit: ${row.name}`}
            disabled={disabled || !capabilities.pricing}
            value={values.unitOfMeasure}
            onChange={(event) =>
              patch(row, { unitOfMeasure: event.target.value })
            }
          >
            <option value="each">Each</option>
            <option value="lbs">Pounds</option>
          </select>
        ) : (
          "—"
        );
      case "pricingRule":
        return row.usesNoMarkupPricing
          ? "Deposit / no markup"
          : row.usesSourcePricing
            ? "Formula"
            : "Standard";
      case "basePrice":
        if (!row.usesSourcePricing && values.packages.length === 1)
          return (
            <input
              aria-label={`Package price: ${row.name}`}
              className="input products-number"
              type="number"
              step="0.01"
              min="0"
              value={values.packages[0].price}
              disabled={disabled || !capabilities.pricing}
              onChange={(event) =>
                patch(row, {
                  packages: [
                    { ...values.packages[0], price: event.target.value },
                  ],
                })
              }
            />
          );
        return money(prices.basePrice);
      case "packages":
        return (
          <div>
            {row.packageSummary || "No packages"}
            {values.packages.length > 1 ? (
              <div className="small">Edit prices in Details</div>
            ) : null}
          </div>
        );
      case "actions":
        return (
          <div className="products-row-actions">
            <button
              className="button alt"
              disabled={disabled}
              onClick={() => onOpenProductDetails(row.productId)}
            >
              Details
            </button>
            {capabilities.edit ? (
              <ProductActionsMenu
                label={`More actions for ${values.name}`}
                disabled={disabled}
                items={[
                  {
                    label: "Duplicate",
                    onClick: () => onDuplicateProduct(row.productId),
                  },
                  {
                    label: "Delete",
                    danger: true,
                    disabled: row.localLineProductId > 0 && !capabilities.push,
                    onClick: () => deleteRow(row),
                  },
                ]}
              />
            ) : null}
          </div>
        );
      default:
        return column.key.endsWith("Markup")
          ? `${(Number(row[column.key] || 0) * 100).toFixed(2)}%`
          : money(
              Object.prototype.hasOwnProperty.call(prices, column.key)
                ? prices[column.key]
                : row[column.key],
            );
    }
  }
  return (
    <section className="admin-section products-workspace">
      <div className="products-heading">
        <h2 className="h2">Products</h2>
        <div className="products-button-group">
          <button
            className="button alt"
            aria-expanded={columnsOpen}
            aria-controls="products-columns"
            onClick={() => setColumnsOpen(!columnsOpen)}
          >
            Columns
          </button>
          {capabilities.edit ? (
            <button
              className="button alt"
              disabled={saving || busy}
              onClick={onAddProduct}
            >
              Add Product
            </button>
          ) : null}
        </div>
      </div>
      <div className="products-views" role="tablist" aria-label="Product views">
        {Object.keys(VIEW_COLUMNS).map((key) => (
          <button
            className="products-view"
            role="tab"
            aria-selected={view === key}
            key={key}
            onClick={() => changeView(key)}
          >
            {key[0].toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>
      <p className="small">
        Manage product details, pricing, and inventory. Save changes locally;
        syncing and scheduling are in Product Sync.
      </p>
      <div className="admin-filters">
        <label>
          Search
          <input
            className="input"
            type="search"
            aria-label="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Vendor
          <select
            className="input"
            aria-label="Vendor"
            value={filters.vendorId}
            onChange={(event) => filter("vendorId", event.target.value)}
          >
            <option value="">All vendors</option>
            <option value={DECK_ENTERPRISES}>Deck Enterprises</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            className="input"
            aria-label="Category"
            value={filters.categoryId}
            onChange={(event) => filter("categoryId", event.target.value)}
          >
            <option value="">All categories</option>
            {categories
              .filter((c) => c.name?.trim().toLowerCase() !== "membership")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c.name)}
                </option>
              ))}
          </select>
        </label>
        {[
          [
            "visibility",
            "Visibility",
            [
              ["all", "All"],
              ["visible", "Visible"],
              ["hidden", "Hidden"],
            ],
          ],
          [
            "sale",
            "Sale",
            [
              ["all", "All"],
              ["onSale", "On sale"],
              ["notOnSale", "Not on sale"],
            ],
          ],
          [
            "pricingType",
            "Pricing type",
            [
              ["all", "All"],
              ["formula", "Formula"],
              ["standard", "Standard"],
              ["deposit", "Deposit / no markup"],
            ],
          ],
        ].map(([key, label, options]) => (
          <label key={key}>
            {label}
            <select
              className="input"
              aria-label={label}
              value={filters[key]}
              onChange={(event) => filter(key, event.target.value)}
            >
              {options.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="products-toolbar">
        <div className="products-button-group">
          {capabilities.edit ? (
            <>
              <button
                className="button"
                disabled={saving || busy || !pendingDrafts.length}
                onClick={save}
              >
                {saving
                  ? "Saving…"
                  : `Save Local Changes (${pendingDrafts.length})`}
              </button>
              <button
                className="button alt products-discard"
                disabled={saving || busy || !pendingDrafts.length}
                onClick={() => {
                  if (window.confirm("Discard all unsaved product changes?"))
                    setDrafts({});
                }}
              >
                Discard Changes
              </button>
            </>
          ) : null}
        </div>
      </div>
      {columnsOpen ? (
        <div className="products-columns" id="products-columns">
          <strong>{view} columns</strong>
          {[
            ...columns,
            ...PRODUCT_COLUMNS.filter(
              (column) => !columnsByView[view].includes(column.key),
            ),
          ].map((column) => (
            <div className="products-column-option" key={column.key}>
              <label>
                <input
                  type="checkbox"
                  checked={columnsByView[view].includes(column.key)}
                  disabled={columnRequired(column, view)}
                  onChange={() =>
                    changeColumns(toggleId(columnsByView[view], column.key))
                  }
                />
                {column.label}
              </label>
              {columnsByView[view].includes(column.key) &&
              !["product", "actions"].includes(column.key) ? (
                <>
                  <button
                    aria-label={`Move ${column.label} left`}
                    onClick={() => moveColumn(column.key, -1)}
                  >
                    ←
                  </button>
                  <button
                    aria-label={`Move ${column.label} right`}
                    onClick={() => moveColumn(column.key, 1)}
                  >
                    →
                  </button>
                </>
              ) : null}
            </div>
          ))}
          <div className="products-button-group products-column-defaults">
            <button
              className="button alt"
              onClick={() => saveColumns(view, columnsByView[view], true)}
            >
              Save as Default
            </button>
            <button
              className="button alt"
              onClick={() => changeColumns(loadColumns(view, true))}
            >
              Reset to Saved Default
            </button>
            <button
              className="button alt"
              onClick={() => changeColumns(VIEW_COLUMNS[view])}
            >
              App Default
            </button>
          </div>
        </div>
      ) : null}
      <div role="status" className="small products-message">
        {loading ? "Loading products…" : message}
      </div>
      {selected.length ? (
        <div className="small">
          {selected.length} selected across all pages and filters. Open Store →
          Product Sync to review the selection.{" "}
          <button
            className="products-text-button"
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        </div>
      ) : null}
      {pendingDrafts.length ? (
        <div className="small">
          {pendingDrafts.length} unsaved product
          {pendingDrafts.length === 1 ? "" : "s"} across all pages and filters.
        </div>
      ) : null}
      <div
        className="products-table-scroll"
        role="region"
        aria-label="Products table, scroll for more columns"
        tabIndex={0}
      >
        <table
          className="table products-table"
          style={{
            minWidth:
              44 + columns.reduce((sum, column) => sum + column.width, 0),
          }}
        >
          <colgroup>
            <col style={{ width: 44 }} />
            {columns.map((column) => (
              <col
                key={column.key}
                style={{
                  width: column.key === "product" ? undefined : column.width,
                }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select visible products"
                  checked={
                    Boolean(data.rows.length) &&
                    data.rows.every((row) => selected.includes(row.productId))
                  }
                  onChange={(event) =>
                    setSelected((prev) =>
                      event.target.checked
                        ? [
                            ...new Set([
                              ...prev,
                              ...data.rows.map((row) => row.productId),
                            ]),
                          ]
                        : prev.filter(
                            (id) =>
                              !data.rows.some((row) => row.productId === id),
                          ),
                    )
                  }
                />
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  title={column.description}
                  aria-sort={
                    sort.key === column.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {column.key === "actions" ? (
                    column.label
                  ) : (
                    <button
                      onClick={() => {
                        setSort({
                          key: column.key,
                          direction:
                            sort.key === column.key && sort.direction === "asc"
                              ? "desc"
                              : "asc",
                        });
                        setPage(1);
                      }}
                    >
                      {column.label}
                      {sort.key === column.key
                        ? sort.direction === "asc"
                          ? " ↑"
                          : " ↓"
                        : ""}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.productId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={selected.includes(row.productId)}
                    onChange={() =>
                      setSelected((prev) => toggleId(prev, row.productId))
                    }
                  />
                </td>
                {columns.map((column) => (
                  <td key={column.key}>{cell(column, row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !data.rows.length ? (
        <p>No products match these filters.</p>
      ) : null}
      <div className="products-pagination">
        <span>
          {data.pagination?.totalRows || 0} products · Page {page} of{" "}
          {data.pagination?.totalPages || 1}
        </span>
        <div className="products-button-group">
          <button
            className="button alt"
            disabled={loading || page <= 1}
            onClick={() => setPage(1)}
          >
            First
          </button>
          <button
            className="button alt"
            disabled={loading || page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <button
            className="button alt"
            disabled={loading || page >= (data.pagination?.totalPages || 1)}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
          <button
            className="button alt"
            disabled={loading || page >= (data.pagination?.totalPages || 1)}
            onClick={() => setPage(data.pagination.totalPages)}
          >
            Last
          </button>
        </div>
        <label>
          Rows{" "}
          <select
            className="input"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {[50, 100, 200].map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </label>
      </div>
      {saveResults.length ? (
        <details open>
          <summary>Local save results</summary>
          {saveResults.map((result) => (
            <p key={result.productId} className="small">
              {result.productName}:{" "}
              {result.ok
                ? "Saved locally"
                : result.partial
                  ? "Partially saved"
                  : "Failed"}
              {result.errors?.length ? ` — ${result.errors.join("; ")}` : ""}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
