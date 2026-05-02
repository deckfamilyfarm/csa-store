import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";

const COLUMN_STORAGE_KEY = "adminPricelistColumnPrefs.v2";
const COLUMN_DEFAULT_STORAGE_KEY = "adminPricelistColumnDefaultPrefs.v2";
const PRICELIST_DEFAULT_PAGE_SIZE = 50;
const PRICELIST_PAGE_SIZE_OPTIONS = [50, 100, 200];
const PRICELIST_SEARCH_DEBOUNCE_MS = 250;
const PUSH_REVIEW_FETCH_PAGE_SIZE = 200;

const PRICELIST_COLUMNS = [
  { key: "product", label: "Product", width: 280, sticky: "left", required: true, defaultVisible: true },
  { key: "sourceUnitPrice", label: "Vendor's Retail Price", width: 156, defaultVisible: true },
  { key: "unit", label: "Vendor's Unit Type", width: 128, defaultVisible: true },
  { key: "basePrice", label: "CSA Package Price", width: 146, defaultVisible: true },
  { key: "memberPrice", label: "Member Adjusted $", width: 152, defaultVisible: true },
  { key: "visible", label: "Visible", width: 96, defaultVisible: true },
  { key: "trackInventory", label: "Track Inventory", width: 132, defaultVisible: true },
  { key: "inventory", label: "Stock", width: 90, defaultVisible: true },
  { key: "onSale", label: "Sale", width: 82, defaultVisible: true },
  { key: "saleDiscount", label: "Sale %", width: 96, defaultVisible: true },
  { key: "status", label: "Status", width: 150, defaultVisible: false },
  { key: "category", label: "Category", width: 160, defaultVisible: false },
  { key: "vendor", label: "Vendor", width: 170, defaultVisible: false },
  { key: "pricingRule", label: "Rule", width: 150, defaultVisible: false },
  { key: "minWeight", label: "Min Wt", width: 100, defaultVisible: false },
  { key: "maxWeight", label: "Max Wt", width: 100, defaultVisible: false },
  { key: "avgWeightOverride", label: "Avg Wt", width: 100, defaultVisible: false },
  { key: "sourceMultiplier", label: "FFCSA Factor", width: 116, defaultVisible: false },
  { key: "guestMarkup", label: "Guest Adj %", width: 112, defaultVisible: false },
  { key: "guestPrice", label: "Guest Adjusted $", width: 142, defaultVisible: false },
  { key: "memberMarkup", label: "Member Adj %", width: 118, defaultVisible: false },
  { key: "herdShareMarkup", label: "Herd Adj %", width: 110, defaultVisible: false },
  { key: "herdSharePrice", label: "Herd Adjusted $", width: 144, defaultVisible: false },
  { key: "snapMarkup", label: "SNAP Adj %", width: 110, defaultVisible: false },
  { key: "snapPrice", label: "SNAP Adjusted $", width: 144, defaultVisible: false },
  { key: "packages", label: "Packages", width: 340, defaultVisible: false },
  { key: "lastRemote", label: "Last Remote", width: 260, defaultVisible: false },
  { key: "actions", label: "Actions", width: 154, sticky: "right", required: true, defaultVisible: true }
];

const PRICELIST_COLUMN_MAP = new Map(PRICELIST_COLUMNS.map((column) => [column.key, column]));
const BUILT_IN_COLUMN_ORDER = PRICELIST_COLUMNS.map((column) => column.key);

function enforcePreferredColumnOrder(columnOrder = []) {
  const nextOrder = [...columnOrder];
  const productIndex = nextOrder.indexOf("product");
  const actionsIndex = nextOrder.indexOf("actions");

  if (productIndex >= 0) {
    nextOrder.splice(productIndex, 1);
    nextOrder.unshift("product");
  }

  if (actionsIndex >= 0) {
    nextOrder.splice(actionsIndex, 1);
    nextOrder.push("actions");
  }

  if (productIndex < 0) return nextOrder;

  const preferredKeys = ["sourceUnitPrice", "unit"];
  preferredKeys.forEach((key) => {
    const index = nextOrder.indexOf(key);
    if (index >= 0) {
      nextOrder.splice(index, 1);
    }
  });

  nextOrder.splice(productIndex + 1, 0, ...preferredKeys);
  return nextOrder;
}

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

  return enforcePreferredColumnOrder(normalized);
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

