import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";

const COLUMN_STORAGE_KEY = "adminPricelistColumnPrefs.v1";
const COLUMN_DEFAULT_STORAGE_KEY = "adminPricelistColumnDefaultPrefs.v1";

const PRICELIST_COLUMNS = [
  { key: "edit", label: "Edit", width: 88, sticky: true, required: true, defaultVisible: true },
  { key: "details", label: "Details", width: 104, sticky: true, required: true, defaultVisible: true },
  { key: "apply", label: "Push", width: 104, sticky: true, required: true, defaultVisible: true },
  { key: "status", label: "Status", width: 150, sticky: true, defaultVisible: true },
  { key: "product", label: "Product", width: 260, sticky: true, required: true, defaultVisible: true },
  { key: "category", label: "Category", width: 160, defaultVisible: true },
  { key: "vendor", label: "Vendor", width: 170, defaultVisible: true },
  { key: "pricingRule", label: "Rule", width: 150, defaultVisible: true },
  { key: "sourceUnitPrice", label: "DFF Source Price", width: 136, defaultVisible: true },
  { key: "unit", label: "DFF Unit Type", width: 128, defaultVisible: true },
  { key: "minWeight", label: "Min Wt", width: 100, defaultVisible: false },
  { key: "maxWeight", label: "Max Wt", width: 100, defaultVisible: false },
  { key: "avgWeightOverride", label: "Avg Wt", width: 100, defaultVisible: false },
  { key: "sourceMultiplier", label: "Factor", width: 100, defaultVisible: false },
  { key: "basePrice", label: "Base Price", width: 120, defaultVisible: false },
  { key: "guestMarkup", label: "Guest %", width: 106, defaultVisible: false },
  { key: "guestPrice", label: "Guest $", width: 106, defaultVisible: false },
  { key: "memberMarkup", label: "Member %", width: 110, defaultVisible: false },
  { key: "memberPrice", label: "Member $", width: 110, defaultVisible: false },
  { key: "herdShareMarkup", label: "Herd %", width: 100, defaultVisible: false },
  { key: "herdSharePrice", label: "Herd $", width: 100, defaultVisible: false },
  { key: "snapMarkup", label: "SNAP %", width: 100, defaultVisible: false },
  { key: "snapPrice", label: "SNAP $", width: 100, defaultVisible: false },
  { key: "onSale", label: "Sale", width: 82, defaultVisible: true },
  { key: "saleDiscount", label: "Sale %", width: 96, defaultVisible: true },
  { key: "packages", label: "Packages", width: 340, defaultVisible: true },
  { key: "lastRemote", label: "Last Remote", width: 260, defaultVisible: false }
];

const PRICELIST_COLUMN_MAP = new Map(PRICELIST_COLUMNS.map((column) => [column.key, column]));
const BUILT_IN_COLUMN_ORDER = PRICELIST_COLUMNS.map((column) => column.key);

function getDefaultVisibleColumns() {
  return PRICELIST_COLUMNS.reduce((acc, column) => {
    acc[column.key] = column.defaultVisible !== false;
    return acc;
  }, {});
}

function getBuiltInColumnPreferences() {
  return {
    visibleColumns: getDefaultVisibleColumns(),
    columnOrder: [...BUILT_IN_COLUMN_ORDER]
  };
}

function normalizeColumnOrder(columnOrder) {
  const uniqueKeys = new Set();
  const normalized = Array.isArray(columnOrder)
    ? columnOrder.filter((key) => {
        if (!PRICELIST_COLUMN_MAP.has(key) || uniqueKeys.has(key)) {
          return false;
        }
        uniqueKeys.add(key);
        return true;
      })
    : [];

  for (const key of BUILT_IN_COLUMN_ORDER) {
    if (!uniqueKeys.has(key)) {
      normalized.push(key);
    }
  }

  return normalized;
}

function normalizeVisibleColumns(visibleColumns) {
  const defaults = getDefaultVisibleColumns();
  return PRICELIST_COLUMNS.reduce((acc, column) => {
    acc[column.key] = column.required ? true : visibleColumns?.[column.key] !== false && defaults[column.key] !== false;
    if (visibleColumns && Object.prototype.hasOwnProperty.call(visibleColumns, column.key)) {
      acc[column.key] = column.required ? true : visibleColumns[column.key] !== false;
    }
    return acc;
  }, {});
}

