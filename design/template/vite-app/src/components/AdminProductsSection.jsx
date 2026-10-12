import React, { useEffect, useRef, useState } from "react";
import { adminGet } from "../adminApi.js";
import { categoryLabel } from "../categoryLabel.js";
import { ProductActionsMenu } from "./ProductActionsMenu.jsx";
import { InventoryFieldInfo, INVENTORY_FIELD_HELP } from "./InventoryFieldInfo.jsx";
import { CompactInventoryList } from "./CompactInventoryList.jsx";
import { mobileInventoryView, readMobileInventoryPages } from "./mobileInventoryView.js";
import {
  dirtyFields,
  hydrateProductDraft,
  patchProductDraft,
  previewProductPrices,
  INVENTORY_FIELDS,
  FULL_FARM_INVENTORY_FIELDS,
  inventorySaveSummary,
  reviewFarmStockConflict,
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
  { key: "visible", label: "Full Farm Visible", width: 120, defaultVisible: true },
  {
    key: "trackInventory",
    label: "Full Farm Track Inventory",
    width: 160,
    defaultVisible: true,
  },
  { key: "inventory", label: "Full Farm Stock", width: 130, defaultVisible: true },
  { key: "stockOnFarm", label: "Stock on Farm", width: 165, defaultVisible: false, inventoryOnly: true },
  { key: "stockOnFarmLbs", label: "On-farm inventory (lbs)", width: 165, defaultVisible: false, inventoryOnly: true },
  { key: "onSale", label: "Sale", width: 82, defaultVisible: true },
  { key: "saleDiscount", label: "Sale %", width: 96, defaultVisible: true },

  { key: "category", label: "Category", width: 160, defaultVisible: false },
  { key: "vendor", label: "Vendor", width: 170, defaultVisible: false },
  { key: "pricingRule", label: "Rule", width: 150, defaultVisible: false },
  { key: "markupOverride", label: "Product Markup %", description: "Leave blank to use the vendor default.", width: 150, defaultVisible: false },
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
    "stockOnFarm",
    "inventory",
    "trackInventory",
    "visible",
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
    (key) => COLUMN_MAP.has(key) && !COLUMN_MAP.get(key).inventoryOnly && !["product", "actions"].includes(key),
  );
  return ["product", ...middle, "actions"];
}
function loadColumns(view, defaults = false) {
  if (view === "inventory") return VIEW_COLUMNS.inventory;
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
          ...PRODUCT_COLUMNS.filter(c => !c.inventoryOnly).map((c) => c.key),
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
  view = "pricing",
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
    vendorId: view === "inventory" ? DECK_ENTERPRISES : "",
    visibility: "all",
    sale: "all",
    pricingType: "all",
    stockOnFarm: "all",
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
  const compactInventory = view === "inventory";
  const [mobileFilter, setMobileFilter] = useState("all");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileLoaded, setMobileLoaded] = useState(false);
  const mobile = mobileInventoryView(data.rows, drafts, search, mobileFilter, filters.stockOnFarm);
  const requestSearch = compactInventory ? "" : debouncedSearch;
  const pendingDrafts = Object.values(drafts).filter(
    (entry) => dirtyFields(entry).length,
  );
  const inventoryDrafts = pendingDrafts.filter(entry => dirtyFields(entry).some(key => INVENTORY_FIELDS.includes(key)));
  const saveCount = view === "inventory" ? inventoryDrafts.length : pendingDrafts.length;
  const otherDrafts = pendingDrafts.filter(entry => dirtyFields(entry).some(key => !INVENTORY_FIELDS.includes(key)));
  const columnKeys = view === "inventory" ? VIEW_COLUMNS.inventory : columnsByView[view] || VIEW_COLUMNS[view];
  const columns = columnKeys
    .map((key) => COLUMN_MAP.get(key))
    .filter(Boolean);
  const tableWidth = (view === "inventory" ? 0 : 44) + columns.reduce((sum, column) => sum + column.width, 0);

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
      stockOnFarm: view === "inventory" && !compactInventory ? filters.stockOnFarm : "all",
      vendorId: filters.vendorId === DECK_ENTERPRISES ? "" : filters.vendorId,
      vendorGroup:
        filters.vendorId === DECK_ENTERPRISES ? DECK_ENTERPRISES : "",
      search: requestSearch,
      page: String(compactInventory ? 1 : page),
      pageSize: String(compactInventory ? 200 : pageSize),
      sortKey: sort.key,
      sortDirection: sort.direction,
    });
    setLoading(true);
    if (compactInventory) setMobileLoaded(false);
    const request = compactInventory
      ? readMobileInventoryPages(nextPage => {
        const nextParams = new URLSearchParams(params);
        nextParams.set("page", String(nextPage));
        return adminGet(`pricelist?${nextParams}`, token);
      }, () => cancelled)
      : adminGet(`pricelist?${params}`, token);
    request
      .then((response) => {
        if (!response || cancelled || requestId.current !== id) return;
        for (const row of response.rows || [])
          rowCache.current.set(row.productId, row);
        setData(response);
        if (compactInventory) setMobileLoaded(true);
        if (!compactInventory && response.pagination?.page && response.pagination.page !== page)
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
    view,
    compactInventory,
    filters,
    requestSearch,
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
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    setColumnsOpen(false);
    if (view === "inventory") {
      setFilters(prev => ({ ...prev, vendorId: DECK_ENTERPRISES }));
      setPage(1);
    }
  }, [view]);
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
  function reviewFarmCount(productId, keepDraft) {
    setDrafts(prev => ({ ...prev, [productId]: reviewFarmStockConflict(prev[productId], keepDraft) }));
    setSaveResults(prev => prev.filter(result => result.productId !== productId));
    setMessage(keepDraft ? "Your farm count is retained. Save again to apply it. Other unsaved edits are unchanged." : "Latest farm count loaded. Other unsaved edits are unchanged.");
  }
  async function refresh() {
    setReload((value) => value + 1);
    await onDataRefresh?.();
    await onCatalogRefresh?.();
  }
  async function save() {
    const inventoryOnly = view === "inventory";
    const results = await onSave(null, { inventoryOnly, onProgress: setMessage });
    setSaveResults(results);
    setMessage(
      results.some((result) => !result.ok)
        ? "Some changes could not be saved. The remaining edits are still available below."
        : inventoryOnly ? [...new Set(results.map(inventorySaveSummary))].join(". ") : "Local changes saved.",
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
  function cell(column, row, compact = false) {
    const values =
      drafts[row.productId]?.values || hydrateProductDraft(null, row).values;
    const prices = previewProductPrices(row, values);
    const disabled = saving || busy || (view === "inventory" && (![...INVENTORY_FIELDS, "actions"].includes(column.key) || (FULL_FARM_INVENTORY_FIELDS.includes(column.key) && !capabilities.inventoryPush)));
    const numericInput = (key, pricing = false) => (
      <input
        aria-label={`${column.label}: ${row.name}`}
        className="input products-number"
        type="number"
        inputMode={key === "inventory" ? "numeric" : "decimal"}
        step={key === "inventory" ? "1" : "any"}
        min="0"
        disabled={
          disabled || !(pricing ? capabilities.pricing : capabilities.edit) || (view === "inventory" && key === "inventory" && !values.trackInventory)
        }
        title={view === "inventory" && key === "inventory" && !values.trackInventory ? "Enable Full Farm Track Inventory to edit Full Farm Stock." : undefined}
        value={values[key]}
        onChange={(event) =>
          patch(row, {
            [key]: pricing ? event.target.value : Number(event.target.value),
          })
        }
      />
    );
    switch (column.key) {
      case "stockOnFarmLbs":
        return <input className="input compact-farm-pounds" aria-label={`On-farm inventory (lbs): ${row.name}`}
          type="text" inputMode="decimal" placeholder="Unknown" value={values.stockOnFarmLbs}
          disabled={disabled || !capabilities.edit}
          onChange={event => patch(row, { stockOnFarmLbs: event.target.value })} />;
      case "stockOnFarm":
        if (compact) return <div className="compact-farm-status" role="group" aria-label={`Stock on Farm: ${row.name}`}>
          {[[null, "?", "Not checked"], [true, "Yes", "On farm"], [false, "No", "Not on farm"]].map(([value, text, label]) =>
            <button key={text} type="button" aria-label={`${label}: ${row.name}`} aria-pressed={values.stockOnFarm === value}
              disabled={disabled || !capabilities.edit || (value === null && (drafts[row.productId]?.defaults.stockOnFarm ?? row.stockOnFarm) != null)}
              onClick={() => patch(row, { stockOnFarm: value })}>{text}</button>,
          )}
        </div>;
        return <select className="input" aria-label={`Stock on Farm: ${row.name}`}
          disabled={disabled || !capabilities.edit} value={values.stockOnFarm == null ? "" : String(values.stockOnFarm)}
          onChange={event => patch(row, { stockOnFarm: event.target.value === "true" })}>
          <option value="" disabled>Not checked</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>;
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
                  !columnKeys.includes("vendor") && row.vendorName,
                  !columnKeys.includes("category") &&
                    categoryLabel(row.categoryName),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {!columnKeys.includes("packages") &&
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
        if (column.key === 'onSale' && values.customerPriceOverrides?.length) return <span className="small">By group · Details</span>;
        const checkbox = (
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
        return view === "inventory" ? <label className="products-inventory-checkbox">{checkbox}</label> : checkbox;
      case "inventory":
      case "saleDiscount":
        if (column.key === 'saleDiscount' && values.customerPriceOverrides?.length) return <span className="small">By group</span>;
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
      case "markupOverride":
        return row.usesSourcePricing || row.usesNoMarkupPricing ? "—" : numericInput(column.key, true);
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
            : values.markupOverride !== "" ? "Product markup" : "Standard";
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
    <section className={`admin-section products-workspace${view === "inventory" ? " products-inventory-workspace" : ""}${compactInventory ? " compact-inventory-workspace" : ""}`}>
      <div className="products-heading">
        <h2 className="h2">{compactInventory ? "Farm Inventory" : view === "inventory" ? "Inventory" : "Pricing"}</h2>
        {compactInventory && <span className="compact-inventory-progress-text" role="status">
          {loading ? "Loading…" : mobileLoaded ? `${mobile.checked} / ${mobile.total} checked` : "Progress unavailable"}
        </span>}
        <div className="products-button-group">
          {view === "pricing" && <button
            className="button alt"
            aria-expanded={columnsOpen}
            aria-controls="products-columns"
            onClick={() => setColumnsOpen(!columnsOpen)}
          >
            Columns
          </button>}
          {capabilities.edit && !compactInventory ? (
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
      {compactInventory && <progress className="compact-inventory-progress" aria-label="Farm inventory checked" max={mobile.total || 1}
        value={mobileLoaded && !loading ? mobile.checked : undefined} />}
      <p className="small products-inventory-description">
        {view === "inventory" ? "Save Inventory Changes saves Stock on Farm locally and confirms changed Full Farm fields in Local Line. Full Farm Track Inventory enables stock limits; Full Farm Visible controls storefront availability. Stock on Farm records physical availability anywhere in a farm freezer or fridge, independently of Full Farm inventory."
          : "Manage product details and pricing. Save changes locally; syncing and scheduling are in Product Sync. Use Inventory to send stock, tracking, and visibility changes directly to Local Line."}
      </p>
      {view === "inventory" && !capabilities.inventoryPush && <p className="small">Stock on Farm can be saved locally. Saving Full Farm fields requires Inventory Admin, or product editing and Local Line Push permissions.</p>}
      {view === "inventory" && otherDrafts.length > 0 && <p className="small">{otherDrafts.length} products have other unsaved changes. Switch to Pricing to save those separately.</p>}
      <div className={`admin-filters${compactInventory && !mobileFiltersOpen ? " compact-filters-collapsed" : ""}`}>
        <label>
          Search
          <input
            className="input"
            type="search"
            aria-label="Search"
            placeholder={compactInventory ? "Search products…" : undefined}
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
          ...(view === "inventory" ? [[
            "stockOnFarm",
            "Stock on Farm",
            [
              ["all", "All"],
              ["not-checked", "Not checked"],
              ["true", "True"],
              ["false", "False"],
            ],
          ]] : []),
          [
            "visibility",
            "Full Farm Visibility",
            [
              ["all", "All"],
              ["visible", "Full Farm Visible"],
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
        {view === "inventory" && <label className="products-mobile-sort">
          Sort by
          <select className="input" aria-label="Sort inventory" value={`${sort.key}:${sort.direction}`}
            onChange={event => {
              const [key, direction] = event.target.value.split(":");
              setSort({ key, direction });
              setPage(1);
            }}>
            {!VIEW_COLUMNS.inventory.includes(sort.key) && <option value={`${sort.key}:${sort.direction}`}>
              {COLUMN_MAP.get(sort.key)?.label || sort.key} ({sort.direction === "asc" ? "Low–high" : "High–low"})
            </option>}
            {columns.filter(column => column.key !== "stockOnFarm").flatMap(column =>
              ["asc", "desc"].map(direction => <option key={`${column.key}:${direction}`} value={`${column.key}:${direction}`}>
                {column.label} ({["product", "vendor"].includes(column.key)
                  ? direction === "asc" ? "A–Z" : "Z–A"
                  : column.key === "inventory" ? direction === "asc" ? "Low–high" : "High–low"
                    : direction === "asc" ? "Off first" : "On first"})
              </option>),
            )}
          </select>
        </label>}
      </div>
      {compactInventory && <>
        <div className="compact-inventory-tabs" role="group" aria-label="Farm inventory status">
          {[["all", "All"], ["not-checked", "Not checked"], ["checked", "Checked"]].map(([key, label]) =>
            <button type="button" key={key} aria-pressed={mobileFilter === key} onClick={() => setMobileFilter(key)}>{label}</button>,
          )}
        </div>
        <div className="compact-inventory-options">
          <button type="button" className="products-text-button compact-inventory-filter-toggle" aria-expanded={mobileFiltersOpen} onClick={() => setMobileFiltersOpen(open => !open)}>
            {mobileFiltersOpen ? "Fewer filters" : "Filters & sort"}
          </button>
          <span>{filters.vendorId === DECK_ENTERPRISES ? "Deck Enterprises" : vendors.find(v => String(v.id) === String(filters.vendorId))?.name || "All vendors"}</span>
          {capabilities.edit && <button type="button" className="products-text-button" disabled={saving || busy} onClick={onAddProduct}>Add product</button>}
        </div>
      </>}
      <div className="products-toolbar">
        <div className="products-button-group">
          {capabilities.edit ? (
            <>
              <button
                className="button"
                aria-label={compactInventory ? `Save Inventory Changes (${saveCount})` : undefined}
                disabled={saving || busy || !saveCount}
                onClick={save}
              >
                {compactInventory ? saving ? "Saving…" : `Save (${saveCount})` : saving
                  ? view === "inventory" ? "Saving inventory changes…" : "Saving…"
                  : view === "inventory" ? `Save Inventory Changes (${saveCount})` : `Save Local Changes (${saveCount})`}
              </button>
              <button
                className="button alt products-discard"
                disabled={saving || busy || !pendingDrafts.length}
                onClick={() => {
                  if (window.confirm("Discard all unsaved product changes?"))
                    setDrafts({});
                }}
              >
                {compactInventory ? "Discard" : "Discard Changes"}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {view === "pricing" && columnsOpen ? (
        <div className="products-columns" id="products-columns">
          <strong>{view} columns</strong>
          {[
            ...columns,
            ...PRODUCT_COLUMNS.filter(
              (column) => !column.inventoryOnly && !columnsByView[view].includes(column.key),
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
      {view === "pricing" && selected.length ? (
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
        <div className="small products-unsaved-summary">
          {pendingDrafts.length} unsaved product
          {pendingDrafts.length === 1 ? "" : "s"} across all pages and filters.
        </div>
      ) : null}
      {compactInventory ? <>
        {!loading && !mobileLoaded && <button className="button alt" onClick={refresh}>Retry loading products</button>}
        <CompactInventoryList rows={mobile.rows} drafts={drafts} saving={saving} saveResults={saveResults} loading={loading}
          renderField={(key, row) => cell(COLUMN_MAP.get(key), row, true)} />
      </> : <>
      <div
        className={`products-table-scroll${view === "inventory" ? " products-inventory-scroll" : ""}`}
        role="region"
        aria-label={view === "inventory" ? "Inventory table" : "Products table, scroll for more columns"}
        tabIndex={0}
      >
        <table
          className={`table products-table${view === "inventory" ? " products-inventory-table" : ""}`}
          role="table"
          style={{
            minWidth: view === "inventory" ? undefined : tableWidth,
          }}
        >
          <colgroup>
            {view === "pricing" && <col style={{ width: 44 }} />}
            {columns.map((column) => (
              <col
                key={column.key}
                className={`products-col-${column.key}`}
                style={{
                  width: view === "inventory" || column.key === "product" ? undefined : column.width,
                }}
              />
            ))}
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              {view === "pricing" && <th>
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
              </th>}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={view === "inventory" && column.key === "stockOnFarm" ? "products-inventory-start" : undefined}
                  title={column.description}
                  aria-sort={
                    sort.key === column.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <span className="products-column-heading">
                  {column.key === "stockOnFarm" || column.key === "actions" ? (
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
                  {INVENTORY_FIELD_HELP[column.key] && <InventoryFieldInfo field={column.key} label={column.label} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {data.rows.map((row) => (
              <tr key={row.productId} role="row">
                {view === "pricing" && <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={selected.includes(row.productId)}
                    onChange={() =>
                      setSelected((prev) => toggleId(prev, row.productId))
                    }
                  />
                </td>}
                {columns.map((column) => (
                  <td key={column.key} role="cell" className={`products-cell-${column.key}${view === "inventory" && column.key === "stockOnFarm" ? " products-inventory-start" : ""}`}>
                    {view === "inventory" && column.key !== "product" && <span className="products-mobile-label">
                      <span>{column.label}</span>
                      {INVENTORY_FIELD_HELP[column.key] && <InventoryFieldInfo field={column.key} label={column.label} />}
                    </span>}
                    {cell(column, row)}
                  </td>
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
      </>}
      {saveResults.length ? (
        <details open>
          <summary>Save results</summary>
          {saveResults.map((result) => (
            <p key={result.productId} className="small">
              {result.productName}:{" "}
              {result.inventoryOnly ? inventorySaveSummary(result) : result.ok
                ? "Saved locally"
                : result.partial
                  ? "Partially saved"
                  : "Failed"}
              {result.errors?.length ? ` — ${result.errors.join("; ")}` : ""}
              {drafts[result.productId]?.meta.farmStockConflict && <span className="farm-stock-conflict" role="alert">
                Latest saved: {drafts[result.productId].meta.farmStockConflict.stockOnFarmLbs ?? "Unknown"} lbs
                {" · "}{drafts[result.productId].meta.farmStockConflict.stockOnFarm === null ? "Not checked" : drafts[result.productId].meta.farmStockConflict.stockOnFarm ? "Yes" : "No"}.
                {" "}Your edit: {drafts[result.productId].values.stockOnFarmLbs || "Unknown"} lbs.
                <span className="products-button-group">
                  <button className="button secondary" type="button" disabled={saving} onClick={() => reviewFarmCount(result.productId, false)}>Use latest saved count</button>
                  <button className="button secondary" type="button" disabled={saving} onClick={() => reviewFarmCount(result.productId, true)}>Keep my edit for next save</button>
                </span>
              </span>}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
