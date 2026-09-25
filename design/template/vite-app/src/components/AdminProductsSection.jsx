import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import {
  dirtyFields,
  hydrateProductDraft,
  patchProductDraft,
  unsupportedScheduleFields,
  buildScheduleUpdate,
  syncLabel,
  previewProductPrices,
} from "./productWorkspace.js";
import "./AdminProductsSection.css";

const PRODUCT_COLUMNS = [
  {
    key: "product",
    label: "Product",
    width: 280,
    sticky: "left",
    required: true,
    defaultVisible: true,
  },
  {
    key: "sourceUnitPrice",
    label: "Vendor's Retail Price",
    width: 156,
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
    width: 170,
    defaultVisible: true,
  },
  {
    key: "memberPrice",
    label: "Member Adjusted $",
    width: 152,
    defaultVisible: true,
  },
  { key: "visible", label: "Visible", width: 96, defaultVisible: true },
  {
    key: "trackInventory",
    label: "Track Inventory",
    width: 132,
    defaultVisible: true,
  },
  { key: "inventory", label: "Stock", width: 90, defaultVisible: true },
  { key: "onSale", label: "Sale", width: 82, defaultVisible: true },
  { key: "saleDiscount", label: "Sale %", width: 96, defaultVisible: true },
  {
    key: "status",
    label: "Sync status",
    width: 170,
    required: true,
    defaultVisible: true,
  },
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
    width: 142,
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
  { key: "packages", label: "Packages", width: 340, defaultVisible: false },
  {
    key: "lastRemote",
    label: "Last Remote",
    width: 260,
    defaultVisible: false,
  },
  {
    key: "actions",
    label: "Actions",
    width: 154,
    sticky: "right",
    required: true,
    defaultVisible: true,
  },
];