function normalizeColumnPreferences(preferences, fallback = getBuiltInColumnPreferences()) {
  return {
    visibleColumns: normalizeVisibleColumns(preferences?.visibleColumns || fallback.visibleColumns),
    columnOrder: normalizeColumnOrder(preferences?.columnOrder || fallback.columnOrder)
  };
}

function loadStoredColumnPreferences(storageKey, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    return normalizeColumnPreferences(JSON.parse(raw), fallback);
  } catch (_error) {
    return fallback;
  }
}

function loadDefaultColumnPreferences() {
  const builtIn = getBuiltInColumnPreferences();
  return loadStoredColumnPreferences(COLUMN_DEFAULT_STORAGE_KEY, builtIn);
}

function loadCurrentColumnPreferences() {
  const defaults = loadDefaultColumnPreferences();
  return loadStoredColumnPreferences(COLUMN_STORAGE_KEY, defaults);
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMembershipCategoryName(value) {
  return normalizeCategoryName(value) === "membership";
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function toPercentValue(value) {
  const numeric = toNumber(value);
  return numeric === null ? "" : String(roundCurrency(numeric * 100));
}

function normalizeRowForEdit(row) {
  return {
    productId: row.productId,
    unitOfMeasure: row.usesSourcePricing ? row.unitOfMeasure || "each" : "",
    sourceUnitPrice: row.usesSourcePricing ? row.sourceUnitPrice ?? "" : "",
    minWeight: row.usesSourcePricing ? row.minWeight ?? "" : "",
    maxWeight: row.usesSourcePricing ? row.maxWeight ?? "" : "",
    avgWeightOverride: row.usesSourcePricing ? row.avgWeightOverride ?? "" : "",
    sourceMultiplier: row.usesSourcePricing ? row.sourceMultiplier ?? 0.5412 : "",
    guestMarkup: toPercentValue(row.guestMarkup),
    memberMarkup: toPercentValue(row.memberMarkup),
    herdShareMarkup: toPercentValue(row.herdShareMarkup),
    snapMarkup: toPercentValue(row.snapMarkup),
    onSale: Boolean(row.onSale),
    saleDiscount: toPercentValue(row.saleDiscount)
  };
}

function draftsMatchRow(draft, row) {
  if (!draft) return true;
  return JSON.stringify(draft) === JSON.stringify(normalizeRowForEdit(row));
}

function computeAverageWeight(values, pkg) {
  const overrideWeight = toNumber(values.avgWeightOverride);
  if (overrideWeight !== null && overrideWeight > 0) return overrideWeight;

  const packageWeight = toNumber(pkg?.averageWeight);
  if (packageWeight !== null && packageWeight > 0) return packageWeight;

  const minWeight = toNumber(values.minWeight);
  const maxWeight = toNumber(values.maxWeight);
  if (minWeight !== null && maxWeight !== null) return (minWeight + maxWeight) / 2;
  if (minWeight !== null) return minWeight;
  if (maxWeight !== null) return maxWeight;
  return null;
}

function computePreview(row, draft) {
  const values = draft || normalizeRowForEdit(row);
  if (!row.usesSourcePricing) {
    const basePrice = toNumber(row.basePrice);
    const saleEnabled = Boolean(values.onSale);
    const saleDiscount = Math.max(0, Math.min((toNumber(values.saleDiscount) || 0) / 100, 1));

    function computeFinal(markupPercent) {
      if (basePrice === null) return null;
      const markup = Math.max(0, (toNumber(markupPercent) || 0) / 100);
      const regular = roundCurrency(basePrice * (1 + markup));
      return saleEnabled && saleDiscount > 0
        ? roundCurrency(regular * (1 - saleDiscount))
        : regular;
    }

    return {
      basePrice,
      guestPrice: computeFinal(values.guestMarkup),
      memberPrice: computeFinal(values.memberMarkup),
      herdSharePrice: computeFinal(values.herdShareMarkup),
      snapPrice: computeFinal(values.snapMarkup)
    };
  }

  const sourceUnitPrice = toNumber(values.sourceUnitPrice);
  const sourceMultiplier = toNumber(values.sourceMultiplier);
  if (sourceUnitPrice === null || sourceMultiplier === null) {
    return {
      basePrice: null,
      guestPrice: null,
      memberPrice: null,
      herdSharePrice: null,
      snapPrice: null
    };
  }

  const packagePrices = (row.packages || [])
    .map((pkg) => {
      if (values.unitOfMeasure === "lbs") {
        const averageWeight = computeAverageWeight(values, pkg);
        if (averageWeight === null || averageWeight <= 0) return null;
        return roundCurrency(sourceUnitPrice * averageWeight * sourceMultiplier);
      }
      const quantity = Math.max(toNumber(pkg.quantity) || 1, 1);
      return roundCurrency(sourceUnitPrice * quantity * sourceMultiplier);
    })
    .filter((value) => value !== null);

  const basePrice = packagePrices.length ? Math.min(...packagePrices) : null;
  const saleEnabled = Boolean(values.onSale);
  const saleDiscount = Math.max(0, Math.min((toNumber(values.saleDiscount) || 0) / 100, 1));

  function computeFinal(markupPercent) {
    if (basePrice === null) return null;
    const markup = Math.max(0, (toNumber(markupPercent) || 0) / 100);
    const regular = roundCurrency(basePrice * (1 + markup));
    return saleEnabled && saleDiscount > 0
      ? roundCurrency(regular * (1 - saleDiscount))
      : regular;
  }

  return {
    basePrice,
    guestPrice: computeFinal(values.guestMarkup),
    memberPrice: computeFinal(values.memberMarkup),
    herdSharePrice: computeFinal(values.herdShareMarkup),
    snapPrice: computeFinal(values.snapMarkup)
  };
}

function formatMoney(value) {
  const numeric = toNumber(value);
  return numeric === null ? "n/a" : `$${numeric.toFixed(2)}`;
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export function AdminPriceListSection({
  token,
  categories,
  vendors,
  onDataRefresh,
  onCatalogRefresh,
  onReviewLocalLine,
  reviewLocalLineLoading = false,
  onPullFromLocalLine,
  pullFromLocalLineLoading = false,
  pullFromLocalLineRunning = false,
  onOpenProductDetails
}) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [message, setMessage] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [drafts, setDrafts] = useState({});
  const [editingRows, setEditingRows] = useState({});
  const [saving, setSaving] = useState(false);
  const [applyingProductIds, setApplyingProductIds] = useState([]);
  const [exportingGoogle, setExportingGoogle] = useState(false);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(() => loadCurrentColumnPreferences().visibleColumns);
  const [columnOrder, setColumnOrder] = useState(() => loadCurrentColumnPreferences().columnOrder);
  const columnPickerRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      COLUMN_STORAGE_KEY,
      JSON.stringify({
        visibleColumns,
        columnOrder
      })
    );
  }, [visibleColumns, columnOrder]);

  useEffect(() => {
    if (!columnPickerOpen) return undefined;

    function handlePointerDown(event) {
      if (!columnPickerRef.current?.contains(event.target)) {
        setColumnPickerOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setColumnPickerOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnPickerOpen]);

  async function loadPriceList() {
    if (!token) return;
    setLoading(true);
    try {
      const response = await adminGet("pricelist", token);
      setRows(response.rows || []);
      setDrafts({});
      setEditingRows({});
    } catch (_error) {
      setMessage("Failed to load pricelist.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPriceList();
  }, [token]);

  function updateDraft(productId, patch) {
    const row = rows.find((item) => item.productId === productId);
    if (!row) return;
    setDrafts((prev) => ({
      ...prev,
      [productId]: {
        ...(prev[productId] || normalizeRowForEdit(row)),
        ...patch
      }
    }));
  }

  function toggleEditing(productId) {
    setEditingRows((prev) => ({
      ...prev,
      [productId]: !prev[productId]
    }));
  }

  function setColumnVisibility(key, nextVisible) {
    setVisibleColumns((prev) => ({
      ...prev,
      [key]: nextVisible
    }));
  }

  function resetColumnsToDefaults() {
    const defaults = loadDefaultColumnPreferences();
    setVisibleColumns(defaults.visibleColumns);
    setColumnOrder(defaults.columnOrder);
    setMessage("Column layout reset to saved default.");
  }

  function resetColumnsToBuiltInDefaults() {
    const defaults = getBuiltInColumnPreferences();
    setVisibleColumns(defaults.visibleColumns);
    setColumnOrder(defaults.columnOrder);
    setMessage("Column layout reset to app default.");
  }

  function showAllColumns() {
    setVisibleColumns(
      PRICELIST_COLUMNS.reduce((acc, column) => {
        acc[column.key] = true;
        return acc;
      }, {})
    );
  }

  function moveColumn(key, direction) {
    setColumnOrder((prev) => {
      const currentIndex = prev.indexOf(key);
      if (currentIndex < 0) return prev;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const nextOrder = [...prev];
      [nextOrder[currentIndex], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[currentIndex]];
      return nextOrder;
    });
  }

  function saveCurrentColumnsAsDefault() {
    if (typeof window === "undefined") return;
    const preferences = {
      visibleColumns,
      columnOrder
    };
    window.localStorage.setItem(COLUMN_DEFAULT_STORAGE_KEY, JSON.stringify(preferences));
    setMessage("Saved current column layout as default.");
  }

  const dirtyProductIds = rows
    .filter((row) => !draftsMatchRow(drafts[row.productId], row))
    .map((row) => row.productId);

  const filteredRows = rows.filter((row) => {
    const searchNeedle = productSearch.trim().toLowerCase();
    const searchMatch = !searchNeedle || String(row.name || "").toLowerCase().includes(searchNeedle);
    const categoryMatch = !categoryFilter || String(row.categoryId || "") === categoryFilter;
    const vendorMatch = !vendorFilter || String(row.vendorId || "") === vendorFilter;
    const statusMatch =
      statusFilter === "all" ||
      (statusFilter === "needsApply" && row.hasPendingRemoteApply) ||
      (statusFilter !== "needsApply" && row.remoteSyncStatus === statusFilter);
    return searchMatch && categoryMatch && vendorMatch && statusMatch;
  });

  const orderedColumnDefs = columnOrder
    .map((key) => PRICELIST_COLUMN_MAP.get(key))
    .filter(Boolean);
  const visibleColumnDefs = orderedColumnDefs.filter(
    (column) => column.required || visibleColumns[column.key] !== false
  );
  const pricelistTableWidth = `${visibleColumnDefs.reduce((sum, column) => sum + column.width, 0)}px`;
  const stickyLeftByKey = {};
  let stickyOffset = 0;
  visibleColumnDefs.forEach((column) => {
    if (!column.sticky) return;
    stickyLeftByKey[column.key] = stickyOffset;
    stickyOffset += column.width;
  });

  async function handleSaveChanges() {
    if (!dirtyProductIds.length) return;
    setSaving(true);
    setMessage("");
    try {
      await adminPost("pricelist/bulk-save", token, {
        rows: dirtyProductIds.map((productId) => {
          const draft = drafts[productId];
          return {
            productId,
            unitOfMeasure: draft.unitOfMeasure,
            sourceUnitPrice: draft.sourceUnitPrice === "" ? null : Number(draft.sourceUnitPrice),
            minWeight: draft.minWeight === "" ? null : Number(draft.minWeight),
            maxWeight: draft.maxWeight === "" ? null : Number(draft.maxWeight),
            avgWeightOverride:
              draft.avgWeightOverride === "" ? null : Number(draft.avgWeightOverride),
            sourceMultiplier: draft.sourceMultiplier === "" ? null : Number(draft.sourceMultiplier),
            guestMarkup: draft.guestMarkup === "" ? null : Number(draft.guestMarkup) / 100,
            memberMarkup: draft.memberMarkup === "" ? null : Number(draft.memberMarkup) / 100,
            herdShareMarkup:
              draft.herdShareMarkup === "" ? null : Number(draft.herdShareMarkup) / 100,
            snapMarkup: draft.snapMarkup === "" ? null : Number(draft.snapMarkup) / 100,
            onSale: Boolean(draft.onSale),
            saleDiscount: draft.saleDiscount === "" ? 0 : Number(draft.saleDiscount) / 100
          };
        })
      });
      setMessage("Local pricelist changes saved.");
      await loadPriceList();
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
      if (typeof onCatalogRefresh === "function") {
        await onCatalogRefresh();
      }
    } catch (_error) {
      setMessage("Failed to save pricelist changes.");
    } finally {
      setSaving(false);
    }
  }

  async function applyRemote(productIds) {
    if (!productIds.length) return;
    setApplyingProductIds(productIds);
    setMessage("");
    try {
      const response = await adminPost("pricelist/apply-remote", token, { productIds });
      const failures = (response.results || []).filter((row) => !row.ok);
      setMessage(
        failures.length
          ? failures.map((row) => `${row.productId}: ${row.message}`).join(" | ")
          : "Pricing applied to the remote store."
      );
      await loadPriceList();
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
      if (typeof onCatalogRefresh === "function") {
        await onCatalogRefresh();
      }
    } catch (_error) {
      setMessage("Failed to apply pricelist remotely.");
    } finally {
      setApplyingProductIds([]);
    }
  }

  async function exportGooglePricelist() {
    setExportingGoogle(true);
    setMessage("");
    try {
      const response = await adminPost("pricelist/export-google", token, {});
      const vendorSummary = Array.isArray(response.vendorNames) && response.vendorNames.length
        ? response.vendorNames.join(", ")
        : "No matching vendors";
      setMessage(
        `Google pricelist updated with ${response.rowCount || 0} rows: ${vendorSummary}`
      );
    } catch (error) {
      setMessage(error?.message || "Failed to export Google pricelist.");
    } finally {
      setExportingGoogle(false);
    }
  }

  const remoteReadyProductIds = rows
    .filter((row) => row.hasPendingRemoteApply && !dirtyProductIds.includes(row.productId))
    .map((row) => row.productId);
  const pricelistCategories = categories.filter(
    (category) => !isMembershipCategoryName(category.name)
  );
  const sortedVendors = vendors
    .slice()
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

  function getColumnCellStyle(column) {
    return {
      minWidth: `${column.width}px`,
      width: `${column.width}px`,
      ...(column.sticky ? { left: `${stickyLeftByKey[column.key] || 0}px` } : {})
    };
  }

  function renderCell(column, row, draft, preview, editing, dirty, isApplying) {
    switch (column.key) {
      case "edit":
        return (
          <button className="button alt" type="button" onClick={() => toggleEditing(row.productId)}>
            {editing ? "Lock" : "Edit"}
          </button>
        );
      case "details":
        return (
          <button
            className="button alt"
            type="button"
            onClick={() => {
              if (typeof onOpenProductDetails === "function") {
                onOpenProductDetails(row.productId);
              }
            }}
          >
            Details
          </button>
        );
      case "status":
        return (
          <>
            <div className={`small pricelist-status ${row.remoteSyncStatus}`}>
              {dirty ? "Local draft" : row.remoteSyncStatus}
            </div>
            {row.hasPendingRemoteApply && !dirty ? <div className="small">Needs push to Local Line</div> : null}
          </>
        );
      case "product":
        return row.name;
      case "category":
        return row.categoryName;
      case "vendor":
        return row.vendorName;
      case "pricingRule":
        return row.pricingRuleLabel || (row.usesNoMarkupPricing ? "Deposit / no markup" : "Standard");
      case "unit":
        if (!row.usesSourcePricing) return "";
        return (
          <select
            className="input pricelist-input"
            value={draft.unitOfMeasure}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { unitOfMeasure: event.target.value })}
          >
            <option value="each">Each</option>
            <option value="lbs">Lbs</option>
          </select>
        );
      case "sourceUnitPrice":
        if (!row.usesSourcePricing) return "";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.sourceUnitPrice}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { sourceUnitPrice: event.target.value })}
          />
        );
      case "minWeight":
        if (!row.usesSourcePricing) return "";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.001"
            value={draft.minWeight}
            disabled={!editing || draft.unitOfMeasure !== "lbs"}
            onChange={(event) => updateDraft(row.productId, { minWeight: event.target.value })}
          />
        );
      case "maxWeight":
        if (!row.usesSourcePricing) return "";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.001"
            value={draft.maxWeight}
            disabled={!editing || draft.unitOfMeasure !== "lbs"}
            onChange={(event) => updateDraft(row.productId, { maxWeight: event.target.value })}
          />
        );
      case "avgWeightOverride":
        if (!row.usesSourcePricing) return "";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.001"
            value={draft.avgWeightOverride}
            disabled={!editing || draft.unitOfMeasure !== "lbs"}
            onChange={(event) => updateDraft(row.productId, { avgWeightOverride: event.target.value })}
          />
        );
      case "sourceMultiplier":
        if (!row.usesSourcePricing) return "";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.0001"
            value={draft.sourceMultiplier}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { sourceMultiplier: event.target.value })}
          />
        );
      case "basePrice":
        return formatMoney(preview.basePrice);
      case "guestMarkup":
        if (row.usesNoMarkupPricing) return "0.00";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.guestMarkup}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { guestMarkup: event.target.value })}
          />
        );
      case "guestPrice":
        return formatMoney(preview.guestPrice);
      case "memberMarkup":
        if (row.usesNoMarkupPricing) return "0.00";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.memberMarkup}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { memberMarkup: event.target.value })}
          />
        );
      case "memberPrice":
        return formatMoney(preview.memberPrice);
      case "herdShareMarkup":
        if (row.usesNoMarkupPricing) return "0.00";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.herdShareMarkup}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { herdShareMarkup: event.target.value })}
          />
        );
      case "herdSharePrice":
        return formatMoney(preview.herdSharePrice);
      case "snapMarkup":
        if (row.usesNoMarkupPricing) return "0.00";
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.snapMarkup}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { snapMarkup: event.target.value })}
          />
        );
      case "snapPrice":
        return formatMoney(preview.snapPrice);
      case "onSale":
        return (
          <input
            type="checkbox"
            checked={draft.onSale}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { onSale: event.target.checked })}
          />
        );
      case "saleDiscount":
        return (
          <input
            className="input pricelist-input"
            type="number"
            step="0.01"
            value={draft.saleDiscount}
            disabled={!editing}
            onChange={(event) => updateDraft(row.productId, { saleDiscount: event.target.value })}
          />
        );
      case "packages":
        return <div className="pricelist-package-cell">{row.packageSummary || "No packages"}</div>;
      case "lastRemote":
        return (
          <>
            <div className="small">{formatDateTime(row.remoteSyncedAt)}</div>
            {row.remoteSyncMessage ? <div className="small">{row.remoteSyncMessage}</div> : null}
          </>
        );
      case "apply":
        return (
          <button
            className="button alt"
            type="button"
            disabled={dirty || isApplying}
            onClick={() => applyRemote([row.productId])}
          >
            {isApplying ? "Pushing..." : "Push"}
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <section className="admin-section pricelist-section">
      <div className="pricelist-toolbar">
        <div className="filters pricelist-filters">
          <label className="filter-field product-search-filter">
            <span className="small">Product name</span>
            <input
              className="input"
              type="search"
              value={productSearch}
              placeholder="Search products"
              onChange={(event) => setProductSearch(event.target.value)}
            />
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
              {pricelistCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span className="small">Remote status</span>
            <select
              className="input"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All</option>
              <option value="needsApply">Needs push</option>
              <option value="applied">Applied</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="not-applied">Not applied</option>
            </select>
          </label>
        </div>

        <div className="pricelist-toolbar-actions">
          <div className="small pricelist-count">
            {filteredRows.length} / {rows.length} products
          </div>
          <div className="pricelist-column-picker" ref={columnPickerRef}>
            <button
              className="button alt"
              type="button"
              onClick={() => setColumnPickerOpen((prev) => !prev)}
            >
              Columns
            </button>
            {columnPickerOpen ? (
              <div className="pricelist-column-panel">
                <div className="pricelist-column-panel-actions">
                  <button className="button alt" type="button" onClick={saveCurrentColumnsAsDefault}>
                    Save Default
                  </button>
                  <button className="button alt" type="button" onClick={resetColumnsToDefaults}>
                    Reset Defaults
                  </button>
                  <button className="button alt" type="button" onClick={resetColumnsToBuiltInDefaults}>
                    App Default
                  </button>
                  <button className="button alt" type="button" onClick={showAllColumns}>
                    Show All
                  </button>
                </div>
                <div className="pricelist-column-list">
                  {orderedColumnDefs.map((column, index) => (
                    <div key={column.key} className="pricelist-column-option">
                      <label className="pricelist-column-option-main">
                        <input
                          type="checkbox"
                          checked={column.required || visibleColumns[column.key] !== false}
                          disabled={column.required}
                          onChange={(event) => setColumnVisibility(column.key, event.target.checked)}
                        />
                        <span>{column.label}</span>
                        {column.required ? <span className="small">Required</span> : null}
                      </label>
                      <div className="pricelist-column-order-actions">
                        <button
                          className="button alt"
                          type="button"
                          disabled={index === 0}
                          onClick={() => moveColumn(column.key, -1)}
                        >
                          Up
                        </button>
                        <button
                          className="button alt"
                          type="button"
                          disabled={index === orderedColumnDefs.length - 1}
                          onClick={() => moveColumn(column.key, 1)}
                        >
                          Down
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <button
            className="button"
            type="button"
            onClick={handleSaveChanges}
            disabled={saving || dirtyProductIds.length === 0}
          >
            {saving ? "Saving..." : "Save Local Changes"}
          </button>
          <button
            className="button sync-button"
            type="button"
            onClick={onReviewLocalLine}
            disabled={reviewLocalLineLoading || typeof onReviewLocalLine !== "function"}
          >
            {reviewLocalLineLoading ? "Reviewing..." : "Review Local Line"}
          </button>
          <button
            className="button sync-button"
            type="button"
            onClick={onPullFromLocalLine}
            disabled={
              pullFromLocalLineLoading ||
              pullFromLocalLineRunning ||
              typeof onPullFromLocalLine !== "function"
            }
          >
            {pullFromLocalLineLoading
              ? "Starting Pull..."
              : pullFromLocalLineRunning
                ? "Pull Running..."
                : "Pull From Local Line"}
          </button>
          <button
            className="button sync-button"
            type="button"
            onClick={() => applyRemote(remoteReadyProductIds)}
            disabled={applyingProductIds.length > 0 || remoteReadyProductIds.length === 0}
          >
            {applyingProductIds.length
              ? "Pushing..."
              : `Push To Local Line (${remoteReadyProductIds.length})`}
          </button>
          <button
            className="button alt"
            type="button"
            onClick={exportGooglePricelist}
            disabled={exportingGoogle}
          >
            {exportingGoogle ? "Exporting..." : "Push Google Pricelist"}
          </button>
          <button className="button alt" type="button" onClick={loadPriceList} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {message ? <div className="small">{message}</div> : null}
      {loading ? <div className="small">Loading pricelist...</div> : null}

      <div className="admin-table-shell pricelist-table-shell">
        <table
          className="admin-table admin-table-head pricelist-table"
          style={{ width: pricelistTableWidth, minWidth: pricelistTableWidth }}
        >
          <colgroup>
            {visibleColumnDefs.map((column) => (
              <col key={`pricelist-head-col-${column.key}`} style={getColumnCellStyle(column)} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleColumnDefs.map((column) => (
                <th
                  key={`pricelist-header-${column.key}`}
                  className={column.sticky ? "pricelist-sticky-col" : ""}
                  style={getColumnCellStyle(column)}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
        </table>
        <div className="admin-table-body-scroll pricelist-table-body-scroll">
          <table
            className="admin-table admin-table-body pricelist-table"
            style={{ width: pricelistTableWidth, minWidth: pricelistTableWidth }}
          >
            <colgroup>
              {visibleColumnDefs.map((column) => (
                <col key={`pricelist-body-col-${column.key}`} style={getColumnCellStyle(column)} />
              ))}
            </colgroup>
            <tbody>
              {filteredRows.map((row) => {
                const draft = drafts[row.productId] || normalizeRowForEdit(row);
                const editing = Boolean(editingRows[row.productId]);
                const dirty = !draftsMatchRow(drafts[row.productId], row);
                const preview = computePreview(row, draft);
                const isApplying = applyingProductIds.includes(row.productId);

                return (
                  <tr
                    key={`pricelist-row-${row.productId}`}
                    className={dirty ? "edited pricelist-row-dirty" : ""}
                  >
                    {visibleColumnDefs.map((column) => (
                      <td
                        key={`pricelist-cell-${row.productId}-${column.key}`}
                        className={column.sticky ? "pricelist-sticky-col" : ""}
                        style={getColumnCellStyle(column)}
                      >
                        {renderCell(column, row, draft, preview, editing, dirty, isApplying)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