function getRowDefaults(row) {
  const saleDiscount = Number.isFinite(Number(row.saleDiscount)) ? Number(row.saleDiscount) : 0;
  return {
    visible: Boolean(row.visible),
    trackInventory: Boolean(row.trackInventory),
    inventory: Number.isFinite(Number(row.inventory)) ? Number(row.inventory) : 0,
    onSale: Boolean(row.onSale),
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

function normalizePricelistEdit(changes, defaults) {
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

function computeEditedBasePrice(row, rowValues) {
  if (!row?.usesSourcePricing) {
    return toNumber(row?.basePrice);
  }

  const sourceUnitPrice = toNumber(row?.sourceUnitPrice);
  const sourceMultiplier = toNumber(row?.sourceMultiplier);
  if (sourceUnitPrice === null || sourceMultiplier === null) {
    return toNumber(row?.basePrice);
  }

  const packages = Array.isArray(row?.packages) ? row.packages : [];

  const packageBasePrices = packages
    .map((pkg) => {
      if (String(row?.unitOfMeasure || "").toLowerCase() === "lbs") {
        const averageWeight = toNumber(pkg?.averageWeight);
        if (averageWeight === null || averageWeight <= 0) return null;
        return roundCurrency(sourceUnitPrice * averageWeight * sourceMultiplier);
      }

      const quantity = Math.max(toNumber(pkg?.quantity) || 1, 1);
      return roundCurrency(sourceUnitPrice * quantity * sourceMultiplier);
    })
    .filter((value) => value !== null);

  if (!packageBasePrices.length) {
    return toNumber(row?.basePrice);
  }

  return Math.min(...packageBasePrices);
}

function computeEditedFinalPrice(row, basePrice, markup, rowValues) {
  const safeBasePrice = toNumber(basePrice);
  const safeMarkup = toNumber(markup);
  if (safeBasePrice === null || safeMarkup === null) return null;

  const unroundedRegular = safeBasePrice * (1 + safeMarkup);
  const regular = roundCurrency(unroundedRegular);
  if (!rowValues?.onSale) {
    return regular;
  }

  const saleDiscount = Math.max(0, Math.min((toNumber(rowValues?.saleDiscount) || 0) / 100, 1));
  return roundCurrency(unroundedRegular * (1 - saleDiscount));
}

function buildDisplayRow(row, rowValues) {
  const nextBasePrice = computeEditedBasePrice(row, rowValues);
  return {
    ...row,
    basePrice: nextBasePrice,
    guestPrice: computeEditedFinalPrice(row, nextBasePrice, row?.guestMarkup, rowValues),
    memberPrice: computeEditedFinalPrice(row, nextBasePrice, row?.memberMarkup, rowValues),
    herdSharePrice: computeEditedFinalPrice(row, nextBasePrice, row?.herdShareMarkup, rowValues),
    snapPrice: computeEditedFinalPrice(row, nextBasePrice, row?.snapMarkup, rowValues),
    onSale: Boolean(rowValues?.onSale),
    saleDiscount: Number.isFinite(Number(rowValues?.saleDiscount))
      ? Number(rowValues.saleDiscount) / 100
      : 0
  };
}

function compareNullableNumbers(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareNullableStrings(left, right) {
  const leftValue = String(left || "").trim();
  const rightValue = String(right || "").trim();
  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return 1;
  if (!rightValue) return -1;
  return leftValue.localeCompare(rightValue, undefined, { sensitivity: "base", numeric: true });
}

function getSortValue(row, columnKey) {
  switch (columnKey) {
    case "product":
      return row.name || "";
    case "sourceUnitPrice":
      return toNumber(row.sourceUnitPrice);
    case "unit":
      return row.unitOfMeasure || "";
    case "category":
      return row.categoryName || "";
    case "vendor":
      return row.vendorName || "";
    case "pricingRule":
      return row.pricingRuleLabel || "";
    case "minWeight":
      return toNumber(row.minWeight);
    case "maxWeight":
      return toNumber(row.maxWeight);
    case "avgWeightOverride":
      return toNumber(row.avgWeightOverride);
    case "sourceMultiplier":
      return toNumber(row.sourceMultiplier);
    case "basePrice":
      return toNumber(row.basePrice);
    case "guestMarkup":
      return toNumber(row.guestMarkup);
    case "guestPrice":
      return toNumber(row.guestPrice);
    case "memberMarkup":
      return toNumber(row.memberMarkup);
    case "memberPrice":
      return toNumber(row.memberPrice);
    case "visible":
      return row.visible ? 1 : 0;
    case "trackInventory":
      return row.trackInventory ? 1 : 0;
    case "inventory":
      return toNumber(row.inventory);
    case "herdShareMarkup":
      return toNumber(row.herdShareMarkup);
    case "herdSharePrice":
      return toNumber(row.herdSharePrice);
    case "snapMarkup":
      return toNumber(row.snapMarkup);
    case "snapPrice":
      return toNumber(row.snapPrice);
    case "saleDiscount":
      return toNumber(row.saleDiscount);
    case "onSale":
      return row.onSale ? 1 : 0;
    case "packages":
      return row.packageSummary || "";
    case "status":
      return row.remoteSyncStatus || "";
    case "lastRemote":
      return row.remoteSyncedAt ? new Date(row.remoteSyncedAt).getTime() : null;
    default:
      return null;
  }
}

function isSortableColumn(columnKey) {
  return columnKey !== "actions";
}

function compareRows(left, right, columnKey, direction) {
  const leftValue = getSortValue(left, columnKey);
  const rightValue = getSortValue(right, columnKey);
  const multiplier = direction === "desc" ? -1 : 1;

  if (
    typeof leftValue === "number" ||
    typeof rightValue === "number" ||
    leftValue === null ||
    rightValue === null
  ) {
    return compareNullableNumbers(
      typeof leftValue === "number" ? leftValue : null,
      typeof rightValue === "number" ? rightValue : null
    ) * multiplier;
  }

  return compareNullableStrings(leftValue, rightValue) * multiplier;
}

export function AdminPriceListSection({
  token,
  categories,
  vendors,
  refreshNonce = 0,
  onDataRefresh,
  onCatalogRefresh,
  onReviewLocalLine,
  reviewLocalLineLoading = false,
  onPullFromLocalLine,
  pullFromLocalLineLoading = false,
  pullFromLocalLineRunning = false,
  onOpenProductDetails,
  onAddProduct,
  onDuplicateProduct,
  onDeleteProduct
}) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [message, setMessage] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [saleFilter, setSaleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PRICELIST_DEFAULT_PAGE_SIZE);
  const [totalRows, setTotalRows] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [filteredPendingCount, setFilteredPendingCount] = useState(0);
  const [pushReviewLoading, setPushReviewLoading] = useState(false);
  const [pushReviewRows, setPushReviewRows] = useState([]);
  const [pushReviewProductIds, setPushReviewProductIds] = useState([]);
  const [pushState, setPushState] = useState({
    active: false,
    completed: 0,
    total: 0,
    currentProductId: null,
    currentProductName: "",
    resultsById: {}
  });
  const [pricelistEdits, setPricelistEdits] = useState({});
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyState, setApplyState] = useState({
    open: false,
    updates: [],
    results: [],
    error: "",
    localOnly: false
  });
  const [applyingProductIds, setApplyingProductIds] = useState([]);
  const [deletingProductIds, setDeletingProductIds] = useState([]);
  const [exportingGoogle, setExportingGoogle] = useState(false);
  const [cleanupRecentChangeLoading, setCleanupRecentChangeLoading] = useState(false);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [pushReviewOpen, setPushReviewOpen] = useState(false);
  const [openActionMenuProductId, setOpenActionMenuProductId] = useState(null);
  const [visibleColumns, setVisibleColumns] = useState(() => loadCurrentColumnPreferences().visibleColumns);
  const [columnOrder, setColumnOrder] = useState(() => loadCurrentColumnPreferences().columnOrder);
  const [sortConfig, setSortConfig] = useState({ key: "product", direction: "asc" });
  const columnPickerRef = useRef(null);
  const actionMenuRef = useRef(null);
  const loadRequestRef = useRef(0);

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
    const timer = window.setTimeout(() => {
      setDebouncedProductSearch(productSearch.trim());
    }, PRICELIST_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [productSearch]);

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

  useEffect(() => {
    if (!openActionMenuProductId) return undefined;

    function handlePointerDown(event) {
      if (!actionMenuRef.current?.contains(event.target)) {
        setOpenActionMenuProductId(null);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpenActionMenuProductId(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openActionMenuProductId]);

  useEffect(() => {
    document.body.classList.toggle("modal-open", pushReviewOpen);
    return () => {
      document.body.classList.remove("modal-open");
    };
  }, [pushReviewOpen]);

  function buildPriceListQueryParams() {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortKey: sortConfig.key,
      sortDirection: sortConfig.direction
    });
    if (debouncedProductSearch) params.set("search", debouncedProductSearch);
    if (categoryFilter) params.set("categoryId", categoryFilter);
    if (vendorFilter) params.set("vendorId", vendorFilter);
    if (saleFilter && saleFilter !== "all") params.set("sale", saleFilter);
    if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
    return params;
  }

  async function loadAllPendingPushRows() {
    const collectedRows = [];
    let nextPage = 1;
    let totalPagesToFetch = 1;

    while (nextPage <= totalPagesToFetch) {
      const params = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(PUSH_REVIEW_FETCH_PAGE_SIZE),
        sortKey: "product",
        sortDirection: "asc",
        status: "needsApply"
      });
      if (debouncedProductSearch) params.set("search", debouncedProductSearch);
      if (categoryFilter) params.set("categoryId", categoryFilter);
      if (vendorFilter) params.set("vendorId", vendorFilter);
      if (saleFilter && saleFilter !== "all") params.set("sale", saleFilter);

      const response = await adminGet(`pricelist?${params.toString()}`, token);
      const rowsForPage = Array.isArray(response.rows) ? response.rows : [];
      collectedRows.push(...rowsForPage);
      totalPagesToFetch = Math.max(1, Number(response.pagination?.totalPages || 1));
      nextPage += 1;
    }

    return collectedRows;
  }

  async function loadPriceList() {
    if (!token) return;
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    try {
      const params = buildPriceListQueryParams();
      const response = await adminGet(`pricelist?${params.toString()}`, token);
      if (requestId !== loadRequestRef.current) {
        return;
      }
      setRows(response.rows || []);
      const nextPage = Number(response.pagination?.page || page);
      const nextPageSize = Number(response.pagination?.pageSize || pageSize);
      const nextTotalRows = Number(response.pagination?.totalRows || 0);
      const nextTotalPages = Number(response.pagination?.totalPages || 1);
      const nextFilteredPendingCount = Number(response.summary?.pendingRemoteApplyRows || 0);
      setTotalRows(nextTotalRows);
      setTotalPages(nextTotalPages);
      setFilteredPendingCount(nextFilteredPendingCount);
      if (nextPage !== page) setPage(nextPage);
      if (nextPageSize !== pageSize) setPageSize(nextPageSize);
    } catch (_error) {
      if (requestId === loadRequestRef.current) {
        setMessage("Failed to load pricelist.");
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadPriceList();
  }, [token, page, pageSize, debouncedProductSearch, categoryFilter, vendorFilter, saleFilter, statusFilter, sortConfig.key, sortConfig.direction]);

  useEffect(() => {
    if (!token) return;
    loadPriceList();
  }, [token, refreshNonce]);

  function getPendingPricelistEditEntries() {
    return Object.entries(pricelistEdits).filter(([, entry]) => {
      if (!entry?.defaults || !entry?.values) return false;
      return !editsMatch(entry.values, entry.defaults);
    });
  }

  function updatePricelistEdit(row, patch) {
    if (!row?.productId) return;

    setPricelistEdits((prev) => {
      const next = { ...prev };
      const currentEntry = next[row.productId] || null;
      const defaults = currentEntry?.defaults || getRowDefaults(row);
      const updated = normalizePricelistEdit(
        { ...(currentEntry?.values || defaults), ...patch },
        defaults
      );

      if (updated.trackInventory && updated.visible && Number(updated.inventory) === 0) {
        window.alert("If Track Inventory is on and stock is 0, set Visible to off.");
        return prev;
      }

      if (editsMatch(updated, defaults)) {
        delete next[row.productId];
      } else {
        next[row.productId] = {
          defaults,
          values: updated,
          meta: {
            productId: row.productId,
            productName: row.name || `Product ${row.productId}`,
            categoryName: row.categoryName || "Uncategorized"
          }
        };
      }

      return next;
    });
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

  const orderedColumnDefs = columnOrder
    .map((key) => PRICELIST_COLUMN_MAP.get(key))
    .filter(Boolean);
  const visibleColumnDefs = orderedColumnDefs.filter(
    (column) => column.required || visibleColumns[column.key] !== false
  );
  const stickyLeftByKey = {};
  const stickyRightByKey = {};
  let stickyLeftOffset = 0;
  let stickyRightOffset = 0;
  visibleColumnDefs.forEach((column) => {
    if (column.sticky !== "left") return;
    stickyLeftByKey[column.key] = stickyLeftOffset;
    stickyLeftOffset += column.width;
  });
  [...visibleColumnDefs].reverse().forEach((column) => {
    if (column.sticky !== "right") return;
    stickyRightByKey[column.key] = stickyRightOffset;
    stickyRightOffset += column.width;
  });

  async function applyRemote(productIds) {
    if (!productIds.length) return;
    const reviewRowsById = new Map(pushReviewRows.map((row) => [Number(row.productId), row]));
    const nextResultsById = {};
    setPushState({
      active: true,
      completed: 0,
      total: productIds.length,
      currentProductId: null,
      currentProductName: "",
      resultsById: {}
    });
    setApplyingProductIds([]);
    setMessage("");
    try {
      for (let index = 0; index < productIds.length; index += 1) {
        const productId = Number(productIds[index]);
        const row = reviewRowsById.get(productId);
        setApplyingProductIds([productId]);
        setPushState((prev) => ({
          ...prev,
          currentProductId: productId,
          currentProductName: row?.name || `Product ${productId}`
        }));

        try {
          const response = await adminPost("pricelist/apply-remote", token, { productIds: [productId] });
          const result = Array.isArray(response.results) && response.results.length
            ? response.results[0]
            : { productId, ok: true, message: "Changes applied." };
          nextResultsById[productId] = result;
        } catch (error) {
          nextResultsById[productId] = {
            productId,
            ok: false,
            message: error?.message || "Remote apply failed."
          };
        }

        setPushState((prev) => ({
          ...prev,
          completed: index + 1,
          resultsById: { ...nextResultsById }
        }));
      }

      const failures = Object.values(nextResultsById).filter((row) => !row.ok);
      setMessage(
        failures.length
          ? failures.map((row) => `${row.productId}: ${row.message}`).join(" | ")
          : "Changes pushed to Local Line."
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
      setPushState((prev) => ({
        ...prev,
        active: false,
        currentProductId: null,
        currentProductName: ""
      }));
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
      const highlightSummary = Number(response.highlightedRowCount || 0)
        ? ` ${Number(response.highlightedRowCount || 0)} row${Number(response.highlightedRowCount || 0) === 1 ? "" : "s"} highlighted in yellow.`
        : "";
      setMessage(
        `Google pricelist updated with ${response.rowCount || 0} rows: ${vendorSummary}.${highlightSummary}`
      );
    } catch (error) {
      setMessage(error?.message || "Failed to export Google pricelist.");
    } finally {
      setExportingGoogle(false);
    }
  }

  async function cleanupRecentChangeFalsePositives() {
    setCleanupRecentChangeLoading(true);
    setMessage("");
    try {
      const response = await adminPost("pricelist/cleanup-recent-change-false-positives", token, {});
      setMessage(
        Number(response.cleaned || 0)
          ? `Cleaned ${Number(response.cleaned || 0)} existing recent-change false positive row${Number(response.cleaned || 0) === 1 ? "" : "s"}.`
          : "No existing recent-change false positives needed cleanup."
      );
      await loadPriceList();
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
    } catch (error) {
      setMessage(error?.message || "Failed to clean recent-change false positives.");
    } finally {
      setCleanupRecentChangeLoading(false);
    }
  }

  async function handleApplyChanges() {
    if (!pendingPricelistEditEntries.length) return;

    const updates = pendingPricelistEditEntries.map(([, entry]) => {
      const safeDiscount = Math.min(Math.max(Number(entry.values.saleDiscount) || 0, 0), 100);
      return {
        productId: entry.meta.productId,
        productName: entry.meta.productName,
        category: entry.meta.categoryName,
        changes: {
          visible: entry.values.visible ? 1 : 0,
          trackInventory: entry.values.trackInventory ? 1 : 0,
          inventory: Number(entry.values.inventory) || 0,
          onSale: entry.values.onSale ? 1 : 0,
          saleDiscount: safeDiscount / 100
        },
        display: {
          visible: entry.values.visible ? "On" : "Off",
          trackInventory: entry.values.trackInventory ? "On" : "Off",
          inventory: Number(entry.values.inventory) || 0,
          onSale: entry.values.onSale ? "On" : "Off",
          saleDiscount: safeDiscount
        }
      };
    });

    setApplyState({ open: true, updates, results: [], error: "", localOnly: true });
    setApplyLoading(true);
    setMessage("");

    try {
      const response = await adminPost("products/bulk-update", token, {
        applyRemote: false,
        queueRemoteSync: true,
        syncPricingProfileSale: true,
        updates: updates.map((update) => ({
          productId: update.productId,
          changes: update.changes
        }))
      });

      setApplyState((prev) => ({ ...prev, results: response.results || [] }));
      setPricelistEdits({});
      setMessage("Local pricelist changes applied. Use Push to Local Line when ready.");
      await loadPriceList();
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
      if (typeof onCatalogRefresh === "function") {
        await onCatalogRefresh();
      }
    } catch (_error) {
      setApplyState((prev) => ({ ...prev, error: "Failed to apply pricelist changes." }));
      setMessage("Pricelist update failed.");
    } finally {
      setApplyLoading(false);
    }
  }

  function closeApplyPanel() {
    setApplyState({ open: false, updates: [], results: [], error: "", localOnly: false });
  }

  async function handleDeleteRow(productId) {
    if (typeof onDeleteProduct !== "function") return;
    setDeletingProductIds((prev) => (prev.includes(productId) ? prev : [...prev, productId]));
    setMessage("");
    try {
      await onDeleteProduct(productId);
      setRows((prev) => prev.filter((row) => row.productId !== productId));
      const nextTotalRows = Math.max(0, totalRows - 1);
      setTotalRows(nextTotalRows);
      setTotalPages(Math.max(1, Math.ceil(nextTotalRows / pageSize)));
      setMessage("Product deleted.");
      if (rows.length === 1 && page > 1) {
        setPage((prev) => Math.max(1, prev - 1));
      }
    } catch (_error) {
      // Parent handler sets the detailed error message.
    } finally {
      setDeletingProductIds((prev) => prev.filter((id) => id !== productId));
    }
  }

  const remoteReadyProductIds = rows
    .filter((row) => row.hasPendingRemoteApply)
    .map((row) => row.productId);
  const pendingPricelistEditEntries = getPendingPricelistEditEntries();
  const pendingProductsOffPage = Math.max(0, filteredPendingCount - remoteReadyProductIds.length);
  const statusText = loading
    ? "Loading pricelist..."
    : message || `${rows.length ? `${(page - 1) * pageSize + 1}-${(page - 1) * pageSize + rows.length}` : "0"} / ${totalRows} products`;
  const pricelistCategories = categories.filter(
    (category) => !isMembershipCategoryName(category.name)
  );
  const sortedVendors = vendors
    .slice()
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

  function getColumnCellStyle(column) {
    return {
      width: `${column.width}px`,
      ...(column.sticky === "left" ? { left: `${stickyLeftByKey[column.key] || 0}px` } : {}),
      ...(column.sticky === "right" ? { right: `${stickyRightByKey[column.key] || 0}px` } : {})
    };
  }

  function toggleSort(columnKey) {
    if (!isSortableColumn(columnKey)) return;
    setPage(1);
    setSortConfig((prev) => {
      if (prev.key === columnKey) {
        return {
          key: columnKey,
          direction: prev.direction === "asc" ? "desc" : "asc"
        };
      }
      return {
        key: columnKey,
        direction: "asc"
      };
    });
  }

  async function openPushReview() {
    if (!filteredPendingCount || applyingProductIds.length || pushReviewLoading) return;
    setPushReviewOpen(true);
    setPushReviewLoading(true);
    setPushState({
      active: false,
      completed: 0,
      total: 0,
      currentProductId: null,
      currentProductName: "",
      resultsById: {}
    });
    setPushReviewRows([]);
    setPushReviewProductIds([]);
    setMessage("");
    try {
      const responseRows = await loadAllPendingPushRows();
      setPushReviewRows(responseRows);
      setPushReviewProductIds(
        responseRows
          .map((row) => Number(row.productId))
          .filter((value) => Number.isFinite(value))
      );
    } catch (_error) {
      setPushReviewOpen(false);
      setMessage("Failed to load pending Local Line push products.");
    } finally {
      setPushReviewLoading(false);
    }
  }

  function closePushReview() {
    if (applyingProductIds.length || pushState.active) return;
    setPushReviewOpen(false);
    setPushReviewLoading(false);
    setPushReviewRows([]);
    setPushReviewProductIds([]);
    setPushState({
      active: false,
      completed: 0,
      total: 0,
      currentProductId: null,
      currentProductName: "",
      resultsById: {}
    });
  }

  function getProductMetaLine(row) {
    const primaryPackage = Array.isArray(row.packages) && row.packages.length
      ? row.packages[0]?.name || `Package ${row.packages[0]?.id || ""}`.trim()
      : "No package";
    return `${primaryPackage} - ${row.vendorName || "N/A"}`;
  }

  function toggleActionMenu(productId) {
    setOpenActionMenuProductId((prev) => (prev === productId ? null : productId));
  }

  function renderCell(column, row, isApplying, isDeleting) {
    const rowBusy = isApplying || isDeleting || applyLoading;
    const editEntry = pricelistEdits[row.productId];
    const defaults = editEntry?.defaults || getRowDefaults(row);
    const rowValues = editEntry?.values || defaults;
    const displayRow = buildDisplayRow(row, rowValues);

    switch (column.key) {
      case "status":
        return (
          <>
            <div className={`small pricelist-status ${row.remoteSyncStatus}`}>{row.remoteSyncStatus}</div>
            {row.hasPendingRemoteApply ? <div className="small">Needs push to Local Line</div> : null}
            {Number(row.localLineProductId || 0) <= 0 ? <div className="small">Local-only</div> : null}
          </>
        );
      case "product":
        return (
          <div className="admin-product-cell">
            <div className="admin-product-cell-title">{row.name}</div>
            <div className="admin-product-cell-meta">{getProductMetaLine(row)}</div>
          </div>
        );
      case "category":
        return row.categoryName;
      case "vendor":
        return row.vendorName;
      case "pricingRule":
        return row.pricingRuleLabel || (row.usesNoMarkupPricing ? "Deposit / no markup" : "Standard");
      case "unit":
        return row.usesSourcePricing ? row.unitOfMeasure || "" : "";
      case "sourceUnitPrice":
        return row.usesSourcePricing ? formatMoney(row.sourceUnitPrice) : "";
      case "minWeight":
        return row.usesSourcePricing ? row.minWeight ?? "" : "";
      case "maxWeight":
        return row.usesSourcePricing ? row.maxWeight ?? "" : "";
      case "avgWeightOverride":
        return row.usesSourcePricing ? row.avgWeightOverride ?? "" : "";
      case "sourceMultiplier":
        return row.usesSourcePricing ? row.sourceMultiplier ?? "" : "";
      case "basePrice":
        return formatMoney(displayRow.basePrice);
      case "guestMarkup":
        return row.usesNoMarkupPricing ? "0.00" : `${roundCurrency((toNumber(row.guestMarkup) || 0) * 100).toFixed(2)}`;
      case "guestPrice":
        return formatMoney(displayRow.guestPrice);
      case "memberMarkup":
        return row.usesNoMarkupPricing ? "0.00" : `${roundCurrency((toNumber(row.memberMarkup) || 0) * 100).toFixed(2)}`;
      case "memberPrice":
        return formatMoney(displayRow.memberPrice);
      case "visible":
        return (
          <button
            className={`toggle-switch ${rowValues.visible ? "active" : ""}`}
            type="button"
            disabled={rowBusy}
            onClick={() => updatePricelistEdit(row, { visible: !rowValues.visible })}
          />
        );
      case "trackInventory":
        return (
          <button
            className={`toggle-switch ${rowValues.trackInventory ? "active" : ""}`}
            type="button"
            disabled={rowBusy}
            onClick={() => updatePricelistEdit(row, { trackInventory: !rowValues.trackInventory })}
          />
        );
      case "inventory":
        return (
          <input
            className="stock-input"
            type="number"
            value={rowValues.inventory}
            disabled={rowBusy}
            onChange={(event) =>
              updatePricelistEdit(row, {
                inventory: Number(event.target.value)
              })
            }
          />
        );
      case "herdShareMarkup":
        return row.usesNoMarkupPricing ? "0.00" : `${roundCurrency((toNumber(row.herdShareMarkup) || 0) * 100).toFixed(2)}`;
      case "herdSharePrice":
        return formatMoney(displayRow.herdSharePrice);
      case "snapMarkup":
        return row.usesNoMarkupPricing ? "0.00" : `${roundCurrency((toNumber(row.snapMarkup) || 0) * 100).toFixed(2)}`;
      case "snapPrice":
        return formatMoney(displayRow.snapPrice);
      case "onSale":
        return (
          <button
            className={`toggle-switch ${rowValues.onSale ? "active" : ""}`}
            type="button"
            disabled={rowBusy}
            onClick={() => updatePricelistEdit(row, { onSale: !rowValues.onSale })}
          />
        );
      case "saleDiscount":
        return (
          <span className="sale-discount-wrapper">
            <input
              className="sale-discount-input"
              type="number"
              min="0"
              max="100"
              step="1"
              value={rowValues.saleDiscount}
              disabled={rowBusy}
              onChange={(event) =>
                updatePricelistEdit(row, {
                  saleDiscount: Number(event.target.value)
                })
              }
            />
            <span className="sale-discount-suffix">%</span>
          </span>
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
      case "actions":
        return (
          <div className="admin-row-actions" ref={openActionMenuProductId === row.productId ? actionMenuRef : null}>
            <button
              className="button alt"
              type="button"
              disabled={rowBusy}
              onClick={() => {
                setOpenActionMenuProductId(null);
                if (typeof onOpenProductDetails === "function") {
                  onOpenProductDetails(row.productId);
                }
              }}
            >
              Edit
            </button>
            <button
              className="button alt admin-row-menu-trigger"
              type="button"
              disabled={rowBusy}
              onClick={() => toggleActionMenu(row.productId)}
              aria-haspopup="menu"
              aria-expanded={openActionMenuProductId === row.productId}
            >
              ...
            </button>
            {openActionMenuProductId === row.productId ? (
              <div className="admin-row-menu" role="menu">
                <button
                  className="admin-row-menu-item"
                  type="button"
                  disabled={rowBusy}
                  onClick={() => {
                    setOpenActionMenuProductId(null);
                    applyRemote([row.productId]);
                  }}
                >
                  Push Product
                </button>
                <button
                  className="admin-row-menu-item"
                  type="button"
                  disabled={rowBusy}
                  onClick={() => {
                    setOpenActionMenuProductId(null);
                    if (typeof onDuplicateProduct === "function") {
                      onDuplicateProduct(row.productId);
                    }
                  }}
                >
                  Duplicate Product
                </button>
                <button
                  className="admin-row-menu-item"
                  type="button"
                  disabled={Number(row.localLineProductId || 0) > 0 || rowBusy}
                  onClick={() => {
                    setOpenActionMenuProductId(null);
                    handleDeleteRow(row.productId);
                  }}
                >
                  Delete Product
                </button>
              </div>
            ) : null}
          </div>
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
              onChange={(event) => {
                setProductSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="filter-field">
            <span className="small">Vendor</span>
            <select
              className="input"
              value={vendorFilter}
              onChange={(event) => {
                setVendorFilter(event.target.value);
                setPage(1);
              }}
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
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setPage(1);
              }}
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
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="needsApply">Needs push</option>
              <option value="applied">Applied</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="not-applied">Not applied</option>
            </select>
          </label>
          <label className="filter-field">
            <span className="small">On sale</span>
            <select
              className="input"
              value={saleFilter}
              onChange={(event) => {
                setSaleFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="onSale">On sale only</option>
              <option value="notOnSale">Not on sale</option>
            </select>
          </label>
        </div>

        <div className="pricelist-toolbar-actions">
          <div className="pricelist-toolbar-buttons">
            <button
              className="button"
              type="button"
              onClick={handleApplyChanges}
              disabled={applyLoading || pendingPricelistEditEntries.length === 0}
            >
              {applyLoading
                ? "Applying local changes..."
                : `Apply Local Changes (${pendingPricelistEditEntries.length})`}
            </button>
            <button
              className="button alt"
              type="button"
              disabled={applyLoading || pendingPricelistEditEntries.length === 0}
              onClick={() => {
                if (!window.confirm("Discard all pending pricelist changes? This cannot be undone.")) {
                  return;
                }
                setPricelistEdits({});
                setMessage("Pending pricelist changes discarded.");
              }}
            >
              Cancel Changes
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                if (typeof onAddProduct === "function") {
                  onAddProduct();
                }
              }}
              disabled={typeof onAddProduct !== "function"}
            >
              Add Product
            </button>
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
            {typeof onReviewLocalLine === "function" ? (
              <button
                className="button sync-button"
                type="button"
                onClick={onReviewLocalLine}
                disabled={reviewLocalLineLoading}
              >
                {reviewLocalLineLoading ? "Reviewing..." : "Review Local Line"}
              </button>
            ) : null}
            {typeof onPullFromLocalLine === "function" ? (
              <button
                className="button sync-button"
                type="button"
                onClick={onPullFromLocalLine}
                disabled={pullFromLocalLineLoading || pullFromLocalLineRunning}
              >
                {pullFromLocalLineLoading
                  ? "Starting Pull..."
                  : pullFromLocalLineRunning
                    ? "Pull Running..."
                    : "Pull From Local Line"}
              </button>
            ) : null}
            <button
              className="button sync-button"
              type="button"
              onClick={openPushReview}
              disabled={applyingProductIds.length > 0 || pushReviewLoading || filteredPendingCount === 0}
            >
              {applyingProductIds.length ? "Pushing..." : pushReviewLoading ? "Loading..." : "Push to Local Line"}
            </button>
            <button
              className="button alt"
              type="button"
              onClick={exportGooglePricelist}
              disabled={exportingGoogle}
            >
              {exportingGoogle ? "Exporting..." : "Push Google Pricelist"}
            </button>
            <button
              className="button alt"
              type="button"
              onClick={cleanupRecentChangeFalsePositives}
              disabled={cleanupRecentChangeLoading}
            >
              {cleanupRecentChangeLoading ? "Cleaning..." : "Cleanup Recent Change Flags"}
            </button>
            <button className="button alt" type="button" onClick={loadPriceList} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      <div className="small pricelist-count">{statusText}</div>
      <div className="small pricelist-count">
        Pending pricelist changes: {pendingPricelistEditEntries.length}
      </div>
      <div className="small pricelist-count">
        {filteredPendingCount} product{filteredPendingCount === 1 ? "" : "s"} currently need a Local Line push.
      </div>
      {pendingProductsOffPage > 0 ? (
        <div className="small pricelist-count">
          {pendingProductsOffPage} product{pendingProductsOffPage === 1 ? "" : "s"} need a Local Line push on other pages. Use the `Needs push` filter to find them.
        </div>
      ) : null}
      {pushReviewOpen ? (
        <div className="modal-backdrop" onClick={closePushReview}>
          <div className="modal response-modal pricelist-push-review-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={closePushReview} disabled={applyingProductIds.length > 0 || pushState.active}>
              Close
            </button>
            <h3>Review Local Line Push</h3>
            <div className="small">
              Review the current page pricing updates before sending them to Local Line.
            </div>
            <div className="response-card pricelist-push-note">
              <div className="title">Scheduling Note</div>
              <div className="small">
                Changes to Local Line pricing should be done on Thursdays when the store is down to avoid price mismatches.
              </div>
            </div>
            <div className="response-progress">
              {pushReviewProductIds.length} product{pushReviewProductIds.length === 1 ? "" : "s"} will be pushed.
            </div>
            {pushState.active ? (
              <div className="small">
                Pushing {pushState.completed + 1} of {pushState.total}: {pushState.currentProductName || `Product ${pushState.currentProductId}`}
              </div>
            ) : pushState.completed > 0 ? (
              <div className="small">
                Push complete: {pushState.completed} of {pushState.total} processed.
              </div>
            ) : null}
            {pendingProductsOffPage > 0 ? (
              <div className="small">
                {pendingProductsOffPage} pending product{pendingProductsOffPage === 1 ? "" : "s"} are outside the current page, but will still be included.
              </div>
            ) : null}
            <div className="pricelist-push-review-table-shell">
              <table className="admin-table pricelist-push-review-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Vendor</th>
                    <th>CSA Package Price</th>
                    <th>Member Adjusted $</th>
                    <th>Sale</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pushReviewLoading ? (
                    <tr>
                      <td colSpan={6}>Loading pending products...</td>
                    </tr>
                  ) : pushReviewRows.length ? (
                    pushReviewRows.map((row) => {
                      const result = pushState.resultsById?.[row.productId] || null;
                      let statusLabel = row.remoteSyncStatus;
                      if (pushState.active && pushState.currentProductId === row.productId) {
                        statusLabel = "Pushing...";
                      } else if (result) {
                        statusLabel = result.ok ? "Pushed" : `Failed: ${result.message || "Remote apply failed."}`;
                      }

                      return (
                        <tr key={`push-review-${row.productId}`}>
                          <td>{row.name}</td>
                          <td>{row.vendorName}</td>
                          <td>{formatMoney(row.basePrice)}</td>
                          <td>{formatMoney(row.memberPrice)}</td>
                          <td>{row.onSale ? `${roundCurrency((toNumber(row.saleDiscount) || 0) * 100).toFixed(2)}%` : "No"}</td>
                          <td>{statusLabel}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6}>No pending products found for the current filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="response-actions">
              <button className="button alt" type="button" onClick={closePushReview} disabled={applyingProductIds.length > 0 || pushState.active}>
                {pushState.completed > 0 && !pushState.active ? "Close" : "Cancel"}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => applyRemote(pushReviewProductIds)}
                disabled={applyingProductIds.length > 0 || pushState.active || pushReviewLoading || pushReviewProductIds.length === 0}
              >
                {pushState.active ? "Pushing..." : `Submit Push (${pushReviewProductIds.length})`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="pricelist-pagination">
        <label className="filter-field pricelist-page-size">
          <select
            className="input"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value) || PRICELIST_DEFAULT_PAGE_SIZE);
              setPage(1);
            }}
          >
            {PRICELIST_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div className="small pricelist-page-meta">
          Page {page} of {totalPages}
        </div>
        <div className="pricelist-page-buttons">
          <button
            className="button alt"
            type="button"
            onClick={() => setPage(1)}
            disabled={loading || page <= 1}
          >
            First
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={loading || page <= 1}
          >
            Prev
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={loading || page >= totalPages}
          >
            Next
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() => setPage(totalPages)}
            disabled={loading || page >= totalPages}
          >
            Last
          </button>
        </div>
      </div>

      <div className="admin-table-shell pricelist-table-shell">
        <table
          className="admin-table admin-table-head pricelist-table"
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
                  className={`${column.sticky ? "pricelist-sticky-col" : ""}${column.key === "actions" ? " pricelist-actions-col" : ""}`}
                  style={getColumnCellStyle(column)}
                >
                  {isSortableColumn(column.key) ? (
                    <button
                      className="pricelist-sort-button"
                      type="button"
                      onClick={() => toggleSort(column.key)}
                    >
                      <span>{column.label}</span>
                      <span className="pricelist-sort-indicator" aria-hidden="true">
                        {sortConfig.key === column.key
                          ? (sortConfig.direction === "asc" ? "▲" : "▼")
                          : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
        </table>
        <div className="admin-table-body-scroll pricelist-table-body-scroll">
          <table
            className="admin-table admin-table-body pricelist-table"
          >
            <colgroup>
              {visibleColumnDefs.map((column) => (
                <col key={`pricelist-body-col-${column.key}`} style={getColumnCellStyle(column)} />
              ))}
            </colgroup>
            <tbody>
              {rows.map((row) => {
                const isApplying = applyingProductIds.includes(row.productId);
                const isDeleting = deletingProductIds.includes(row.productId);
                const editEntry = pricelistEdits[row.productId];
                const isEdited = Boolean(editEntry && !editsMatch(editEntry.values, editEntry.defaults));

                return (
                  <tr
                    key={`pricelist-row-${row.productId}`}
                    className={`${isEdited ? "edited" : ""}${isDeleting ? " pricelist-row-processing" : ""}`.trim()}
                  >
                    {visibleColumnDefs.map((column) => (
                      <td
                        key={`pricelist-cell-${row.productId}-${column.key}`}
                        className={`${column.sticky ? "pricelist-sticky-col" : ""}${column.key === "actions" ? " pricelist-actions-col" : ""}`}
                        style={getColumnCellStyle(column)}
                      >
                        {renderCell(column, row, isApplying, isDeleting)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {applyState.open ? (
        <div className="modal-backdrop" onClick={closeApplyPanel}>
          <div className="modal response-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{applyState.localOnly ? "Local Pricelist Changes Applied" : "Pricelist Updates Applied"}</h3>
            <div className="response-progress">
              Updating {applyState.results.length} of {applyState.updates.length} products
            </div>
            {applyState.localOnly ? (
              <div className="small">Local database updated. Use `Push to Local Line` to send these changes remotely.</div>
            ) : null}
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
                  <div className="response-card" key={`pricelist-result-${update.productId}`}>
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
                    {applyState.localOnly ? null : (
                      <>
                        <div>
                          LocalLine: <span className={`status ${llClass}`}>{llLabel}</span>
                        </div>
                        <div>
                          LocalLine Pricing:{" "}
                          <span className={`status ${llPriceClass}`}>{llPriceLabel}</span>
                        </div>
                      </>
                    )}
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
      ) : null}
    </section>
  );
}