const VIEW_COLUMNS = {
  overview: [
    "product",
    "vendor",
    "category",
    "packages",
    "basePrice",
    "guestPrice",
    "memberPrice",
    "inventory",
    "visible",
    "status",
    "actions",
  ],
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
    "status",
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
    "status",
    "actions",
  ],
};
const COLUMN_MAP = new Map(
  PRODUCT_COLUMNS.map((column) => [column.key, column]),
);
function pinColumns(keys) {
  const middle = [...new Set([...keys, "status"])].filter(
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
            (COLUMN_MAP.get(key).required || value.visibleColumns?.[key]),
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
const dateTime = (value) => (value ? new Date(value).toLocaleString() : "—");
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
  onOpenProductSync,
}) {
  const [view, setView] = useState("overview");
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
    status: "all",
    pricingType: "all",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState({ key: "product", direction: "asc" });
  const [data, setData] = useState({ rows: [], pagination: {}, summary: {} });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState([]);
  const rowCache = useRef(new Map());
  const requestId = useRef(0);
  const [reload, setReload] = useState(0);
  const [saveResults, setSaveResults] = useState([]);
  const [batches, setBatches] = useState([]);
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

  useEffect(() => {
    if (!capabilities.schedule) return;
    let cancelled = false;
    adminGet("product-sync/releases", token)
      .then((response) => {
        if (!cancelled) setBatches([...(response.legacy || []).map(batch => ({ ...batch, id: `legacy-${batch.id}` })), ...(response.releases || []).map(batch => ({ ...batch, items: batch.actions }))]);
      })
      .catch((error) => {
        if (!cancelled)
          setMessage(error.message || "Unable to load scheduled releases.");
      });
    return () => {
      cancelled = true;
    };
  }, [token, capabilities.schedule, reload, refreshNonce]);

  function filter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
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
        : "Local changes saved. Review & Sync when ready.",
    );
    setReload((value) => value + 1);
  }
  async function openReview(row = null) {
    if (!capabilities.sync || busy) return;
    const ids = row ? [row.productId] : selected;
    if ((ids.length ? ids : Object.keys(drafts).map(Number)).some(id => dirtyFields(drafts[id]).length)) {
      setMessage("Save local changes before auditing saved products, or use Schedule Changes for supported staged drafts.");
      return;
    }
    onOpenProductSync({ productIds: ids, staged: [], entries: [] });
  }
  async function openSchedule(saved = false) {
    if (!capabilities.schedule || busy) return;
    if (pendingDrafts.some(entry => unsupportedScheduleFields(entry).length) || (saved && pendingDrafts.length)) {
      setMessage("Save formula, package, and Details changes locally first. Only stock, tracking, visibility, and sales can be staged.");
      return;
    }
    if (saved) {
      onOpenProductSync({ productIds: selected, staged: [], entries: [] });
      return;
    }
    const entries = pendingDrafts;
    onOpenProductSync({ productIds: entries.map(entry => entry.meta.productId), entries,
      staged: entries.map(entry => {
        const update = buildScheduleUpdate(entry);
        const changed = new Set(dirtyFields(entry));
        update.changes = Object.fromEntries(Object.entries(update.changes).filter(([key]) => changed.has(key)));
        return update;
      })
    });
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
              {dirtyFields(drafts[row.productId]).length ? (
                <div className="small">Unsaved changes</div>
              ) : null}
            </div>
          </div>
        );
      case "vendor":
        return row.vendorName;
      case "category":
        return row.categoryName;
      case "status":
        return (
          <>
            <strong>{syncLabel(row)}</strong>
            {!(row.localLineProductId > 0) &&
            row.remoteSyncStatus === "failed" ? (
              <div className="small">Local-only</div>
            ) : null}
            {row.localLineProductId > 0 ? (
              <div className="small">Local Line #{row.localLineProductId}</div>
            ) : null}
            {row.remoteSyncMessage ? (
              <div className="small">{row.remoteSyncMessage}</div>
            ) : null}
            {batches
              .filter(
                (batch) =>
                  ["scheduled", "running"].includes(batch.status) &&
                  batch.items?.some(
                    (item) => Number(item.productId) === row.productId,
                  ),
              )
              .map((batch) => (
                <div className="small" key={batch.id}>
                  Scheduled: {dateTime(batch.scheduledAt)}
                </div>
              ))}
          </>
        );
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
      case "lastRemote":
        return (
          <>
            {dateTime(row.remoteSyncedAt)}
            <div className="small">{row.remoteSyncMessage}</div>
          </>
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
            <details>
              <summary>More</summary>
              {capabilities.sync ? (
                <button disabled={disabled} onClick={() => openReview(row)}>
                  Review & Sync
                </button>
              ) : null}
              {capabilities.edit ? (
                <>
                  <button
                    disabled={disabled}
                    onClick={() => onDuplicateProduct(row.productId)}
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={
                      disabled ||
                      (row.localLineProductId > 0 && !capabilities.push)
                    }
                    onClick={() => deleteRow(row)}
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </details>
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
      <h2 className="h2">Products</h2>
      <div className="admin-actions" role="tablist" aria-label="Product views">
        {Object.keys(VIEW_COLUMNS).map((key) => (
          <button
            className={`button ${view === key ? "" : "alt"}`}
            role="tab"
            aria-selected={view === key}
            key={key}
            onClick={() => setView(key)}
          >
            {key[0].toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>
      <p className="small">
        All views share filters, selections, and drafts. Save locally, then
        review Local Line and Square changes in Product Sync.
      </p>
      <div className="admin-filters">
        <label>
          Search
          <input
            className="input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Vendor
          <select
            className="input"
            value={filters.vendorId}
            onChange={(event) => filter("vendorId", event.target.value)}
          >
            <option value="">All vendors</option>
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
            value={filters.categoryId}
            onChange={(event) => filter("categoryId", event.target.value)}
          >
            <option value="">All categories</option>
            {categories
              .filter((c) => c.name?.trim().toLowerCase() !== "membership")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
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
          [
            "status",
            "Sync status",
            [
              ["all", "All"],
              ["local-only", "Local-only"],
              ["needsApply", "Needs push"],
              ["pending", "Pending"],
              ["failed", "Failed"],
              ["applied", "Synced"],
            ],
          ],
        ].map(([key, label, options]) => (
          <label key={key}>
            {label}
            <select
              className="input"
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
        <button
          className="button alt"
          onClick={() => {
            setFilters((prev) => ({
              ...prev,
              vendorId: "",
              pricingType: "formula",
            }));
            setPage(1);
          }}
        >
          Deck / Hyland / Creamy Cow
        </button>
      </div>
      <div className="admin-actions products-toolbar">
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
              className="button alt"
              disabled={saving || busy || !pendingDrafts.length}
              onClick={() => {
                if (window.confirm("Discard all unsaved product changes?"))
                  setDrafts({});
              }}
            >
              Discard Changes
            </button>
            <button
              className="button alt"
              disabled={saving || busy}
              onClick={onAddProduct}
            >
              Add Product
            </button>
          </>
        ) : null}
        {capabilities.sync ? (
          <button
            className="button alt"
            disabled={saving || busy}
            onClick={() => openReview()}
          >
            Review & Sync{" "}
            {selected.length
              ? `(${selected.length} selected)`
              : "(all products)"}
          </button>
        ) : null}
        <button
          className="button alt"
          onClick={() => setColumnsOpen(!columnsOpen)}
        >
          Columns
        </button>
        {capabilities.schedule ? (
          <>
            <button
              className="button alt"
              disabled={saving || busy || !pendingDrafts.length}
              onClick={() => openSchedule(false)}
            >
              Schedule Changes
            </button>
            <button
              className="button alt"
              disabled={saving || busy}
              onClick={() => openSchedule(true)}
            >
              Schedule Saved Products
            </button>
          </>
        ) : null}
      </div>
      {columnsOpen ? (
        <div className="products-columns">
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
                  disabled={column.required}
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
          <button onClick={() => saveColumns(view, columnsByView[view], true)}>
            Save as Default
          </button>
          <button onClick={() => changeColumns(loadColumns(view, true))}>
            Reset to Saved Default
          </button>
          <button onClick={() => changeColumns(VIEW_COLUMNS[view])}>
            App Default
          </button>
        </div>
      ) : null}
      <div role="status" className="small products-message">
        {loading ? "Loading products…" : message}
      </div>
      {selected.length ? (
        <div className="small">
          {selected.length} selected across all pages and filters.{" "}
          <button onClick={() => setSelected([])}>Clear selection</button>
        </div>
      ) : null}
      {pendingDrafts.length ? (
        <div className="small">
          {pendingDrafts.length} unsaved product
          {pendingDrafts.length === 1 ? "" : "s"} across all pages and filters.
        </div>
      ) : null}
      <div className="products-table-scroll">
        <table className="table products-table">
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
                  style={{ minWidth: column.width }}
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
      <div className="admin-actions">
        <span>
          {data.pagination?.totalRows || 0} products · Page {page} of{" "}
          {data.pagination?.totalPages || 1}
        </span>
        <button disabled={loading || page <= 1} onClick={() => setPage(1)}>
          First
        </button>
        <button
          disabled={loading || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <button
          disabled={loading || page >= (data.pagination?.totalPages || 1)}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
        <button
          disabled={loading || page >= (data.pagination?.totalPages || 1)}
          onClick={() => setPage(data.pagination.totalPages)}
        >
          Last
        </button>
        <label>
          Rows{" "}
          <select
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
      {capabilities.sync || capabilities.schedule ? <button className="button alt" onClick={() => onOpenProductSync({ history: true })}>View releases in Product Sync</button> : null}
    </section>
  );
}
