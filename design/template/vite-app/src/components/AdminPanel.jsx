import React, { useEffect, useRef, useState } from "react";
import { AdminInventorySection } from "./AdminInventorySection.jsx";
import { AdminManualSection } from "./AdminManualSection.jsx";
import { AdminMembershipSection } from "./AdminMembershipSection.jsx";
import { AdminOrdersSection } from "./AdminOrdersSection.jsx";
import { AdminPriceListSection } from "./AdminPriceListSection.jsx";
import { AdminUsersSection } from "./AdminUsersSection.jsx";
import {
  adminDeleteImage,
  adminDelete,
  adminGet,
  adminLogin,
  adminPost,
  adminPut,
  adminUploadImage
} from "../adminApi.js";
import { requestPasswordReset } from "../api.js";

function hasRole(roleKeys, roleKey) {
  return roleKeys.includes("admin") || roleKeys.includes(roleKey);
}

function canAccessAdminSection(roleKeys, section) {
  if (roleKeys.includes("admin")) return true;
  switch (section) {
    case "localLine":
      return roleKeys.includes("localline_pull") || roleKeys.includes("dropsite_admin");
    case "orders":
      return Array.isArray(roleKeys) && roleKeys.length > 0;
    case "pricelist":
      return (
        roleKeys.includes("pricing_admin") ||
        roleKeys.includes("localline_pull") ||
        roleKeys.includes("localline_push")
      );
    case "localPricelist":
      return roleKeys.includes("local_pricelist_admin");
    case "manual":
      return Array.isArray(roleKeys) && roleKeys.length > 0;
    case "inventory":
      return roleKeys.includes("inventory_admin");
    case "membership":
      return roleKeys.includes("membership_admin");
    case "dropSites":
      return roleKeys.includes("dropsite_admin");
    case "reviews":
      return roleKeys.includes("member_admin");
    case "users":
      return roleKeys.includes("user_admin");
    case "categories":
    case "vendors":
    case "recipes":
      return false;
    default:
      return false;
  }
}

function getDefaultAdminSection(roleKeys = []) {
  const order = [
    "localLine",
    "orders",
    "pricelist",
    "localPricelist",
    "inventory",
    "membership",
    "dropSites",
    "reviews",
    "users",
    "categories",
    "vendors",
    "recipes"
  ];
  return order.find((section) => canAccessAdminSection(roleKeys, section)) || "inventory";
}

function createDraftPackage(overrides = {}) {
  return {
    id: overrides.id ?? null,
    name: overrides.name || "ea",
    price:
      overrides.price === null || typeof overrides.price === "undefined"
        ? ""
        : String(overrides.price),
    packageCode: overrides.packageCode || "",
    unit: overrides.unit || "",
    numOfItems:
      overrides.numOfItems === null || typeof overrides.numOfItems === "undefined"
        ? 1
        : Number(overrides.numOfItems) || 1,
    visible: typeof overrides.visible === "boolean" ? overrides.visible : true,
    trackInventory: typeof overrides.trackInventory === "boolean" ? overrides.trackInventory : false,
    inventory:
      overrides.inventory === null || typeof overrides.inventory === "undefined"
        ? 0
        : Number(overrides.inventory) || 0,
    trackType: overrides.trackType || "package",
    chargeType: overrides.chargeType || "package"
  };
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function formatMonthLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return value || "Unknown month";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  if (Number.isNaN(date.getTime())) return value || "Unknown month";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatShortMonthLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return value || "Unknown";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  if (Number.isNaN(date.getTime())) return value || "Unknown";
  return date.toLocaleDateString(undefined, { month: "short" });
}

function formatWeekOfLabel(value) {
  if (!value) return "Unknown week";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown week";
  return `Week of ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  })}`;
}

function formatDeliveryCount(count) {
  const numeric = Number(count) || 0;
  return `${numeric} ${numeric === 1 ? "delivery" : "deliveries"}`;
}

function buildTrendSvgLayout(series = [], maxValue = 1) {
  const width = 280;
  const height = 56;
  const paddingX = 12;
  const paddingTop = 8;
  const paddingBottom = 10;
  const usableWidth = width - paddingX * 2;
  const usableHeight = height - paddingTop - paddingBottom;
  const safeMax = Math.max(1, Number(maxValue) || 1);

  const pointCount = Math.max(series.length, 1);
  const points = series.map((entry, index) => {
    const x =
      pointCount <= 1
        ? width / 2
        : paddingX + (usableWidth * index) / (pointCount - 1);
    const value = Number(entry.averageWeeklyOrders || 0);
    const y = paddingTop + usableHeight - (usableHeight * value) / safeMax;
    return {
      x,
      y,
      value,
      month: entry.month,
      weekStart: entry.weekStart,
      performanceTier: entry.performanceTier || "bad",
      orderCount: Number(entry.orderCount) || 0
    };
  });

  return {
    width,
    height,
    polylinePoints: points.map((point) => `${point.x},${point.y}`).join(" "),
    points
  };
}

function computeDraftAverageWeight(draft) {
  const overrideWeight = toNumber(draft?.avgWeightOverride);
  if (overrideWeight !== null && overrideWeight > 0) return Number(overrideWeight.toFixed(3));

  const minWeight = toNumber(draft?.minWeight);
  const maxWeight = toNumber(draft?.maxWeight);
  if (minWeight !== null && maxWeight !== null) {
    return Number((((minWeight + maxWeight) / 2)).toFixed(3));
  }
  if (minWeight !== null) return Number(minWeight.toFixed(3));
  if (maxWeight !== null) return Number(maxWeight.toFixed(3));
  return null;
}

function computeDraftPackagePrice(draft, pkg) {
  const sourceUnitPrice = toNumber(draft?.sourceUnitPrice);
  const sourceMultiplier = toNumber(draft?.sourceMultiplier);
  if (sourceUnitPrice === null || sourceMultiplier === null) return null;
  const saleDiscount = Math.max(0, Math.min((toNumber(draft?.saleDiscount) || 0) / 100, 1));
  const vendorFundedSaleDiscount =
    draft?.onSale && saleDiscount > 0 ? saleDiscount / 2 : 0;
  const effectiveSourceMultiplier = sourceMultiplier * (1 - vendorFundedSaleDiscount);

  if (draft?.unitOfMeasure === "lbs") {
    const averageWeight = computeDraftAverageWeight(draft);
    if (averageWeight === null || averageWeight <= 0) return null;
    return roundCurrency(sourceUnitPrice * averageWeight * effectiveSourceMultiplier);
  }

  const quantity = Math.max(toNumber(pkg?.numOfItems) || 1, 1);
  return roundCurrency(sourceUnitPrice * quantity * effectiveSourceMultiplier);
}

function getProductPricingValue(product, key, fallback = "") {
  const profileValue = product?.pricingProfile?.[key];
  if (profileValue !== null && typeof profileValue !== "undefined") {
    return profileValue;
  }
  const directValue = product?.[key];
  if (directValue !== null && typeof directValue !== "undefined") {
    return directValue;
  }
  return fallback;
}

function buildProductDraftFromProduct(product, sanitizeHtml) {
  const unitOfMeasure = getProductPricingValue(product, "unitOfMeasure", "each");
  const sourceUnitPrice = getProductPricingValue(product, "sourceUnitPrice", null);
  const minWeight = getProductPricingValue(product, "minWeight", null);
  const maxWeight = getProductPricingValue(product, "maxWeight", null);
  const avgWeightOverride = getProductPricingValue(product, "avgWeightOverride", null);
  const sourceMultiplier = getProductPricingValue(product, "sourceMultiplier", "0.5412");

  return {
    name: product?.name || "",
    description: sanitizeHtml(product?.description || ""),
    vendorId: product?.vendorId ? String(product.vendorId) : "",
    categoryId: product?.categoryId ? String(product.categoryId) : "",
    visible: Boolean(product?.visible),
    trackInventory: Boolean(product?.trackInventory),
    inventory: Number(product?.inventory) || 0,
    unitOfMeasure: String(unitOfMeasure || "each").toLowerCase() === "lbs" ? "lbs" : "each",
    sourceUnitPrice:
      sourceUnitPrice === null || typeof sourceUnitPrice === "undefined" ? "" : String(sourceUnitPrice),
    minWeight:
      minWeight === null || typeof minWeight === "undefined" ? "" : String(minWeight),
    maxWeight:
      maxWeight === null || typeof maxWeight === "undefined" ? "" : String(maxWeight),
    avgWeightOverride:
      avgWeightOverride === null || typeof avgWeightOverride === "undefined" ? "" : String(avgWeightOverride),
    sourceMultiplier:
      sourceMultiplier === null || typeof sourceMultiplier === "undefined" ? "0.5412" : String(sourceMultiplier),
    onSale: Boolean(product?.onSale),
    saleDiscount: Math.round((Number(product?.saleDiscount) || 0) * 100),
    packages: (product?.packages || []).map((pkg) =>
      createDraftPackage({
        id: pkg.id,
        name: pkg.name || "ea",
        price: pkg.price,
        packageCode: pkg.packageCode,
        unit: pkg.unit,
        numOfItems: pkg.numOfItems,
        visible: pkg.visible === null || typeof pkg.visible === "undefined" ? true : Boolean(pkg.visible),
        trackInventory: Boolean(pkg.trackInventory),
        inventory: pkg.inventory,
        trackType: pkg.trackType,
        chargeType: pkg.chargeType
      })
    )
  };
}

function createEmptyProductDraft() {
  return {
    name: "",
    description: "",
    vendorId: "",
    categoryId: "",
    visible: true,
    trackInventory: false,
    inventory: 0,
    unitOfMeasure: "each",
    sourceUnitPrice: "",
    minWeight: "",
    maxWeight: "",
    avgWeightOverride: "",
    sourceMultiplier: "0.5412",
    onSale: false,
    saleDiscount: 0,
    packages: [createDraftPackage()]
  };
}

function hasLinkedLocalLineProduct(meta) {
  return Number(meta?.localLineProductId) > 0;
}

function normalizeVendorName(value) {
  return String(value || "").trim().toLowerCase();
}

function isSourcePricingVendorName(value) {
  const normalized = normalizeVendorName(value);
  return (
    normalized.includes("deck family farm") ||
    normalized.includes("hyland") ||
    normalized.includes("creamy cow")
  );
}

function getVendorPriceListMarkupDecimal(vendor) {
  return toNumber(vendor?.priceListMarkup ?? vendor?.memberMarkup ?? vendor?.guestMarkup);
}

function createVendorPricingDraft(vendor) {
  const markupDecimal = getVendorPriceListMarkupDecimal(vendor);
  const sourceMultiplier = toNumber(vendor?.sourceMultiplier);
  return {
    priceListMarkup:
      markupDecimal === null ? "" : Number((markupDecimal * 100).toFixed(2)),
    sourceMultiplier:
      sourceMultiplier === null ? "" : String(sourceMultiplier)
  };
}

function vendorPricingDraftEquals(vendor, draft) {
  if (!draft) return true;
  const currentMarkup = getVendorPriceListMarkupDecimal(vendor);
  const draftMarkup = draft.priceListMarkup === "" ? null : Number(draft.priceListMarkup) / 100;
  const currentSourceMultiplier = toNumber(vendor?.sourceMultiplier);
  const draftSourceMultiplier =
    draft.sourceMultiplier === "" ? null : toNumber(draft.sourceMultiplier);

  const markupMatches =
    currentMarkup === null || draftMarkup === null
      ? currentMarkup === draftMarkup
      : Number(currentMarkup.toFixed(4)) === Number(draftMarkup.toFixed(4));
  const factorMatches =
    currentSourceMultiplier === null || draftSourceMultiplier === null
      ? currentSourceMultiplier === draftSourceMultiplier
      : Number(currentSourceMultiplier.toFixed(4)) === Number(draftSourceMultiplier.toFixed(4));

  return markupMatches && factorMatches;
}

function stripHtmlPreview(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LOCAL_PRICELIST_PAGE_SIZE = 50;
const LOCAL_PRICELIST_SEARCH_DEBOUNCE_MS = 250;

export function AdminPanel({ onCatalogRefresh }) {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [currentAdmin, setCurrentAdmin] = useState(null);
  const [loginState, setLoginState] = useState({ username: "", password: "", error: "" });
  const [loginMode, setLoginMode] = useState("login");
  const [forgotState, setForgotState] = useState({
    username: "",
    message: "",
    error: "",
    submitting: false
  });
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState("pricelist");
  const [manualFocusTopic, setManualFocusTopic] = useState("overview");
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedProductDetail, setSelectedProductDetail] = useState(null);
  const [productEditorMode, setProductEditorMode] = useState("existing");
  const [productDraft, setProductDraft] = useState(null);
  const [productSaveLoading, setProductSaveLoading] = useState(false);
  const [productDeleteLoading, setProductDeleteLoading] = useState(false);
  const [pushToLocalLineOnSave, setPushToLocalLineOnSave] = useState(false);
  const [pushProductLoading, setPushProductLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [categories, setCategories] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [reviews, setReviews] = useState([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [dropSites, setDropSites] = useState([]);
  const [dropSitesLoaded, setDropSitesLoaded] = useState(false);
  const [dropSitesSectionLoading, setDropSitesSectionLoading] = useState(false);
  const [dropSitePerformance, setDropSitePerformance] = useState({
    selectedMonth: "",
    months: [],
    thresholdAverage: 4,
    strongAverage: 5,
    rankedSites: []
  });
  const [dropSitePerformanceMonth, setDropSitePerformanceMonth] = useState("");
  const [showZeroDeliverySites, setShowZeroDeliverySites] = useState(false);
  const [showHomeDeliverySites, setShowHomeDeliverySites] = useState(false);
  const [showDropSiteOrderCounts, setShowDropSiteOrderCounts] = useState(false);
  const [message, setMessage] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newVendor, setNewVendor] = useState("");
  const [vendorEdits, setVendorEdits] = useState({});
  const [savingVendorId, setSavingVendorId] = useState(null);
  const [newDropSite, setNewDropSite] = useState({ name: "", address: "", dayOfWeek: "", openTime: "", closeTime: "" });
  const [newRecipe, setNewRecipe] = useState({ title: "", note: "", imageUrl: "", ingredients: "", steps: "" });
  const [productNameSearch, setProductNameSearch] = useState("");
  const [productCategoryFilter, setProductCategoryFilter] = useState("");
  const [productVendorFilter, setProductVendorFilter] = useState("");
  const [productVisibleFilter, setProductVisibleFilter] = useState("visible");
  const [productSaleFilter, setProductSaleFilter] = useState("all");
  const [debouncedProductNameSearch, setDebouncedProductNameSearch] = useState("");
  const [localPricelistProducts, setLocalPricelistProducts] = useState([]);
  const [localPricelistCategories, setLocalPricelistCategories] = useState([]);
  const [localPricelistLoading, setLocalPricelistLoading] = useState(false);
  const [localPricelistPage, setLocalPricelistPage] = useState(1);
  const [localPricelistTotalRows, setLocalPricelistTotalRows] = useState(0);
  const [localPricelistTotalPages, setLocalPricelistTotalPages] = useState(1);
  const [openLocalPricelistMenuProductId, setOpenLocalPricelistMenuProductId] = useState(null);
  const [productEdits, setProductEdits] = useState({});
  const [applyState, setApplyState] = useState({ open: false, updates: [], results: [], error: "" });
  const [applyLoading, setApplyLoading] = useState(false);
  const [localLineAuditState, setLocalLineAuditState] = useState({
    open: false,
    loading: false,
    applying: false,
    applyingFixKey: "",
    appliedFixes: {},
    error: "",
    applyError: "",
    data: null
  });
  const [localLineCacheState, setLocalLineCacheState] = useState({
    open: false,
    loading: false,
    error: "",
    data: null,
    jobId: ""
  });
  const [localLineStatusState, setLocalLineStatusState] = useState({
    loading: false,
    error: "",
    data: null
  });
  const [localLineFulfillmentState, setLocalLineFulfillmentState] = useState({
    open: false,
    loading: false,
    error: "",
    data: null,
    jobId: ""
  });
  const [localLineOrdersState, setLocalLineOrdersState] = useState({
    open: false,
    loading: false,
    error: "",
    data: null,
    jobId: ""
  });
  const [localLineProductDetail, setLocalLineProductDetail] = useState(null);
  const [priceListEntryDrafts, setPriceListEntryDrafts] = useState([]);
  const [priceListSaveLoading, setPriceListSaveLoading] = useState(false);
  const [imageUploadLoading, setImageUploadLoading] = useState(false);
  const [imageDeleteLoadingKey, setImageDeleteLoadingKey] = useState("");
  const isLocalPricelistView = activeSection === "localPricelist";
  const activeProductSource = isLocalPricelistView ? localPricelistProducts : products;
  const activeProduct =
    (selectedProductDetail && selectedProductDetail.id === selectedProductId ? selectedProductDetail : null) ||
    activeProductSource.find((product) => product.id === selectedProductId) ||
    products.find((product) => product.id === selectedProductId) ||
    null;
  const descriptionRef = useRef(null);
  const localPricelistMenuRef = useRef(null);

  async function refreshCatalogFromAdmin() {
    if (typeof onCatalogRefresh !== "function") return;
    try {
      await onCatalogRefresh();
    } catch (_error) {
      // Keep admin flow successful even if storefront refresh fails.
    }
  }

  async function refreshLocalPricelistIfNeeded() {
    if (activeSection !== "localPricelist") return;
    await loadLocalPricelistData();
  }

  async function refreshSelectedProductDetail(productId = selectedProductId) {
    if (!token || !productId || activeSection === "localPricelist") {
      setSelectedProductDetail(null);
      return;
    }

    try {
      const response = await adminGet(`products/${productId}`, token);
      setSelectedProductDetail(response.product || null);
    } catch (_error) {
      setSelectedProductDetail(null);
    }
  }

  function needsProductsData() {
    return (
      activeSection === "inventory" ||
      activeSection === "membership" ||
      (productEditorMode === "new" && activeSection !== "localPricelist")
    );
  }

  async function loadCoreAdminData() {
    const [categoryData, vendorData] = await Promise.all([
      adminGet("categories", token),
      adminGet("vendors", token)
    ]);
    setCategories(categoryData.categories || []);
    setVendors(vendorData.vendors || []);
    setVendorEdits({});
  }

  async function loadProductsData() {
    const productData = await adminGet("products", token);
    setProducts(productData.products || []);
    setProductsLoaded(true);
    setProductEdits({});
  }

  async function loadLocalPricelistData() {
    if (!token) return;
    const params = new URLSearchParams({
      page: String(localPricelistPage),
      pageSize: String(LOCAL_PRICELIST_PAGE_SIZE),
      visibility: productVisibleFilter,
      sale: productSaleFilter
    });
    if (debouncedProductNameSearch) params.set("search", debouncedProductNameSearch);
    if (productCategoryFilter) params.set("categoryId", productCategoryFilter);
    if (productVendorFilter) params.set("vendorId", productVendorFilter);

    setLocalPricelistLoading(true);
    try {
      const response = await adminGet(`local-pricelist-products?${params.toString()}`, token);
      setLocalPricelistCategories(response.categories || []);
      setLocalPricelistProducts(response.products || []);
      setLocalPricelistTotalRows(Number(response.pagination?.totalRows || 0));
      setLocalPricelistTotalPages(Number(response.pagination?.totalPages || 1));
      const nextPage = Number(response.pagination?.page || localPricelistPage);
      if (nextPage !== localPricelistPage) {
        setLocalPricelistPage(nextPage);
      }
    } finally {
      setLocalPricelistLoading(false);
    }
  }

  async function loadRecipesData() {
    const recipeData = await adminGet("recipes", token);
    setRecipes(recipeData.recipes || []);
    setRecipesLoaded(true);
  }

  async function loadReviewsData() {
    const reviewData = await adminGet("reviews", token);
    setReviews(reviewData.reviews || []);
    setReviewsLoaded(true);
  }

  async function loadDropSitesData() {
    setDropSitesSectionLoading(true);
    const query = dropSitePerformanceMonth
      ? `?month=${encodeURIComponent(dropSitePerformanceMonth)}`
      : "";
    try {
      const dropSiteData = await adminGet(`drop-sites${query}`, token);
      setDropSites(dropSiteData.dropSites || []);
      setDropSitePerformance(
        dropSiteData.performance || {
          selectedMonth: "",
          months: [],
          thresholdAverage: 4,
          strongAverage: 5,
          rankedSites: []
        }
      );
      if (!dropSitePerformanceMonth && dropSiteData.performance?.selectedMonth) {
        setDropSitePerformanceMonth(dropSiteData.performance.selectedMonth);
      }
      setDropSitesLoaded(true);
    } finally {
      setDropSitesSectionLoading(false);
    }
  }

  async function loadLocalLineStatusData() {
    setLocalLineStatusState((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const response = await adminGet("localline/status", token);
      setLocalLineStatusState({
        loading: false,
        error: "",
        data: response
      });
      if (response?.fulfillments?.latestJob?.jobId) {
        setLocalLineFulfillmentState((prev) => ({
          ...prev,
          data: response.fulfillments.latestJob,
          jobId: response.fulfillments.latestJob.jobId
        }));
      }
      if (response?.orders?.latestJob?.jobId) {
        setLocalLineOrdersState((prev) => ({
          ...prev,
          data: response.orders.latestJob,
          jobId: response.orders.latestJob.jobId
        }));
      }
    } catch (error) {
      setLocalLineStatusState({
        loading: false,
        error: error?.message || "Failed to load Local Line status.",
        data: null
      });
    }
  }

  async function loadAll() {
    if (!token) return;
    setLoading(true);
    try {
      await loadCoreAdminData();

      const loaders = [];
      if (productsLoaded || needsProductsData()) loaders.push(loadProductsData());
      if (recipesLoaded || activeSection === "recipes") loaders.push(loadRecipesData());
      if (reviewsLoaded || activeSection === "reviews") loaders.push(loadReviewsData());
      if (dropSitesLoaded || activeSection === "dropSites") loaders.push(loadDropSitesData());
      if (activeSection === "localLine") loaders.push(loadLocalLineStatusData());
      await Promise.all(loaders);
    } catch (err) {
      setMessage("Failed to load admin data.");
    } finally {
      setLoading(false);
    }
  }

  async function loadCurrentAdmin() {
    if (!token) return;
    try {
      const response = await adminGet("me", token);
      const admin = response.user || null;
      setCurrentAdmin(admin);
      const roleKeys = admin?.adminRoles || [];
      if (!canAccessAdminSection(roleKeys, activeSection)) {
        setActiveSection(getDefaultAdminSection(roleKeys));
        setProductEditorMode("existing");
        setSelectedProductId(null);
        setSelectedProductDetail(null);
      }
    } catch (_error) {
      setCurrentAdmin(null);
    }
  }

  useEffect(() => {
    if (token) {
      localStorage.setItem("adminToken", token);
      setProducts([]);
      setProductsLoaded(false);
      setSelectedProductDetail(null);
      setLocalPricelistProducts([]);
      setLocalPricelistPage(1);
      setLocalPricelistTotalRows(0);
      setLocalPricelistTotalPages(1);
      setRecipes([]);
      setRecipesLoaded(false);
      setReviews([]);
      setReviewsLoaded(false);
      setDropSites([]);
      setDropSitesLoaded(false);
      setDropSitesSectionLoading(false);
      setDropSitePerformance({
        selectedMonth: "",
        months: [],
        thresholdAverage: 4,
        strongAverage: 5,
        rankedSites: []
      });
      setDropSitePerformanceMonth("");
      setLoading(true);
      loadCoreAdminData()
        .catch(() => {
          setMessage("Failed to load admin data.");
        })
        .finally(() => {
          setLoading(false);
      });
    }
  }, [token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedProductNameSearch(productNameSearch.trim());
    }, LOCAL_PRICELIST_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [productNameSearch]);

  useEffect(() => {
    if (!token) return undefined;

    const timer = window.setTimeout(() => {
      loadCurrentAdmin();
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [token]);

  useEffect(() => {
    if (!token || productsLoaded || !needsProductsData()) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadProductsData()
      .catch(() => {
        if (!cancelled) {
          setMessage("Failed to load products.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeSection, productEditorMode, selectedProductId, productsLoaded]);

  useEffect(() => {
    if (!token || !selectedProductId || productEditorMode === "new" || activeSection === "localPricelist") {
      setSelectedProductDetail(null);
      return;
    }

    refreshSelectedProductDetail(selectedProductId).catch(() => {
      setSelectedProductDetail(null);
    });
  }, [token, selectedProductId, productEditorMode, activeSection]);

  useEffect(() => {
    if (!token || activeSection !== "localPricelist") {
      return;
    }

    loadLocalPricelistData().catch(() => {
      setMessage("Failed to load local pricelist.");
    });
  }, [
    token,
    activeSection,
    localPricelistPage,
    debouncedProductNameSearch,
    productCategoryFilter,
    productVendorFilter,
    productVisibleFilter,
    productSaleFilter
  ]);

  useEffect(() => {
    if (!token || activeSection !== "localLine") {
      return;
    }

    loadLocalLineStatusData().catch(() => {
      setLocalLineStatusState({
        loading: false,
        error: "Failed to load Local Line status.",
        data: null
      });
    });
  }, [token, activeSection]);

  useEffect(() => {
    if (!token || recipesLoaded || activeSection !== "recipes") {
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadRecipesData()
      .catch(() => {
        if (!cancelled) {
          setMessage("Failed to load recipes.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeSection, recipesLoaded]);

  useEffect(() => {
    if (!token || reviewsLoaded || activeSection !== "reviews") {
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadReviewsData()
      .catch(() => {
        if (!cancelled) {
          setMessage("Failed to load reviews.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeSection, reviewsLoaded]);

  useEffect(() => {
    if (!token || dropSitesLoaded || activeSection !== "dropSites") {
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadDropSitesData()
      .catch(() => {
        if (!cancelled) {
          setMessage("Failed to load drop sites.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeSection, dropSitesLoaded]);

  useEffect(() => {
    if (!token || activeSection !== "dropSites" || !dropSitesLoaded) {
      return;
    }

    loadDropSitesData().catch(() => {
      setMessage("Failed to load drop sites.");
    });
  }, [token, activeSection, dropSitePerformanceMonth]);

  useEffect(() => {
    const jobId = localLineCacheState.jobId;
    const status = localLineCacheState.data?.status;

    if (!token || !jobId || !status || (status !== "queued" && status !== "running")) {
      return undefined;
    }

    let cancelled = false;

    async function pollJob() {
      try {
        const response = await adminGet(`localline/full-sync/${jobId}`, token);
        if (cancelled) return;
        setLocalLineCacheState((prev) => ({
          ...prev,
          error: "",
          data: response.job || null,
          jobId: response.job?.jobId || jobId
        }));

        if (response.job?.status === "completed") {
          setMessage("Pull From Local Line completed.");
          await loadAll();
          await refreshCatalogFromAdmin();
        }
      } catch (error) {
        if (cancelled) return;
        setLocalLineCacheState((prev) => ({
          ...prev,
          error: error?.message || "Failed to refresh Pull From Local Line progress."
        }));
      }
    }

    pollJob();
    const intervalId = window.setInterval(pollJob, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, localLineCacheState.jobId, localLineCacheState.data?.status]);

  useEffect(() => {
    const jobId = localLineFulfillmentState.jobId;
    const status = localLineFulfillmentState.data?.status;

    if (!token || !jobId || !status || (status !== "queued" && status !== "running")) {
      return undefined;
    }

    let cancelled = false;

    async function pollJob() {
      try {
        const response = await adminGet(`localline/pull-jobs/${jobId}`, token);
        if (cancelled) return;
        setLocalLineFulfillmentState((prev) => ({
          ...prev,
          error: "",
          data: response.job || null,
          jobId: response.job?.jobId || jobId
        }));

        if (response.job?.status === "completed") {
          setMessage("Local Line fulfillment pull completed.");
          await loadDropSitesData();
          await loadLocalLineStatusData();
        }
      } catch (error) {
        if (cancelled) return;
        setLocalLineFulfillmentState((prev) => ({
          ...prev,
          error: error?.message || "Failed to refresh Local Line fulfillment progress."
        }));
      }
    }

    pollJob();
    const intervalId = window.setInterval(pollJob, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, localLineFulfillmentState.jobId, localLineFulfillmentState.data?.status]);

  useEffect(() => {
    const jobId = localLineOrdersState.jobId;
    const status = localLineOrdersState.data?.status;

    if (!token || !jobId || !status || (status !== "queued" && status !== "running")) {
      return undefined;
    }

    let cancelled = false;

    async function pollJob() {
      try {
        const response = await adminGet(`localline/pull-jobs/${jobId}`, token);
        if (cancelled) return;
        setLocalLineOrdersState((prev) => ({
          ...prev,
          error: "",
          data: response.job || null,
          jobId: response.job?.jobId || jobId
        }));

        if (response.job?.status === "completed") {
          setMessage("Local Line order pull completed.");
          await loadLocalLineStatusData();
        }
      } catch (error) {
        if (cancelled) return;
        setLocalLineOrdersState((prev) => ({
          ...prev,
          error: error?.message || "Failed to refresh Local Line order progress."
        }));
      }
    }

    pollJob();
    const intervalId = window.setInterval(pollJob, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, localLineOrdersState.jobId, localLineOrdersState.data?.status]);

  useEffect(() => {
    if (productEditorMode === "new") {
      return;
    }
    if (activeProduct) {
      setProductDraft(buildProductDraftFromProduct(activeProduct, sanitizeHtml));
      setPushToLocalLineOnSave(false);
    } else {
      setProductDraft(null);
    }
  }, [activeProduct, productEditorMode]);

  useEffect(() => {
    const draftUsesSourcePricing = isSourcePricingVendorName(
      vendors.find((vendor) => String(vendor.id) === String(productDraft?.vendorId || ""))?.name
    );

    if (!productDraft || !draftUsesSourcePricing) {
      return;
    }

    setProductDraft((prev) => {
      if (!prev) return prev;
      let changed = false;
      const nextPackages = (prev.packages || []).map((pkg) => {
        const computedPrice = computeDraftPackagePrice(prev, pkg);
        if (computedPrice === null) return pkg;
        const nextPrice = computedPrice.toFixed(2);
        if (String(pkg.price ?? "") === nextPrice) return pkg;
        changed = true;
        return {
          ...pkg,
          price: nextPrice
        };
      });

      if (!changed) return prev;
      return {
        ...prev,
        packages: nextPackages
      };
    });
  }, [
    productDraft,
    vendors,
    productDraft?.unitOfMeasure,
    productDraft?.sourceUnitPrice,
    productDraft?.minWeight,
    productDraft?.maxWeight,
    productDraft?.avgWeightOverride,
    productDraft?.sourceMultiplier,
    productDraft?.onSale,
    productDraft?.saleDiscount
  ]);

  useEffect(() => {
    if (!token || !selectedProductId || isLocalPricelistView) {
      setLocalLineProductDetail(null);
      setPriceListEntryDrafts([]);
      return;
    }

    let cancelled = false;

    async function loadLocalLineProductDetail() {
      try {
        const response = await adminGet(`localline/products/${selectedProductId}`, token);
        if (cancelled) return;
        setLocalLineProductDetail(response || null);
        setPriceListEntryDrafts(
          (response?.priceListEntries || []).map((entry) => ({
            id: entry.id,
            productId: entry.productId,
            packageId: entry.packageId,
            priceListId: entry.priceListId,
            priceListName: entry.priceListName,
            packageName: entry.packageName,
            productName: entry.productName,
            entryScope: entry.entryScope,
            visible:
              entry.visible === null || typeof entry.visible === "undefined"
                ? true
                : Boolean(entry.visible),
            onSale: Boolean(entry.onSale),
            onSaleToggle: Boolean(entry.onSaleToggle),
            finalPriceCache:
              entry.finalPriceCache === null || typeof entry.finalPriceCache === "undefined"
                ? ""
                : Number(entry.finalPriceCache),
            strikethroughDisplayValue:
              entry.strikethroughDisplayValue === null ||
              typeof entry.strikethroughDisplayValue === "undefined"
                ? ""
                : Number(entry.strikethroughDisplayValue),
            maxUnitsPerOrder:
              entry.maxUnitsPerOrder === null || typeof entry.maxUnitsPerOrder === "undefined"
                ? ""
                : Number(entry.maxUnitsPerOrder)
          }))
        );
      } catch (_error) {
        if (cancelled) return;
        setLocalLineProductDetail(null);
        setPriceListEntryDrafts([]);
      }
    }

    loadLocalLineProductDetail();
    return () => {
      cancelled = true;
    };
  }, [token, selectedProductId, isLocalPricelistView]);

  useEffect(() => {
    if (!descriptionRef.current) return;
    if (!productDraft) {
      descriptionRef.current.innerHTML = "";
      return;
    }
    if (descriptionRef.current.innerHTML !== productDraft.description) {
      descriptionRef.current.innerHTML = productDraft.description || "";
    }
  }, [activeProduct?.id, productDraft?.description]);

  function sanitizeHtml(html) {
    if (!html || typeof html !== "string") return "";
    const template = document.createElement("template");
    template.innerHTML = html;

    const blockedTags = new Set(["SCRIPT", "STYLE"]);
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const toRemove = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (blockedTags.has(node.tagName)) {
        toRemove.push(node);
        continue;
      }
      [...node.attributes].forEach((attr) => {
        if (attr.name.startsWith("on")) {
          node.removeAttribute(attr.name);
        }
        if (attr.name === "href" && attr.value.trim().toLowerCase().startsWith("javascript:")) {
          node.removeAttribute(attr.name);
        }
      });
    }

    toRemove.forEach((node) => node.remove());
    return template.innerHTML;
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginState((prev) => ({ ...prev, error: "" }));
    try {
      const result = await adminLogin(loginState.username, loginState.password);
      const admin = result.user || null;
      setCurrentAdmin(admin);
      setActiveSection(getDefaultAdminSection(admin?.adminRoles || []));
      setProductEditorMode("existing");
      setSelectedProductId(null);
      setSelectedProductDetail(null);
      setToken(result.token);
    } catch (err) {
      setLoginState((prev) => ({
        ...prev,
        error: err?.message || "Unable to sign in"
      }));
    }
  }

  async function handleAdminForgotPassword(event) {
    event.preventDefault();
    setForgotState((prev) => ({ ...prev, submitting: true, error: "", message: "" }));
    try {
      await requestPasswordReset(forgotState.username);
      setForgotState((prev) => ({
        ...prev,
        submitting: false,
        message: "If that username matches an active user with a reset email, a reset email has been sent."
      }));
    } catch (error) {
      setForgotState((prev) => ({
        ...prev,
        submitting: false,
        error: error?.message || "Unable to request password reset."
      }));
    }
  }

  async function handleProductUpdate(productId, field, value) {
    setMessage("");
    try {
      await adminPut(`products/${productId}`, token, { [field]: value });
      setMessage("Product updated.");
      await loadAll();
      await refreshCatalogFromAdmin();
    } catch (err) {
      setMessage("Product update failed.");
    }
  }

  function startNewProductDraft() {
    setProductEditorMode("new");
    setSelectedProductId(null);
    setSelectedProductDetail(null);
    setLocalLineProductDetail(null);
    setPriceListEntryDrafts([]);
    setProductDeleteLoading(false);
    setPushToLocalLineOnSave(false);
    setProductDraft(createEmptyProductDraft());
  }

  function closeProductEditor() {
    setProductEditorMode("existing");
    setSelectedProductId(null);
    setSelectedProductDetail(null);
    setLocalLineProductDetail(null);
    setPriceListEntryDrafts([]);
    setProductDeleteLoading(false);
    setPushToLocalLineOnSave(false);
    setProductDraft(null);
  }

  function openAdminManual(topic = "overview") {
    setManualFocusTopic(topic);
    closeProductEditor();
    setActiveSection("manual");
  }

  function updateDraftPackage(index, patch) {
    setProductDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        packages: prev.packages.map((pkg, pkgIndex) =>
          pkgIndex === index ? { ...pkg, ...patch } : pkg
        )
      };
    });
  }

  function addDraftPackage() {
    setProductDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        packages: [...prev.packages, createDraftPackage({ name: `Package ${prev.packages.length + 1}` })]
      };
    });
  }

  function removeDraftPackage(index) {
    setProductDraft((prev) => {
      if (!prev || prev.packages.length <= 1) return prev;
      return {
        ...prev,
        packages: prev.packages.filter((_, pkgIndex) => pkgIndex !== index)
      };
    });
  }

  function normalizeDraftPackagesForSubmit() {
    return (productDraft?.packages || [])
      .map((pkg) => ({
        id: pkg.id,
        name: String(pkg.name || "").trim() || "ea",
        price: Number(pkg.price),
        packageCode: String(pkg.packageCode || "").trim(),
        unit: String(pkg.unit || "").trim(),
        numOfItems: Number(pkg.numOfItems) || 1,
        visible: Boolean(pkg.visible),
        trackInventory: Boolean(pkg.trackInventory),
        inventory: Number(pkg.inventory) || 0,
        trackType: pkg.trackType || "package",
        chargeType: pkg.chargeType || "package"
      }))
      .filter((pkg) => Number.isFinite(pkg.price));
  }

  function buildSourcePricingPayloadFromDraft() {
    return {
      unitOfMeasure: productDraft?.unitOfMeasure === "lbs" ? "lbs" : "each",
      sourceUnitPrice:
        productDraft?.sourceUnitPrice === "" ? null : Number(productDraft?.sourceUnitPrice),
      minWeight:
        productDraft?.minWeight === "" ? null : Number(productDraft?.minWeight),
      maxWeight:
        productDraft?.maxWeight === "" ? null : Number(productDraft?.maxWeight),
      avgWeightOverride:
        productDraft?.avgWeightOverride === "" ? null : Number(productDraft?.avgWeightOverride)
    };
  }

  async function handlePackageUpdate(packageId, values) {
    setMessage("");
    try {
      await adminPut(`packages/${packageId}`, token, values);
      setMessage("Package updated.");
    } catch (err) {
      setMessage("Package update failed.");
      throw err;
    }
  }

  async function handlePushProductToLocalLine(productId) {
    if (!productId) return;
    setPushProductLoading(true);
    setMessage("");
    try {
      await adminPost(`products/${productId}/push-to-localline`, token, {});
      setMessage("Product pushed to Local Line.");
      await loadAll();
      await refreshLocalPricelistIfNeeded();
      await refreshCatalogFromAdmin();
    } catch (err) {
      setMessage(err?.message || "Local Line push failed.");
    } finally {
      setPushProductLoading(false);
    }
  }

  async function handleDuplicateProduct(productId) {
    setMessage("");
    try {
      const response = await adminPost(`products/${productId}/duplicate`, token, {});
      await loadAll();
      await refreshLocalPricelistIfNeeded();
      await refreshCatalogFromAdmin();
      if (activeSection !== "localPricelist") {
        setProductEditorMode("existing");
        setSelectedProductDetail(null);
        setSelectedProductId(response.productId);
      }
      setMessage("Product duplicated.");
    } catch (err) {
      setMessage(err?.message || "Product duplicate failed.");
    }
  }

  async function handleDeleteProduct(productId) {
    if (!productId) return;
    const confirmed = window.confirm(
      "Delete this local-only product? This removes the product, packages, pricing profile, images, and local admin records."
    );
    if (!confirmed) return;

    setProductDeleteLoading(true);
    setMessage("");
    try {
      const response = await adminDelete(`products/${productId}`, token);
      closeProductEditor();
      await loadAll();
      await refreshLocalPricelistIfNeeded();
      await refreshCatalogFromAdmin();
      setMessage("Product deleted.");
      return response;
    } catch (err) {
      setMessage(err?.message || "Product delete failed.");
      throw err;
    } finally {
      setProductDeleteLoading(false);
    }
  }

  async function handleProductSave() {
    if (!productDraft) return;
    setProductSaveLoading(true);
    setMessage("");
    const vendorId = productDraft.vendorId ? Number(productDraft.vendorId) : null;
    const categoryId = productDraft.categoryId ? Number(productDraft.categoryId) : null;
    const safeDiscount = Math.min(Math.max(Number(productDraft.saleDiscount) || 0, 0), 100);
    const safeDescription = sanitizeHtml(productDraft.description);
    const packagePayloads = normalizeDraftPackagesForSubmit();
    const sourcePricingPayload = buildSourcePricingPayloadFromDraft();

    if (selectedDraftUsesSourcePricing && !Number.isFinite(Number(sourcePricingPayload.sourceUnitPrice))) {
      setMessage("Vendor retail price is required for Deck Family Farm, Hyland, and Creamy Cow products.");
      setProductSaveLoading(false);
      return;
    }

    try {
      if (productEditorMode === "new") {
        const response = await adminPost("products", token, {
          name: productDraft.name,
          description: safeDescription,
          vendorId,
          categoryId,
          visible: productDraft.visible,
          trackInventory: productDraft.trackInventory,
          inventory: Number(productDraft.inventory) || 0,
          onSale: productDraft.onSale,
          saleDiscount: safeDiscount / 100,
          packages: packagePayloads,
          pricingProfile: selectedDraftUsesSourcePricing ? sourcePricingPayload : null
        });

        const newProductId = response.productId;
        if (pushToLocalLineOnSave) {
          await adminPost(`products/${newProductId}/push-to-localline`, token, {});
        }

        await loadAll();
        await refreshLocalPricelistIfNeeded();
        await refreshCatalogFromAdmin();
        if (activeSection !== "localPricelist") {
          setProductEditorMode("existing");
          setSelectedProductDetail(null);
          setSelectedProductId(newProductId);
        } else {
          closeProductEditor();
        }
        setPushToLocalLineOnSave(false);
        setMessage(pushToLocalLineOnSave ? "Product created and pushed to Local Line." : "Product created.");
        return;
      }

      if (!activeProduct) {
        throw new Error("No active product selected");
      }

      await adminPut(`products/${activeProduct.id}`, token, {
        name: productDraft.name,
        description: safeDescription,
        vendorId,
        categoryId,
        visible: productDraft.visible ? 1 : 0,
        trackInventory: productDraft.trackInventory ? 1 : 0,
        inventory: Number(productDraft.inventory) || 0
      });

      await Promise.all(
        packagePayloads
          .filter((pkg) => Number.isFinite(Number(pkg.id)))
          .map((pkg) =>
            handlePackageUpdate(pkg.id, {
              name: pkg.name,
              price: pkg.price,
              packageCode: pkg.packageCode || null,
              unit: pkg.unit || null,
              numOfItems: pkg.numOfItems,
              visible: pkg.visible ? 1 : 0,
              trackInventory: pkg.trackInventory ? 1 : 0,
              inventory: pkg.inventory,
              trackType: pkg.trackType,
              chargeType: pkg.chargeType
            })
          )
      );

      await adminPost("products/bulk-update", token, {
        syncPricingProfileSale: true,
        updates: [
          {
            productId: activeProduct.id,
            changes: {
              onSale: productDraft.onSale ? 1 : 0,
              saleDiscount: safeDiscount / 100
            }
          }
        ]
      });

      if (selectedDraftUsesSourcePricing) {
        await adminPut(`products/${activeProduct.id}/pricing-profile`, token, sourcePricingPayload);
      }

      const linkedLocalLineProductId =
        Number(activeProduct?.localLineMeta?.localLineProductId) ||
        Number(localLineProductDetail?.productMeta?.localLineProductId) ||
        0;
      if (pushToLocalLineOnSave && linkedLocalLineProductId <= 0) {
        await adminPost(`products/${activeProduct.id}/push-to-localline`, token, {});
      }

      await loadAll();
      await refreshLocalPricelistIfNeeded();
      await refreshCatalogFromAdmin();
      await refreshSelectedProductDetail(activeProduct.id);
      setMessage(pushToLocalLineOnSave ? "Product updated and pushed to Local Line." : "Product updated.");
    } catch (err) {
      setMessage(err?.message || "Product update failed.");
    } finally {
      setProductSaveLoading(false);
    }
  }

  function updateDescriptionFromEditor() {
    if (!descriptionRef.current) return;
    const html = descriptionRef.current.innerHTML;
    setProductDraft((prev) => (prev ? { ...prev, description: html } : prev));
  }

  function applyEditorCommand(command, value = null) {
    if (!descriptionRef.current) return;
    descriptionRef.current.focus();
    document.execCommand(command, false, value);
    updateDescriptionFromEditor();
  }

  function applyLink() {
    const url = window.prompt("Enter link URL");
    if (!url) return;
    applyEditorCommand("createLink", url);
  }

  async function handleImageUpload(productId, files) {
    const fileList = Array.isArray(files)
      ? files
      : files instanceof FileList
        ? Array.from(files)
        : files
          ? [files]
          : [];
    if (!fileList.length) return;

    setMessage("");
    setImageUploadLoading(true);
    try {
      for (const file of fileList) {
        await adminUploadImage(productId, token, file);
      }
      setMessage(
        fileList.length === 1
          ? "Image uploaded. Local Line push pending."
          : `${fileList.length} images uploaded. Local Line push pending.`
      );
      if (isLocalPricelistView) {
        await loadLocalPricelistData();
      } else {
        await loadAll();
      }
      await refreshCatalogFromAdmin();
      await refreshSelectedProductDetail(productId);
    } catch (err) {
      setMessage("Image upload failed.");
    } finally {
      setImageUploadLoading(false);
    }
  }

  async function handleImageDelete(productId, image, index) {
    const entry = getImageEntry(image, index);
    if (!entry.src) return;
    if (!window.confirm("Delete this image?")) return;

    setMessage("");
    setImageDeleteLoadingKey(entry.key);
    try {
      await adminDeleteImage(productId, token, {
        url: entry.src,
        thumbnailUrl: entry.thumbnailUrl || entry.src
      });
      setMessage("Image deleted. Local Line push pending.");
      if (isLocalPricelistView) {
        await loadLocalPricelistData();
      } else {
        await loadAll();
      }
      await refreshCatalogFromAdmin();
      await refreshSelectedProductDetail(productId);
    } catch (err) {
      setMessage(err?.message || "Image delete failed.");
    } finally {
      setImageDeleteLoadingKey("");
    }
  }

  function updatePriceListEntryDraft(entryId, patch) {
    setPriceListEntryDrafts((prev) =>
      prev.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry))
    );
  }

  async function handleSavePriceListEntries() {
    if (!activeProduct || !priceListEntryDrafts.length) return;
    setPriceListSaveLoading(true);
    setMessage("");

    try {
      await adminPut(`localline/products/${activeProduct.id}/price-list-entries`, token, {
        entries: priceListEntryDrafts.map((entry) => ({
          id: entry.id,
          packageId: entry.packageId,
          priceListId: entry.priceListId,
          visible: Boolean(entry.visible),
          onSale: Boolean(entry.onSale),
          onSaleToggle: Boolean(entry.onSaleToggle),
          finalPriceCache:
            entry.finalPriceCache === "" ? null : Number(entry.finalPriceCache),
          strikethroughDisplayValue:
            entry.strikethroughDisplayValue === ""
              ? null
              : Number(entry.strikethroughDisplayValue),
          maxUnitsPerOrder:
            entry.maxUnitsPerOrder === "" ? null : Number(entry.maxUnitsPerOrder)
        }))
      });
      setMessage("Local price-list entries updated.");
      const response = await adminGet(`localline/products/${activeProduct.id}`, token);
      setLocalLineProductDetail(response || null);
      setPriceListEntryDrafts(
        (response?.priceListEntries || []).map((entry) => ({
          id: entry.id,
          productId: entry.productId,
          packageId: entry.packageId,
          priceListId: entry.priceListId,
          priceListName: entry.priceListName,
          packageName: entry.packageName,
          productName: entry.productName,
          entryScope: entry.entryScope,
          visible:
            entry.visible === null || typeof entry.visible === "undefined"
              ? true
              : Boolean(entry.visible),
          onSale: Boolean(entry.onSale),
          onSaleToggle: Boolean(entry.onSaleToggle),
          finalPriceCache:
            entry.finalPriceCache === null || typeof entry.finalPriceCache === "undefined"
              ? ""
              : Number(entry.finalPriceCache),
          strikethroughDisplayValue:
            entry.strikethroughDisplayValue === null ||
            typeof entry.strikethroughDisplayValue === "undefined"
              ? ""
              : Number(entry.strikethroughDisplayValue),
          maxUnitsPerOrder:
            entry.maxUnitsPerOrder === null || typeof entry.maxUnitsPerOrder === "undefined"
              ? ""
              : Number(entry.maxUnitsPerOrder)
        }))
      );
      await loadAll();
      await refreshCatalogFromAdmin();
    } catch (_error) {
      setMessage("Local price-list update failed.");
    } finally {
      setPriceListSaveLoading(false);
    }
  }

  async function handleAddCategory() {
    if (!newCategory) return;
    await adminPost("categories", token, { name: newCategory });
    setNewCategory("");
    loadAll();
  }

  async function handleAddVendor() {
    if (!newVendor) return;
    await adminPost("vendors", token, { name: newVendor });
    setNewVendor("");
    loadAll();
  }

  function updateVendorDraft(vendor, patch) {
    if (!vendor?.id) return;
    setVendorEdits((prev) => {
      const currentDraft = prev[vendor.id] || createVendorPricingDraft(vendor);
      const nextDraft = { ...currentDraft, ...patch };
      if (vendorPricingDraftEquals(vendor, nextDraft)) {
        const next = { ...prev };
        delete next[vendor.id];
        return next;
      }
      return {
        ...prev,
        [vendor.id]: nextDraft
      };
    });
  }

  async function handleSaveVendorPricing(vendor) {
    if (!vendor?.id) return;
    const draft = vendorEdits[vendor.id] || createVendorPricingDraft(vendor);
    if (vendorPricingDraftEquals(vendor, draft)) {
      return;
    }

    setSavingVendorId(vendor.id);
    setMessage("");
    try {
      await adminPut(`vendors/${vendor.id}`, token, {
        priceListMarkup:
          draft.priceListMarkup === "" ? null : Number(draft.priceListMarkup) / 100,
        sourceMultiplier:
          draft.sourceMultiplier === "" ? null : Number(draft.sourceMultiplier)
      });
      await loadAll();
      await refreshLocalPricelistIfNeeded();
      await refreshCatalogFromAdmin();
      setMessage(`Vendor pricing updated for ${vendor.name}.`);
    } catch (err) {
      setMessage(err?.message || "Vendor pricing update failed.");
    } finally {
      setSavingVendorId(null);
    }
  }

  async function handleAddDropSite() {
    if (!newDropSite.name) return;
    await adminPost("drop-sites", token, newDropSite);
    setNewDropSite({ name: "", address: "", dayOfWeek: "", openTime: "", closeTime: "" });
    loadAll();
  }

  async function handleLocalLineFulfillmentSync() {
    setMessage("");
    try {
      const response = await adminPost("localline/fulfillment-sync", token, {});
      setLocalLineFulfillmentState({
        open: true,
        loading: false,
        error: "",
        data: response.job || null,
        jobId: response.job?.jobId || ""
      });
      setMessage(
        response.alreadyRunning
          ? "Attached to the running Local Line fulfillment pull."
          : "Local Line fulfillment pull started."
      );
    } catch (error) {
      setMessage(error?.message || "Failed to sync Local Line fulfillments.");
    }
  }

  async function handleLocalLineOrderSync() {
    setMessage("");
    setLocalLineOrdersState({
      open: true,
      loading: true,
      error: "",
      data: null,
      jobId: ""
    });
    try {
      const response = await adminPost("localline/orders-sync", token, {
        cutoffDate: "2026-01-01T00:00:00.000Z"
      });
      setLocalLineOrdersState({
        open: true,
        loading: false,
        error: "",
        data: response.job || null,
        jobId: response.job?.jobId || ""
      });
      setMessage(
        response.alreadyRunning
          ? "Attached to the running Local Line order pull."
          : "Local Line order pull started."
      );
    } catch (error) {
      setLocalLineOrdersState({
        open: true,
        loading: false,
        error: error?.message || "Failed to start Local Line order pull.",
        data: null,
        jobId: ""
      });
    }
  }

  async function handleAddRecipe() {
    if (!newRecipe.title) return;
    await adminPost("recipes", token, {
      title: newRecipe.title,
      note: newRecipe.note,
      imageUrl: newRecipe.imageUrl,
      ingredients: newRecipe.ingredients.split("\n").filter(Boolean),
      steps: newRecipe.steps.split("\n").filter(Boolean),
      published: 1
    });
    setNewRecipe({ title: "", note: "", imageUrl: "", ingredients: "", steps: "" });
    loadAll();
  }

  async function handleReviewStatus(reviewId, status) {
    await adminPut(`reviews/${reviewId}`, token, { status });
    loadAll();
  }

  async function handleApplyChanges() {
    const editEntries = getPendingProductEditEntries();
    if (!editEntries.length) return;

    const updates = editEntries.map(([id, changes]) => {
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

    try {
      const response = await adminPost("products/bulk-update", token, {
        updates: updates.map((update) => ({ productId: update.productId, changes: update.changes }))
      });
      setApplyState((prev) => ({ ...prev, results: response.results || [] }));
      setProductEdits({});
      await loadAll();
    } catch (err) {
      setApplyState((prev) => ({ ...prev, error: "Failed to apply changes." }));
    } finally {
      setApplyLoading(false);
    }
  }

  function closeApplyPanel() {
    setApplyState({ open: false, updates: [], results: [], error: "" });
  }

  async function handleLocalLineFullSync() {
    setLocalLineCacheState({
      open: true,
      loading: true,
      error: "",
      data: null,
      jobId: ""
    });

    try {
      const response = await adminPost("localline/products-sync", token, {
        concurrency: 6
      });
      setLocalLineCacheState({
        open: true,
        loading: false,
        error: "",
        data: response.job || null,
        jobId: response.job?.jobId || ""
      });
      setMessage(
        response.alreadyRunning
          ? "Attached to the running Pull From Local Line job."
          : "Pull From Local Line started."
      );
    } catch (err) {
      setLocalLineCacheState({
        open: true,
        loading: false,
        error:
          err?.status === 404
            ? "Pull From Local Line is not available on the API server at :5177. Restart the API service so it loads /api/admin/localline/products-sync."
            : err?.message || "Failed to run Pull From Local Line.",
        data: null,
        jobId: ""
      });
    }
  }

  async function handleLocalLineAudit() {
    setLocalLineAuditState({
      open: true,
      loading: true,
      applying: false,
      applyingFixKey: "",
      appliedFixes: {},
      error: "",
      applyError: "",
      data: null
    });

    try {
      const response = await adminPost("localline/audit", token, {
        limit: 12,
        concurrency: 6,
        includeInactive: false
      });
      setLocalLineAuditState({
        open: true,
        loading: false,
        applying: false,
        applyingFixKey: "",
        appliedFixes: {},
        error: "",
        applyError: "",
        data: response
      });
    } catch (err) {
      setLocalLineAuditState({
        open: true,
        loading: false,
        applying: false,
        applyingFixKey: "",
        appliedFixes: {},
        error: "Failed to run Local Line sync analysis.",
        applyError: "",
        data: null
      });
    }
  }

  async function handleApplyLocalLineSuggestedFix(fix) {
    if (!auditData || localLineAuditState.loading || localLineAuditState.applying || !fix?.applySupported) {
      return;
    }
    if (!window.confirm(`Apply "${fix.title}"? This only writes csa-store tables in this codebase.`)) {
      return;
    }

    setLocalLineAuditState((prev) => ({
      ...prev,
      applying: true,
      applyingFixKey: fix.key,
      applyError: ""
    }));

    try {
      const response = await adminPost("localline/apply", token, {
        fixKey: fix.key,
        limit: 12,
        concurrency: 6,
        includeInactive: false
      });
      const applySummary = response.applySummary || null;
      const isSuccessful = applySummary && Number(applySummary.errors || 0) === 0;
      setLocalLineAuditState((prev) => ({
        ...prev,
        open: true,
        loading: false,
        applying: false,
        applyingFixKey: "",
        error: "",
        applyError: "",
        appliedFixes: isSuccessful
          ? {
              ...prev.appliedFixes,
              [fix.key]: {
                title: fix.title,
                applied: Number(applySummary.applied || 0),
                skipped: Number(applySummary.skipped || 0),
                attempted: Number(applySummary.attempted || 0)
              }
            }
          : prev.appliedFixes,
        data: prev.data
          ? {
              ...prev.data,
              applySummary,
              sampleApplyResults: response.sampleApplyResults || []
            }
          : response
      }));
      setMessage(
        isSuccessful
          ? `Success: ${fix.title} applied.`
          : `Apply finished for "${fix.title}" with issues.`
      );
      await loadAll();
    } catch (err) {
      setLocalLineAuditState((prev) => ({
        ...prev,
        applying: false,
        applyingFixKey: "",
        applyError: `Failed to apply "${fix.title}".`
      }));
    }
  }

  if (!token) {
    return (
      <div className="container admin-panel">
        <h2 className="h2">Admin Login</h2>
        {loginMode === "forgot" ? (
          <form className="admin-form" onSubmit={handleAdminForgotPassword}>
            <input
              className="input"
              placeholder="Admin username"
              value={forgotState.username}
              onChange={(event) =>
                setForgotState((prev) => ({ ...prev, username: event.target.value }))
              }
            />
            {forgotState.error && <div className="small">{forgotState.error}</div>}
            {forgotState.message && <div className="small">{forgotState.message}</div>}
            <button className="button" type="submit" disabled={forgotState.submitting}>
              {forgotState.submitting ? "Sending..." : "Send reset email"}
            </button>
            <button className="button alt" type="button" onClick={() => setLoginMode("login")}>
              Back to sign in
            </button>
          </form>
        ) : (
          <form className="admin-form" onSubmit={handleLogin}>
            <input
              className="input"
              placeholder="Admin username"
              value={loginState.username}
              onChange={(event) =>
                setLoginState((prev) => ({ ...prev, username: event.target.value }))
              }
            />
            <input
              className="input"
              placeholder="Password"
              type="password"
              value={loginState.password}
              onChange={(event) =>
                setLoginState((prev) => ({ ...prev, password: event.target.value }))
              }
            />
            {loginState.error && <div className="small">{loginState.error}</div>}
            <button className="button" type="submit">
              Sign in
            </button>
            <button className="button alt" type="button" onClick={() => setLoginMode("forgot")}>
              Forgot password
            </button>
          </form>
        )}
      </div>
    );
  }

  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
  const productMap = new Map(products.map((product) => [product.id, product]));
  const sortedVendors = vendors
    .slice()
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
  const pendingProductEditEntries = getPendingProductEditEntries();
  const auditData = localLineAuditState.data;
  const fullSyncJob = localLineCacheState.data;
  const fullSyncRunning =
    fullSyncJob?.status === "queued" || fullSyncJob?.status === "running";
  const localLineStatus = localLineStatusState.data;
  const fulfillmentJob = localLineFulfillmentState.data || localLineStatus?.fulfillments?.latestJob || null;
  const ordersJob = localLineOrdersState.data || localLineStatus?.orders?.latestJob || null;
  const fulfillmentPullRunning =
    fulfillmentJob?.status === "queued" || fulfillmentJob?.status === "running";
  const ordersPullRunning =
    ordersJob?.status === "queued" || ordersJob?.status === "running";
  const dropSitePerformanceRows = dropSitePerformance?.rankedSites || [];
  const dropSiteTrendMode = dropSitePerformance?.mode === "trend6";
  const dropSitePerformanceByStrategyId = new Map(
    dropSitePerformanceRows
      .filter((row) => Number(row.localLineFulfillmentStrategyId || 0) > 0)
      .map((row) => [Number(row.localLineFulfillmentStrategyId), row])
  );
  const dropSitePerformanceByName = new Map(
    dropSitePerformanceRows.map((row) => [String(row.name || "").trim(), row])
  );
  const filteredDropSitePerformanceRows = dropSitePerformanceRows.filter((site) => {
    const isHomeDelivery = String(site.name || "").toLowerCase().includes("home delivery");
    if (!showHomeDeliverySites && isHomeDelivery) return false;
    if (!showZeroDeliverySites && Number(site.orderCount || 0) <= 0) return false;
    return true;
  });
  const filteredDropSites = dropSites.filter((site) => {
    const siteName = String(site.name || "").trim();
    const isHomeDelivery = siteName.toLowerCase().includes("home delivery");
    if (!showHomeDeliverySites && isHomeDelivery) return false;
    const performanceRow =
      dropSitePerformanceByStrategyId.get(Number(site.localLineFulfillmentStrategyId || 0)) ||
      dropSitePerformanceByName.get(siteName) ||
      null;
    if (!showZeroDeliverySites && Number(performanceRow?.orderCount || 0) <= 0) return false;
    return true;
  });
  const maxDropSiteAverage = Math.max(
    1,
    Number(dropSitePerformance?.strongAverage || 5),
    ...filteredDropSitePerformanceRows.flatMap((row) =>
      dropSiteTrendMode
        ? (row.trendSeries || []).map((entry) => Number(entry.averageWeeklyOrders) || 0)
        : [Number(row.averageWeeklyOrders) || 0]
    )
  );
  const productTableWidth = "1464px";
  const currentAdminRoles = currentAdmin?.adminRoles || [];
  const canManageUsers = hasRole(currentAdminRoles, "user_admin");
  const canManagePricing = canAccessAdminSection(currentAdminRoles, "pricelist");
  const canManageLocalPricelist = canAccessAdminSection(currentAdminRoles, "localPricelist");
  const canManageLocalLine = canAccessAdminSection(currentAdminRoles, "localLine");
  const canManageOrders = canAccessAdminSection(currentAdminRoles, "orders");
  const canManageInventory = hasRole(currentAdminRoles, "inventory_admin");
  const canManageMembership = hasRole(currentAdminRoles, "membership_admin");
  const canPullFromLocalLine = hasRole(currentAdminRoles, "localline_pull");
  const canPushToLocalLine = hasRole(currentAdminRoles, "localline_push");
  const canManageDropSites = hasRole(currentAdminRoles, "dropsite_admin");
  const canManageMembers = hasRole(currentAdminRoles, "member_admin");
  const canManageCoreAdmin = currentAdminRoles.includes("admin");
  const showProductEditor =
    (activeSection === "pricelist" || activeSection === "localPricelist") &&
    (canManagePricing || canManageLocalPricelist) &&
    (productEditorMode === "new" || (selectedProductId && activeProduct));
  const selectedDraftVendor = vendors.find(
    (vendor) => String(vendor.id) === String(productDraft?.vendorId || "")
  );
  const selectedDraftUsesSourcePricing = isSourcePricingVendorName(selectedDraftVendor?.name);
  const localPricelistVendors = sortedVendors.filter((vendor) => isSourcePricingVendorName(vendor?.name));
  const editorVendorOptions = activeSection === "localPricelist" ? localPricelistVendors : sortedVendors;
  const linkedLocalLineProductId =
    (hasLinkedLocalLineProduct(localLineProductDetail?.productMeta)
      ? Number(localLineProductDetail?.productMeta?.localLineProductId)
      : 0) ||
    (hasLinkedLocalLineProduct(activeProduct?.localLineMeta)
      ? Number(activeProduct?.localLineMeta?.localLineProductId)
      : 0) ||
    0;

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.classList.toggle("modal-open", showProductEditor);
    return () => {
      document.body.classList.remove("modal-open");
    };
  }, [showProductEditor]);

  useEffect(() => {
    if (!openLocalPricelistMenuProductId) return undefined;

    function handlePointerDown(event) {
      if (!localPricelistMenuRef.current?.contains(event.target)) {
        setOpenLocalPricelistMenuProductId(null);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpenLocalPricelistMenuProductId(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openLocalPricelistMenuProductId]);

  function getProductPrice(product) {
    const prices = (product.packages || [])
      .map((pkg) => Number(pkg.price))
      .filter((value) => Number.isFinite(value));
    if (!prices.length) return "N/A";
    return `$${Math.min(...prices).toFixed(2)}`;
  }

  function toComparableTimestamp(value) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function getProductRemoteSyncStatus(product) {
    return String(product?.pricingProfile?.remoteSyncStatus || "not-applied");
  }

  function hasPendingProductRemoteApply(product) {
    const pricingProfile = product?.pricingProfile;
    if (!pricingProfile) return false;
    return (
      ["pending", "failed"].includes(getProductRemoteSyncStatus(product)) ||
      toComparableTimestamp(pricingProfile.updatedAt) > toComparableTimestamp(pricingProfile.remoteSyncedAt)
    );
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

  function normalizeProductEdit(changes, defaults) {
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

  function getPendingProductEditEntries() {
    return Object.entries(productEdits).filter(([id, changes]) => {
      const product = productMap.get(Number(id));
      if (!product) return false;
      const defaults = getProductDefaults(product);
      const normalized = normalizeProductEdit(changes || {}, defaults);
      return !editsMatch(normalized, defaults);
    });
  }

  function updateProductEdit(productId, patch) {
    const product = productMap.get(productId);
    if (!product) return;
    const defaults = getProductDefaults(product);
    setProductEdits((prev) => {
      const next = { ...prev };
      const current = next[productId] ? { ...defaults, ...next[productId] } : { ...defaults };
      const updated = normalizeProductEdit({ ...current, ...patch }, defaults);
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

  function getLocalPricelistMetaLine(product) {
    const packageName =
      Array.isArray(product?.packages) && product.packages.length
        ? product.packages[0]?.name || `Package ${product.packages[0]?.id || ""}`.trim()
        : "No package";
    return `${packageName} - ${vendorMap.get(product?.vendorId) || "N/A"}`;
  }

  function toggleLocalPricelistActionMenu(productId) {
    setOpenLocalPricelistMenuProductId((prev) => (prev === productId ? null : productId));
  }

  function formatValue(value) {
    if (value === null || typeof value === "undefined" || value === "") return "n/a";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function formatChanges(changes) {
    return Object.entries(changes || {})
      .map(([field, change]) => `${field}: ${formatValue(change.from)} -> ${formatValue(change.to)}`)
      .join(" | ");
  }

  function getImageEntry(image, index) {
    if (typeof image === "string") {
      return {
        key: image,
        src: image,
        thumbnailUrl: image
      };
    }

    const src = image?.url || image?.thumbnailUrl || "";
    return {
      key: src || `image-${index}`,
      src,
      thumbnailUrl: image?.thumbnailUrl || src
    };
  }

  function scrollToAuditSection(sectionId) {
    const element = document.getElementById(sectionId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderLocalLineAuditContent() {
    if (localLineAuditState.loading) {
      return <div className="small">Running Local Line sync...</div>;
    }

    if (localLineAuditState.error) {
      return <div className="small">{localLineAuditState.error}</div>;
    }

    if (!auditData) {
      return <div className="small">No Local Line sync data loaded yet.</div>;
    }

    return (
      <>
        <div className="small">Report: {auditData.reportFile}</div>
        <div className="small">Mode: {auditData.mode}</div>
        <div className="audit-summary-grid">
          <button
            className="response-card audit-nav-card"
            type="button"
            onClick={() => scrollToAuditSection("audit-proposed-changes")}
          >
            <div className="title">Catalog</div>
            <div className="small">Local Line products: {auditData.exportSummary.localLineProducts}</div>
            <div className="small">Local store products: {auditData.exportSummary.storeProducts}</div>
            <div className="small">Missing in store: {auditData.catalogSummary.missingStoreProducts}</div>
            <div className="small">Missing in Local Line: {auditData.catalogSummary.missingLocalLineProducts}</div>
          </button>
          <button
            className="response-card audit-nav-card"
            type="button"
            onClick={() => scrollToAuditSection("audit-proposed-changes")}
          >
            <div className="title">Pending Changes</div>
            <div className="small">Product updates: {auditData.catalogSummary.productUpdates}</div>
            <div className="small">Package updates: {auditData.catalogSummary.packageUpdates}</div>
            <div className="small">Package shape mismatches: {auditData.catalogSummary.packageShapeMismatches}</div>
            <div className="small">
              Suppressed low-signal warnings: {formatValue(auditData.catalogSummary.suppressedLowSignalWarnings?.packageInventoryNullSkipped)}
            </div>
          </button>
          <button
            className="response-card audit-nav-card"
            type="button"
            onClick={() => scrollToAuditSection("audit-warnings")}
          >
            <div className="title">Warnings</div>
            <div className="small">Fixed adjustments: {auditData.pricelistSummary.fixedAdjustmentEntries}</div>
            <div className="small">Product mismatches: {auditData.pricelistSummary.productFieldMismatches}</div>
            <div className="small">Package mismatches: {auditData.pricelistSummary.packageFieldMismatches}</div>
            <div className="small">Price-list mismatches: {auditData.pricelistSummary.priceListEntryMismatches}</div>
          </button>
          <button
            className="response-card audit-nav-card"
            type="button"
            onClick={() => scrollToAuditSection("audit-errors")}
          >
            <div className="title">Errors</div>
            <div className="small">Live fetch errors: {auditData.pricelistSummary.liveFetchErrors}</div>
            <div className="small">Pricing errors: {auditData.pricelistSummary.pricingErrors}</div>
            <div className="small">Missing live products: {auditData.pricelistSummary.missingLiveProducts}</div>
          </button>
        </div>

        <div className="audit-section" id="audit-suggested-fixes">
          <h4>Suggested Fixes</h4>
          <div className="small">Apply is only available after sync analysis finishes. Runnable fixes only write csa-store tables in this codebase.</div>
          {localLineAuditState.applyError && <div className="small">{localLineAuditState.applyError}</div>}
          {(auditData.suggestedFixes || []).length ? (
            <>
              {(auditData.suggestedFixes || []).some((item) => item.applySupported) ? (
                <div className="response-list">
                  {(auditData.suggestedFixes || []).map((item) => (
                    <div className="response-card" key={`fix-${item.key}`}>
                      <div className="title">{item.title}</div>
                      <div className="small">Severity: {item.severity}</div>
                      <div className="small">Count: {item.count}</div>
                      <div className="small">{item.detail}</div>
                      {localLineAuditState.appliedFixes[item.key] ? (
                        <div className="small status-success">
                          Success. Applied {localLineAuditState.appliedFixes[item.key].applied}
                          {localLineAuditState.appliedFixes[item.key].skipped
                            ? `, skipped ${localLineAuditState.appliedFixes[item.key].skipped}`
                            : ""}
                          .
                        </div>
                      ) : item.applySupported ? (
                        <button
                          className="button"
                          type="button"
                          onClick={() => handleApplyLocalLineSuggestedFix(item)}
                          disabled={localLineAuditState.loading || localLineAuditState.applying}
                        >
                          {localLineAuditState.applying && localLineAuditState.applyingFixKey === item.key
                            ? "Applying..."
                            : "Apply"}
                        </button>
                      ) : (
                        <div className="small status-note">Manual review only</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="small">
                  No runnable fixes remain in this sync result. The remaining items are review-only.
                </div>
              )}
            </>
          ) : (
            <div className="small">No suggested fixes generated.</div>
          )}
        </div>

        <div className="audit-section" id="audit-apply-results">
          <h4>Apply Results</h4>
          {auditData.applySummary ? (
            <div className="response-list">
              <div className="response-card">
                <div className="title">Apply Summary</div>
                <div className="small">
                  Fixes: {(auditData.applySummary.selectedFixKeys || []).join(", ") || "all actionable"}
                </div>
                <div className="small">Attempted: {auditData.applySummary.attempted}</div>
                <div className="small">Applied: {auditData.applySummary.applied}</div>
                <div className="small">Skipped: {auditData.applySummary.skipped}</div>
                <div className="small">Errors: {auditData.applySummary.errors}</div>
                <div className="small">Created products: {auditData.applySummary.createdProducts}</div>
                <div className="small">Updated products: {auditData.applySummary.updatedProducts}</div>
                <div className="small">Updated packages: {auditData.applySummary.updatedPackages}</div>
              </div>
              {(auditData.sampleApplyResults || []).map((item, index) => (
                <div className="response-card" key={`apply-result-${item.action}-${item.productId || "none"}-${item.packageId || "none"}-${index}`}>
                  <div className="title">{item.action}</div>
                  <div className="small">Status: {item.status}</div>
                  {item.productId ? <div className="small">Product: {item.productId}</div> : null}
                  {item.packageId ? <div className="small">Package: {item.packageId}</div> : null}
                  {item.updatedFields?.length ? (
                    <div className="small">Fields: {item.updatedFields.join(", ")}</div>
                  ) : null}
                  {item.reason ? <div className="small">Reason: {item.reason}</div> : null}
                  {item.error ? <div className="small">{item.error}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="small">No apply run yet.</div>
          )}
        </div>

        <div className="audit-section" id="audit-errors">
          <h4>Errors</h4>
          {(auditData.sampleLiveFetchErrors?.length || auditData.samplePricingErrors?.length) ? (
            <div className="response-list">
              {(auditData.sampleLiveFetchErrors || []).map((item) => (
                <div className="response-card" key={`fetch-${item.productId}-${item.pricelistId}`}>
                  <div className="title">Product {item.productId}</div>
                  <div className="small">Pricelist row: {item.pricelistId}</div>
                  <div className="small">HTTP status: {item.status}</div>
                  <div className="small">{item.error}</div>
                </div>
              ))}
              {(auditData.samplePricingErrors || []).map((item) => (
                <div className="response-card" key={`pricing-${item.productId}-${item.pricelistId}`}>
                  <div className="title">Product {item.productId}</div>
                  <div className="small">Pricelist row: {item.pricelistId}</div>
                  <div className="small">{item.error}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="small">No row-level errors in the sampled results.</div>
          )}
        </div>

        <div className="audit-section" id="audit-warnings">
          <h4>Warnings</h4>
          <div className="response-list">
            {(auditData.sampleFixedAdjustmentEntries || []).map((item) => (
              <div className="response-card" key={`fixed-${item.productId}-${item.priceListId}`}>
                <div className="title">Fixed adjustment on product {item.productId}</div>
                <div className="small">Price list: {item.priceListName}</div>
                <div className="small">
                  Actual final: {formatValue(item.actual.finalPrice)} | Expected final: {formatValue(item.expected.finalPrice)}
                </div>
                <div className="small">
                  Actual adjustment: type {formatValue(item.actual.adjustmentType)} / {formatValue(item.actual.adjustmentValue)}
                </div>
              </div>
            ))}
            {(auditData.samplePackageShapeMismatches || []).map((item) => (
              <div className="response-card" key={`shape-${item.productId}`}>
                <div className="title">Package shape mismatch on product {item.productId}</div>
                <div className="small">Store packages: {item.storePackageIds.join(", ") || "none"}</div>
                <div className="small">Local Line packages: {item.localLinePackageIds.join(", ") || "none"}</div>
              </div>
            ))}
            {(auditData.sampleMissingStoreProducts || []).map((item) => (
              <div className="response-card" key={`missing-store-${item.productId}`}>
                <div className="title">Missing in local store: {item.productId}</div>
                <div className="small">{item.localLineName}</div>
              </div>
            ))}
            {(auditData.sampleMissingLocalLineProducts || []).map((item) => (
              <div className="response-card" key={`missing-ll-${item.productId}`}>
                <div className="title">Missing in Local Line: {item.productId}</div>
                <div className="small">{item.storeName}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="audit-section" id="audit-proposed-changes">
          <h4>Proposed Store Changes</h4>
          <div className="response-list">
            {(auditData.sampleProposedStoreProductCreates || []).map((item) => (
              <div className="response-card" key={`proposed-create-${item.productId}`}>
                <div className="title">Create store product {item.productId}</div>
                <div className="small">{item.product.name}</div>
                <div className="small">Packages: {(item.packages || []).map((pkg) => pkg.packageId).join(", ") || "none"}</div>
              </div>
            ))}
            {(auditData.sampleProposedStoreProductUpdates || []).map((item) => (
              <div className="response-card" key={`proposed-product-${item.productId}`}>
                <div className="title">Proposed store product update {item.productId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.sampleProposedStorePackageUpdates || []).map((item) => (
              <div className="response-card" key={`proposed-package-${item.packageId}`}>
                <div className="title">Proposed store package update {item.packageId}</div>
                <div className="small">Product: {item.productId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.sampleProposedStorePackageShapeFixes || []).map((item) => (
              <div className="response-card" key={`proposed-shape-${item.action}-${item.packageId}`}>
                <div className="title">{item.action}</div>
                <div className="small">Product: {item.productId}</div>
                <div className="small">Package: {item.packageId}</div>
                <div className="small">{item.package?.name || "n/a"}</div>
              </div>
            ))}
            {!(auditData.sampleProposedStoreProductCreates || []).length &&
            !(auditData.sampleProposedStoreProductUpdates || []).length &&
            !(auditData.sampleProposedStorePackageUpdates || []).length &&
            !(auditData.sampleProposedStorePackageShapeFixes || []).length ? (
              <div className="small">No sample store changes in this result.</div>
            ) : null}
          </div>
        </div>

        <div className="audit-section" id="audit-review-drift">
          <h4>Review-Only Drift</h4>
          <div className="response-list">
            {(auditData.sampleProposedPricelistRowUpdates || []).map((item) => (
              <div className="response-card" key={`proposed-pricelist-${item.pricelistId}`}>
                <div className="title">Proposed pricelist row update {item.pricelistId}</div>
                <div className="small">Product: {item.productId}</div>
                <div className="small">
                  {Object.entries(item.changes || {})
                    .map(([field, value]) => `${field}: ${formatValue(value)}`)
                    .join(" | ")}
                </div>
              </div>
            ))}
            {(auditData.sampleProposedPriceListOverrideCaptures || []).map((item) => (
              <div className="response-card" key={`proposed-override-${item.productId}-${item.priceListId}`}>
                <div className="title">{item.action}</div>
                <div className="small">Product: {item.productId} | List: {item.priceListName || item.priceListId}</div>
                <div className="small">
                  Actual final: {formatValue(item.actual?.finalPrice)} | Expected final: {formatValue(item.expected?.finalPrice)}
                </div>
              </div>
            ))}
            {(auditData.sampleRepairDeadMappings || []).map((item) => (
              <div className="response-card" key={`repair-${item.productId}-${item.pricelistId}`}>
                <div className="title">Repair Local Line mapping</div>
                <div className="small">Product: {item.productId} | Pricelist row: {item.pricelistId}</div>
                <div className="small">Status: {item.status}</div>
              </div>
            ))}
            {(auditData.sampleCatalogProductUpdates || []).map((item) => (
              <div className="response-card" key={`catalog-product-${item.productId}`}>
                <div className="title">Catalog product {item.productId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.sampleCatalogPackageUpdates || []).map((item) => (
              <div className="response-card" key={`catalog-package-${item.packageId}`}>
                <div className="title">Catalog package {item.packageId}</div>
                <div className="small">Product: {item.productId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.samplePricelistProductMismatches || []).map((item) => (
              <div className="response-card" key={`pricelist-product-${item.productId}`}>
                <div className="title">Pricelist product {item.productId}</div>
                <div className="small">Row: {item.pricelistId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.samplePricelistPackageMismatches || []).map((item) => (
              <div className="response-card" key={`pricelist-package-${item.packageId}`}>
                <div className="title">Pricelist package {item.packageId}</div>
                <div className="small">Product: {item.productId} | Row: {item.pricelistId}</div>
                <div className="small">{formatChanges(item.changes)}</div>
              </div>
            ))}
            {(auditData.samplePricelistEntryMismatches || []).map((item) => (
              <div className="response-card" key={`entry-${item.productId}-${item.priceListId}`}>
                <div className="title">Price-list entry mismatch on product {item.productId}</div>
                <div className="small">List: {item.priceListName || item.priceListId}</div>
                <div className="small">Reason: {Array.isArray(item.reason) ? item.reason.join(", ") : item.reason}</div>
                <div className="small">
                  Actual final: {formatValue(item.actual?.finalPrice)} | Expected final: {formatValue(item.expected?.finalPrice)}
                </div>
              </div>
            ))}
            {!(auditData.sampleProposedPricelistRowUpdates || []).length &&
            !(auditData.sampleProposedPriceListOverrideCaptures || []).length &&
            !(auditData.sampleRepairDeadMappings || []).length &&
            !(auditData.sampleCatalogProductUpdates || []).length &&
            !(auditData.sampleCatalogPackageUpdates || []).length &&
            !(auditData.samplePricelistProductMismatches || []).length &&
            !(auditData.samplePricelistPackageMismatches || []).length &&
            !(auditData.samplePricelistEntryMismatches || []).length ? (
              <div className="small">No review-only drift in this sampled result.</div>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  function renderLocalLineCacheContent() {
    const job = localLineCacheState.data;
    const cacheData = job?.result || null;

    if (localLineCacheState.loading && !job) {
      return <div className="small">Starting Pull From Local Line...</div>;
    }

    if (localLineCacheState.error) {
      return <div className="small">{localLineCacheState.error}</div>;
    }

    if (!job) {
      return <div className="small">No Pull From Local Line data loaded yet.</div>;
    }

    return (
      <>
        <div className="small">Job: {job.jobId}</div>
        <div className="small">Status: {job.status}</div>
        {job.progress?.phaseLabel ? (
          <div className="small">
            Current phase: {job.progress.phaseLabel}
            {job.progress?.message ? ` | ${job.progress.message}` : ""}
            {typeof job.progress?.current === "number" && typeof job.progress?.total === "number"
              ? ` (${job.progress.current}/${job.progress.total})`
              : ""}
          </div>
        ) : null}
        <div className="sync-progress">
          <div
            className="sync-progress-bar"
            style={{ width: `${Math.max(0, Math.min(100, Number(job.progress?.percent) || 0))}%` }}
          />
        </div>
        <div className="response-list">
          {(job.phases || []).map((phase) => (
            <div className="response-card" key={`full-sync-phase-${phase.key}`}>
              <div className="title">{phase.label}</div>
              <div className="small">Status: {phase.status}</div>
              <div className="small">Progress: {Math.max(0, Math.min(100, Number(phase.percent) || 0))}%</div>
              {phase.message ? <div className="small">{phase.message}</div> : null}
              {typeof phase.current === "number" && typeof phase.total === "number" ? (
                <div className="small">
                  {phase.current} / {phase.total}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {job.error?.message ? <div className="small">{job.error.message}</div> : null}

        {!cacheData ? (
          <div className="small">Detailed results will appear here when the full sync finishes.</div>
        ) : (
          <>
            <div className="small">Audit report: {cacheData.reportFiles?.audit}</div>
            <div className="small">Cache report: {cacheData.reportFiles?.cache}</div>
            <div className="small">Mode: {cacheData.mode}</div>
        <div className="audit-summary-grid">
          <div className="response-card">
            <div className="title">Catalog Updates</div>
            <div className="small">Applied changes: {cacheData.fullSummary?.appliedCatalogChanges}</div>
            <div className="small">Created products: {cacheData.fullSummary?.createdProducts}</div>
            <div className="small">Updated products: {cacheData.fullSummary?.updatedProducts}</div>
            <div className="small">Updated packages: {cacheData.fullSummary?.updatedPackages}</div>
          </div>
          <div className="response-card">
            <div className="title">Price Lists</div>
            <div className="small">Price lists: {cacheData.fullSummary?.priceLists}</div>
            <div className="small">Package memberships: {cacheData.fullSummary?.packagePriceListMemberships}</div>
            <div className="small">Product memberships: {cacheData.fullSummary?.productPriceListMemberships}</div>
          </div>
          <div className="response-card">
            <div className="title">Images</div>
            <div className="small">Cached media rows: {cacheData.fullSummary?.cachedMediaRows}</div>
            <div className="small">Mirrored product image rows: {cacheData.fullSummary?.mirroredProductImageRows}</div>
            <div className="small">Sync issues: {cacheData.fullSummary?.syncIssueRows}</div>
          </div>
        </div>

        <div className="audit-section">
          <h4>Sample Price Lists</h4>
          <div className="response-list">
            {(cacheData.cache?.samplePriceLists || []).map((item) => (
              <div className="response-card" key={`cache-pricelist-${item.localLinePriceListId}`}>
                <div className="title">{item.name}</div>
                <div className="small">Local Line id: {item.localLinePriceListId}</div>
                <div className="small">Source: {item.source}</div>
              </div>
            ))}
            {!(cacheData.cache?.samplePriceLists || []).length ? (
              <div className="small">No price lists returned in the sample.</div>
            ) : null}
          </div>
        </div>

        <div className="audit-section">
          <h4>Sample Product Media</h4>
          <div className="response-list">
            {(cacheData.cache?.sampleProductMedia || []).map((item, index) => (
              <div className="response-card" key={`cache-media-${item.productId}-${index}`}>
                <div className="title">Product {item.productId}</div>
                <div className="small">Remote URL: {item.remoteUrl}</div>
                <div className="small">Primary: {item.isPrimary ? "Yes" : "No"}</div>
              </div>
            ))}
            {!(cacheData.cache?.sampleProductMedia || []).length ? (
              <div className="small">No product media returned in the sample.</div>
            ) : null}
          </div>
        </div>

        <div className="audit-section">
          <h4>Sample Mirrored Product Images</h4>
          <div className="response-list">
            {(cacheData.cache?.sampleMirroredProductImages || []).map((item, index) => (
              <div className="response-card" key={`cache-mirrored-image-${item.productId}-${index}`}>
                <div className="title">Product {item.productId}</div>
                <div className="small">Local URL: {item.url}</div>
              </div>
            ))}
            {!(cacheData.cache?.sampleMirroredProductImages || []).length ? (
              <div className="small">No mirrored product images in this run.</div>
            ) : null}
          </div>
        </div>

        <div className="audit-section">
          <h4>Sync Issues</h4>
          <div className="response-list">
            {(cacheData.cache?.sampleSyncIssues || []).map((item, index) => (
              <div className="response-card" key={`cache-issue-${item.productId || "none"}-${index}`}>
                <div className="title">{item.issueType}</div>
                <div className="small">Severity: {item.severity}</div>
                {item.productId ? <div className="small">Product: {item.productId}</div> : null}
                <div className="small">{item.detailsJson}</div>
              </div>
            ))}
            {!(cacheData.cache?.sampleSyncIssues || []).length ? (
              <div className="small">No sync issues in this run.</div>
            ) : null}
          </div>
        </div>
          </>
        )}
      </>
    );
  }

  function renderLocalLinePullJobContent(jobState, emptyLabel) {
    const job = jobState?.data;

    if (jobState?.loading && !job) {
      return <div className="small">Starting...</div>;
    }
    if (jobState?.error) {
      return <div className="small">{jobState.error}</div>;
    }
    if (!job) {
      return <div className="small">{emptyLabel}</div>;
    }

    return (
      <>
        <div className="small">Job: {job.jobId}</div>
        <div className="small">Status: {job.status}</div>
        {job.progress?.phaseLabel ? (
          <div className="small">
            Current phase: {job.progress.phaseLabel}
            {job.progress?.message ? ` | ${job.progress.message}` : ""}
            {typeof job.progress?.current === "number" && typeof job.progress?.total === "number"
              ? ` (${job.progress.current}/${job.progress.total})`
              : ""}
          </div>
        ) : null}
        <div className="sync-progress">
          <div
            className="sync-progress-bar"
            style={{ width: `${Math.max(0, Math.min(100, Number(job.progress?.percent) || 0))}%` }}
          />
        </div>
        <div className="response-list">
          {(job.phases || []).map((phase) => (
            <div className="response-card" key={`${job.datasetKey || "localline"}-phase-${phase.key}`}>
              <div className="title">{phase.label}</div>
              <div className="small">Status: {phase.status}</div>
              <div className="small">Progress: {Math.max(0, Math.min(100, Number(phase.percent) || 0))}%</div>
              {phase.message ? <div className="small">{phase.message}</div> : null}
            </div>
          ))}
        </div>
        {job.result ? <div className="small">{JSON.stringify(job.result)}</div> : null}
        {job.error?.message ? <div className="small">{job.error.message}</div> : null}
      </>
    );
  }


  return (
    <div className="container admin-panel">
      <div className="admin-header">
        <h2 className="h2">Admin Dashboard</h2>
      </div>
      {message && <div className="small">{message}</div>}
      {loading && <div className="small">Loading...</div>}

      <div className="admin-layout">
        <aside className="admin-nav">
          {canManageLocalLine ? (
            <button
              className={`admin-nav-item ${activeSection === "localLine" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("localLine");
                closeProductEditor();
              }}
              type="button"
            >
              Local Line
            </button>
          ) : null}
          {canManageOrders ? (
            <button
              className={`admin-nav-item ${activeSection === "orders" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("orders");
                closeProductEditor();
              }}
              type="button"
            >
              Orders
            </button>
          ) : null}
          {canManagePricing ? (
            <button
              className={`admin-nav-item ${activeSection === "pricelist" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("pricelist");
                closeProductEditor();
              }}
              type="button"
            >
              Pricelist
            </button>
          ) : null}
          {canManageLocalPricelist ? (
            <button
              className={`admin-nav-item ${activeSection === "localPricelist" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("localPricelist");
                closeProductEditor();
              }}
              type="button"
            >
              Local Pricelist
            </button>
          ) : null}
          {canManageInventory ? (
            <button
              className={`admin-nav-item ${activeSection === "inventory" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("inventory");
                closeProductEditor();
              }}
              type="button"
            >
              Inventory
            </button>
          ) : null}
          {canManageMembership ? (
            <button
              className={`admin-nav-item ${activeSection === "membership" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("membership");
                closeProductEditor();
              }}
              type="button"
            >
              Membership
            </button>
          ) : null}
          {canManageCoreAdmin ? (
            <>
              <button
                className={`admin-nav-item ${activeSection === "categories" ? "active" : ""}`}
                onClick={() => {
                  setActiveSection("categories");
                  closeProductEditor();
                }}
                type="button"
              >
                Categories
              </button>
              <button
                className={`admin-nav-item ${activeSection === "vendors" ? "active" : ""}`}
                onClick={() => {
                  setActiveSection("vendors");
                  closeProductEditor();
                }}
                type="button"
              >
                Vendors
              </button>
              <button
                className={`admin-nav-item ${activeSection === "recipes" ? "active" : ""}`}
                onClick={() => {
                  setActiveSection("recipes");
                  closeProductEditor();
                }}
                type="button"
              >
                Recipes
              </button>
            </>
          ) : null}
          {canManageDropSites ? (
            <button
              className={`admin-nav-item ${activeSection === "dropSites" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("dropSites");
                closeProductEditor();
              }}
              type="button"
            >
              Drop Sites
            </button>
          ) : null}
          {canManageMembers ? (
            <button
              className={`admin-nav-item ${activeSection === "reviews" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("reviews");
                closeProductEditor();
              }}
              type="button"
            >
              Reviews
            </button>
          ) : null}
          {canManageUsers ? (
            <button
              className={`admin-nav-item admin-users-nav-item ${activeSection === "users" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("users");
                closeProductEditor();
              }}
              type="button"
            >
              Users
            </button>
          ) : null}
          {currentAdmin ? (
            <button
              className={`admin-nav-item ${activeSection === "manual" ? "active" : ""}`}
              onClick={() => openAdminManual("overview")}
              type="button"
            >
              Manual
            </button>
          ) : null}
        </aside>

        <div className="admin-content">
          {activeSection === "localPricelist" && canManageLocalPricelist && (
            <section className="admin-section">
              <h3>Local Pricelist</h3>
              <div className="small">
                Manage local Deck, Hyland, and Creamy Cow products. Use <strong>Edit</strong>
                to edit vendor retail price, unit type, min/max weight, description, and package
                pricing.
              </div>
              <div className="filters product-admin-filters">
                <label className="filter-field product-search-filter">
                  <span className="small">Product name</span>
                  <input
                    className="input"
                    type="search"
                    value={productNameSearch}
                    placeholder="Search products"
                    onChange={(event) => {
                      setProductNameSearch(event.target.value);
                      setLocalPricelistPage(1);
                    }}
                  />
                </label>
                <label className="filter-field">
                  <span className="small">Category</span>
                  <select
                    className="input"
                    value={productCategoryFilter}
                    onChange={(event) => {
                      setProductCategoryFilter(event.target.value);
                      setLocalPricelistPage(1);
                    }}
                  >
                    <option value="">All categories</option>
                    {localPricelistCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-field">
                  <span className="small">Vendor</span>
                  <select
                    className="input"
                    value={productVendorFilter}
                    onChange={(event) => {
                      setProductVendorFilter(event.target.value);
                      setLocalPricelistPage(1);
                    }}
                  >
                    <option value="">All vendors</option>
                    {localPricelistVendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="filter-field">
                  <span className="small">Visibility</span>
                  <select
                    className="input"
                    value={productVisibleFilter}
                    onChange={(event) => {
                      setProductVisibleFilter(event.target.value);
                      setLocalPricelistPage(1);
                    }}
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
                    value={productSaleFilter}
                    onChange={(event) => {
                      setProductSaleFilter(event.target.value);
                      setLocalPricelistPage(1);
                    }}
                  >
                    <option value="all">All</option>
                    <option value="onSale">On sale only</option>
                    <option value="notOnSale">Not on sale</option>
                  </select>
                </label>
              </div>
              <div className="admin-actions">
                <button className="button" type="button" onClick={startNewProductDraft}>
                  Add Product
                </button>
              </div>
              <div className="pricelist-pagination">
                <div className="small pricelist-page-meta">
                  {localPricelistProducts.length
                    ? `${(localPricelistPage - 1) * LOCAL_PRICELIST_PAGE_SIZE + 1}-${(localPricelistPage - 1) * LOCAL_PRICELIST_PAGE_SIZE + localPricelistProducts.length}`
                    : "0"} / {localPricelistTotalRows} products
                </div>
                <div className="small pricelist-page-meta">
                  Page {localPricelistPage} of {localPricelistTotalPages}
                </div>
                <div className="pricelist-page-buttons">
                  <button
                    className="button alt"
                    type="button"
                    onClick={() => setLocalPricelistPage(1)}
                    disabled={localPricelistLoading || localPricelistPage <= 1}
                  >
                    First
                  </button>
                  <button
                    className="button alt"
                    type="button"
                    onClick={() => setLocalPricelistPage((prev) => Math.max(1, prev - 1))}
                    disabled={localPricelistLoading || localPricelistPage <= 1}
                  >
                    Prev
                  </button>
                  <button
                    className="button alt"
                    type="button"
                    onClick={() => setLocalPricelistPage((prev) => Math.min(localPricelistTotalPages, prev + 1))}
                    disabled={localPricelistLoading || localPricelistPage >= localPricelistTotalPages}
                  >
                    Next
                  </button>
                  <button
                    className="button alt"
                    type="button"
                    onClick={() => setLocalPricelistPage(localPricelistTotalPages)}
                    disabled={localPricelistLoading || localPricelistPage >= localPricelistTotalPages}
                  >
                    Last
                  </button>
                </div>
              </div>
              {localPricelistLoading ? <div className="small">Loading local pricelist...</div> : null}
              <div className="admin-table-shell local-pricelist-table-shell">
                <table
                  className="admin-table admin-table-head local-pricelist-table"
                >
                  <colgroup>
                    <col style={{ width: "11%" }} />
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "7%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "154px" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Product Name</th>
                      <th>Vendor's Retail Price</th>
                      <th>Vendor's Unit</th>
                      <th>Min</th>
                      <th>Max</th>
                      <th>On Sale</th>
                      <th>Discount %</th>
                      <th>Description</th>
                      <th className="local-pricelist-actions-col">Actions</th>
                    </tr>
                  </thead>
                </table>
                <div className="admin-table-body-scroll">
                  <table
                    className="admin-table admin-table-body local-pricelist-table"
                  >
                    <colgroup>
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "24%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "14%" }} />
                      <col style={{ width: "154px" }} />
                    </colgroup>
                    <tbody>
                      {localPricelistProducts.map((product) => {
                        const pricingProfile = product.pricingProfile || {};
                        const remoteSyncStatus = getProductRemoteSyncStatus(product);
                        const needsRemotePush = hasPendingProductRemoteApply(product);
                        const unitDisplay =
                          String(pricingProfile.unitOfMeasure || "each").toLowerCase() === "lbs"
                            ? "lbs"
                            : "each";
                        const retailPrice = Number(pricingProfile.sourceUnitPrice);
                        const descriptionPreview = stripHtmlPreview(product.description);
                        const descriptionSummary =
                          !descriptionPreview
                            ? "No description"
                            : descriptionPreview.length > 40
                              ? `${descriptionPreview.slice(0, 40)}...`
                              : descriptionPreview;
                        const minWeight =
                          pricingProfile.minWeight === null || typeof pricingProfile.minWeight === "undefined"
                            ? "n/a"
                            : String(pricingProfile.minWeight);
                        const maxWeight =
                          pricingProfile.maxWeight === null || typeof pricingProfile.maxWeight === "undefined"
                            ? "n/a"
                            : String(pricingProfile.maxWeight);
                        return (
                          <tr key={product.id}>
                            <td>
                              <span className="local-pricelist-cell">
                                {categoryMap.get(product.categoryId) || "Uncategorized"}
                              </span>
                            </td>
                            <td>
                              <div className="admin-product-cell">
                                <div className="admin-product-cell-title">{product.name}</div>
                                <div className="admin-product-cell-meta">{getLocalPricelistMetaLine(product)}</div>
                                <div className={`small pricelist-status ${remoteSyncStatus}`}>{remoteSyncStatus}</div>
                                {needsRemotePush ? <div className="small">Needs push to Local Line</div> : null}
                              </div>
                            </td>
                            <td>
                              <span className="local-pricelist-cell">
                                {Number.isFinite(retailPrice) ? `$${retailPrice.toFixed(2)}` : "n/a"}
                              </span>
                            </td>
                            <td><span className="local-pricelist-cell">{unitDisplay}</span></td>
                            <td><span className="local-pricelist-cell">{minWeight}</span></td>
                            <td><span className="local-pricelist-cell">{maxWeight}</span></td>
                            <td>
                              <span className="local-pricelist-cell">
                                {product.onSale ? "Yes" : "No"}
                              </span>
                            </td>
                            <td>
                              <span className="local-pricelist-cell">
                                {Number.isFinite(Number(product.saleDiscount))
                                  ? `${Math.round(Number(product.saleDiscount) * 100)}%`
                                  : "0%"}
                              </span>
                            </td>
                            <td>
                              <span
                                className="local-pricelist-cell local-pricelist-description"
                                title={descriptionPreview || "No description"}
                              >
                                {descriptionSummary}
                              </span>
                            </td>
                            <td className="local-pricelist-actions-col">
                              <div
                                className="admin-row-actions"
                                ref={openLocalPricelistMenuProductId === product.id ? localPricelistMenuRef : null}
                              >
                                <button
                                  className="button alt"
                                  type="button"
                                  onClick={() => {
                                    setOpenLocalPricelistMenuProductId(null);
                                    setProductEditorMode("existing");
                                    setSelectedProductId(product.id);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="button alt admin-row-menu-trigger"
                                  type="button"
                                  onClick={() => toggleLocalPricelistActionMenu(product.id)}
                                  aria-haspopup="menu"
                                  aria-expanded={openLocalPricelistMenuProductId === product.id}
                                >
                                  ...
                                </button>
                                {openLocalPricelistMenuProductId === product.id ? (
                                  <div className="admin-row-menu" role="menu">
                                    <button
                                      className="admin-row-menu-item"
                                      type="button"
                                      onClick={() => {
                                        setOpenLocalPricelistMenuProductId(null);
                                        handlePushProductToLocalLine(product.id);
                                      }}
                                    >
                                      Push Product
                                    </button>
                                    <button
                                      className="admin-row-menu-item"
                                      type="button"
                                      onClick={() => {
                                        setOpenLocalPricelistMenuProductId(null);
                                        handleDuplicateProduct(product.id);
                                      }}
                                    >
                                      Duplicate Product
                                    </button>
                                    <button
                                      className="admin-row-menu-item"
                                      type="button"
                                      disabled={Number(product?.localLineMeta?.localLineProductId || 0) > 0}
                                      onClick={() => {
                                        setOpenLocalPricelistMenuProductId(null);
                                        handleDeleteProduct(product.id);
                                      }}
                                    >
                                      Delete Product
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {showProductEditor && (
            <div className="modal-backdrop" onClick={closeProductEditor}>
              <div
                className={`modal admin-product-modal ${isLocalPricelistView ? "local-pricelist-modal" : ""}`}
                onClick={(event) => event.stopPropagation()}
              >
                <button className="modal-close" type="button" onClick={closeProductEditor}>
                  Close
                </button>
                <div className="modal-body single">
                  <section className="admin-product-modal-body">
                    <h3>{productEditorMode === "new" ? "New Product" : activeProduct.name}</h3>
                    {productDraft && (
                      <div className="admin-fields">
                  {!isLocalPricelistView ? (
                    <div className="admin-help-banner">
                    <div className="admin-help-banner-copy">
                      <strong>Pricing Help</strong>
                      <div className="small">
                        Open the pricing guide for the full explanation of formula pricing, FFCSA
                        price-list adjustments, and Local Line sync rules.
                      </div>
                    </div>
                    <div className="admin-help-banner-actions">
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => openAdminManual("pricing")}
                      >
                        Open Pricing Guide
                      </button>
                    </div>
                  </div>
                  ) : null}
                  <label className="filter-field">
                    <span className="small">Name</span>
                    <input
                      className="input"
                      value={productDraft.name}
                      onChange={(event) =>
                        setProductDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Vendor</span>
                    <select
                      className="input"
                      value={productDraft.vendorId}
                      onChange={(event) => {
                        const nextVendorId = event.target.value;
                        const nextVendor = vendors.find(
                          (vendor) => String(vendor.id) === String(nextVendorId)
                        ) || null;
                        setProductDraft((prev) => ({
                          ...prev,
                          vendorId: nextVendorId,
                          sourceMultiplier:
                            isSourcePricingVendorName(nextVendor?.name) &&
                            toNumber(nextVendor?.sourceMultiplier) !== null
                              ? String(nextVendor.sourceMultiplier)
                              : prev.sourceMultiplier
                        }));
                      }}
                    >
                      <option value="">Select vendor</option>
                      {editorVendorOptions.map((vendor) => (
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
                      value={productDraft.categoryId}
                      onChange={(event) =>
                        setProductDraft((prev) => ({ ...prev, categoryId: event.target.value }))
                      }
                    >
                      <option value="">Select category</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                      </select>
                  </label>
                  {selectedDraftUsesSourcePricing ? (
                    <>
                      {!isLocalPricelistView ? (
                      <div className="admin-source-pricing-callout">
                        <strong>Deck / Hyland / Creamy pricing</strong>
                        <div className="small">
                          The package price field below is the CSA Package Price for these vendors
                          and is auto-calculated as you enter retail pricing.
                        </div>
                        <ol className="admin-source-pricing-steps">
                          <li>
                            Start with the vendor unit price in <strong>Vendor's Retail Price</strong>.
                          </li>
                          <li>
                            For weight-based items, use <strong>Avg Weight Override</strong> or the
                            average of min and max weight.
                          </li>
                          <li>
                            Apply the FFCSA factor to get the <strong>CSA Package Price</strong>
                            shown in <strong> Price</strong>.
                          </li>
                          <li>
                            Apply Guest, Member, Herd Share, and SNAP adjustments from that package
                            price.
                          </li>
                        </ol>
                      </div>
                      ) : null}
                      <label className="filter-field">
                        <span className="small">{isLocalPricelistView ? "Vendor's Unit" : "Vendor's Unit Type"}</span>
                        <select
                          className="input"
                          value={productDraft.unitOfMeasure}
                          onChange={(event) =>
                            setProductDraft((prev) => ({
                              ...prev,
                              unitOfMeasure: event.target.value
                            }))
                          }
                        >
                          <option value="each">Each</option>
                          <option value="lbs">Lbs</option>
                        </select>
                      </label>
                      <label className="filter-field">
                        <span className="small">Vendor's Retail Price</span>
                        <input
                          className="input"
                          type="number"
                          step="0.01"
                          value={productDraft.sourceUnitPrice}
                          onChange={(event) =>
                            setProductDraft((prev) => ({
                              ...prev,
                              sourceUnitPrice: event.target.value
                            }))
                          }
                        />
                      </label>
                      {productDraft.unitOfMeasure === "lbs" ? (
                        <>
                          <label className="filter-field">
                            <span className="small">Min Weight</span>
                            <input
                              className="input"
                              type="number"
                              step="0.001"
                              value={productDraft.minWeight}
                              onChange={(event) =>
                                setProductDraft((prev) => ({
                                  ...prev,
                                  minWeight: event.target.value
                                }))
                              }
                            />
                          </label>
                          <label className="filter-field">
                            <span className="small">Max Weight</span>
                            <input
                              className="input"
                              type="number"
                              step="0.001"
                              value={productDraft.maxWeight}
                              onChange={(event) =>
                                setProductDraft((prev) => ({
                                  ...prev,
                                  maxWeight: event.target.value
                                }))
                              }
                            />
                          </label>
                        </>
                      ) : null}
                      {productDraft.unitOfMeasure === "lbs" ? (
                        <label className="filter-field">
                          <span className="small">Avg Weight Override</span>
                          <input
                            className="input"
                            type="number"
                            step="0.001"
                            value={productDraft.avgWeightOverride}
                            onChange={(event) =>
                              setProductDraft((prev) => ({
                                ...prev,
                                avgWeightOverride: event.target.value
                              }))
                            }
                          />
                        </label>
                      ) : null}
                      {!isLocalPricelistView ? (
                        <label className="filter-field">
                          <span className="small">FFCSA Factor</span>
                          <input
                            className="input"
                            type="number"
                            step="0.0001"
                            value={productDraft.sourceMultiplier}
                            disabled
                            readOnly
                          />
                          <span className="small">Vendor controlled in the Vendors tab.</span>
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  {!isLocalPricelistView ? (
                  <div className="admin-price-list">
                    <div className="admin-actions">
                      <div className="small">Packages</div>
                      {productEditorMode === "new" ? (
                        <button className="button alt" type="button" onClick={addDraftPackage}>
                          Add Package
                        </button>
                      ) : null}
                    </div>
                    {(productDraft.packages || []).map((pkg, index) => (
                      <div key={pkg.id || `draft-package-${index}`} className="admin-grid">
                        <label className="filter-field">
                          <span className="small">Package name</span>
                          <input
                            className="input"
                            value={pkg.name}
                            onChange={(event) =>
                              updateDraftPackage(index, { name: event.target.value })
                            }
                          />
                        </label>
                        <label className="filter-field">
                          <span className="small">
                            {selectedDraftUsesSourcePricing ? "CSA Package Price" : "Price"}
                          </span>
                          <input
                            className="input"
                            type="number"
                            step="0.01"
                            value={pkg.price}
                            onChange={(event) =>
                              updateDraftPackage(index, { price: event.target.value })
                            }
                          />
                          {selectedDraftUsesSourcePricing ? (
                            <div className="small">
                              Auto-calculated CSA Package Price used for the local store and Local
                              Line package price push.
                            </div>
                          ) : null}
                        </label>
                        {productEditorMode === "new" ? (
                          <>
                            <label className="filter-field">
                              <span className="small">Unit</span>
                              <input
                                className="input"
                                value={pkg.unit}
                                onChange={(event) =>
                                  updateDraftPackage(index, { unit: event.target.value })
                                }
                              />
                            </label>
                            <div className="admin-actions">
                              <button
                                className="button alt"
                                type="button"
                                onClick={() => removeDraftPackage(index)}
                                disabled={productDraft.packages.length <= 1}
                              >
                                Remove
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  ) : null}
                  {productEditorMode === "existing" && !isLocalPricelistView ? (
                    <div className="admin-price-list">
                      <div className="admin-actions">
                        <div className="small">Local Line</div>
                        {canPushToLocalLine && linkedLocalLineProductId <= 0 ? (
                          <button
                            className="button alt"
                            type="button"
                            onClick={() => handlePushProductToLocalLine(activeProduct.id)}
                            disabled={pushProductLoading}
                          >
                            {pushProductLoading ? "Pushing..." : "Push Product To Local Line"}
                          </button>
                        ) : null}
                        {linkedLocalLineProductId <= 0 ? (
                          <button
                            className="button alt"
                            type="button"
                            onClick={() => handleDeleteProduct(activeProduct.id)}
                            disabled={productDeleteLoading}
                          >
                            {productDeleteLoading ? "Deleting..." : "Delete Product"}
                          </button>
                        ) : null}
                      </div>
                      {linkedLocalLineProductId > 0 ? (
                        <div className="small">
                          Local Line product {linkedLocalLineProductId} · Last synced{" "}
                          {localLineProductDetail?.productMeta?.lastSyncedAt || "n/a"}
                        </div>
                      ) : (
                        <div className="small">
                          This product only exists locally right now. It can be deleted because it
                          is not linked to a Local Line product.
                        </div>
                      )}
                      {linkedLocalLineProductId > 0 ? (
                        <>
                          <div className="small">
                            These edits change the locally cached Local Line rows used by the store. They do not push back to Local Line.
                          </div>
                          {priceListEntryDrafts.length ? (
                            <>
                              <table className="admin-table">
                                <thead>
                                  <tr>
                                    <th>List</th>
                                    <th>Package</th>
                                    <th>Scope</th>
                                    <th>Visible</th>
                                    <th>On Sale</th>
                                    <th>Sale Toggle</th>
                                    <th>Final Price</th>
                                    <th>Strike Price</th>
                                    <th>Max Units</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {priceListEntryDrafts.map((entry) => (
                                    <tr key={`price-list-entry-${entry.id}`}>
                                      <td>{entry.priceListName || entry.priceListId}</td>
                                      <td>{entry.packageName || entry.productName || "Product"}</td>
                                      <td>{entry.entryScope || "package"}</td>
                                      <td>
                                        <button
                                          className={`toggle-switch ${entry.visible ? "active" : ""}`}
                                          type="button"
                                          onClick={() =>
                                            updatePriceListEntryDraft(entry.id, { visible: !entry.visible })
                                          }
                                        />
                                      </td>
                                      <td>
                                        <button
                                          className={`toggle-switch ${entry.onSale ? "active" : ""}`}
                                          type="button"
                                          onClick={() =>
                                            updatePriceListEntryDraft(entry.id, { onSale: !entry.onSale })
                                          }
                                        />
                                      </td>
                                      <td>
                                        <button
                                          className={`toggle-switch ${entry.onSaleToggle ? "active" : ""}`}
                                          type="button"
                                          onClick={() =>
                                            updatePriceListEntryDraft(entry.id, {
                                              onSaleToggle: !entry.onSaleToggle
                                            })
                                          }
                                        />
                                      </td>
                                      <td>
                                        <input
                                          className="input"
                                          type="number"
                                          step="0.01"
                                          value={entry.finalPriceCache}
                                          onChange={(event) =>
                                            updatePriceListEntryDraft(entry.id, {
                                              finalPriceCache: event.target.value
                                            })
                                          }
                                        />
                                      </td>
                                      <td>
                                        <input
                                          className="input"
                                          type="number"
                                          step="0.01"
                                          value={entry.strikethroughDisplayValue}
                                          onChange={(event) =>
                                            updatePriceListEntryDraft(entry.id, {
                                              strikethroughDisplayValue: event.target.value
                                            })
                                          }
                                        />
                                      </td>
                                      <td>
                                        <input
                                          className="input"
                                          type="number"
                                          step="1"
                                          value={entry.maxUnitsPerOrder}
                                          onChange={(event) =>
                                            updatePriceListEntryDraft(entry.id, {
                                              maxUnitsPerOrder: event.target.value
                                            })
                                          }
                                        />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <button
                                className="button alt"
                                type="button"
                                onClick={handleSavePriceListEntries}
                                disabled={priceListSaveLoading}
                              >
                                {priceListSaveLoading ? "Saving price lists..." : "Save Local Price Lists"}
                              </button>
                            </>
                          ) : (
                            <div className="small">No cached Local Line price-list entries for this product yet.</div>
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {productEditorMode === "existing" && isLocalPricelistView && linkedLocalLineProductId <= 0 ? (
                    <div className="admin-product-actions">
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => handleDeleteProduct(activeProduct.id)}
                        disabled={productDeleteLoading}
                      >
                        {productDeleteLoading ? "Deleting..." : "Delete Product"}
                      </button>
                    </div>
                  ) : null}
                  {!isLocalPricelistView ? (
                  <>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={productDraft.visible}
                      onChange={(event) =>
                        setProductDraft((prev) => ({ ...prev, visible: event.target.checked }))
                      }
                      />
                    <span>Visible</span>
                  </label>
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={productDraft.trackInventory}
                      onChange={(event) =>
                        setProductDraft((prev) => ({ ...prev, trackInventory: event.target.checked }))
                      }
                    />
                    <span>Track inventory</span>
                  </label>
                  <label className="filter-field">
                    <span className="small">Inventory</span>
                    <input
                      className="input"
                      type="number"
                      value={productDraft.inventory}
                      onChange={(event) =>
                        setProductDraft((prev) => ({
                          ...prev,
                          inventory: Number(event.target.value) || 0
                        }))
                      }
                    />
                  </label>
                  </>
                  ) : null}
                  <div className="admin-sale-fields">
                    <label className="admin-inline-toggle-field">
                      <span className="small">On sale</span>
                      <button
                        className={`toggle-switch ${productDraft.onSale ? "active" : ""}`}
                        type="button"
                        onClick={() =>
                          setProductDraft((prev) => ({ ...prev, onSale: !prev.onSale }))
                        }
                      />
                    </label>
                    <label className="filter-field admin-sale-discount-field">
                      <span className="small">Sale discount</span>
                      <span className="sale-discount-wrapper">
                        <input
                          className="sale-discount-input"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={productDraft.saleDiscount}
                          onChange={(event) =>
                            setProductDraft((prev) => ({
                              ...prev,
                              saleDiscount: Number(event.target.value)
                            }))
                          }
                        />
                        <span className="sale-discount-suffix">%</span>
                      </span>
                    </label>
                  </div>
                  <label className="filter-field">
                    <span className="small">Description</span>
                    <div className="admin-toolbar">
                      <button className="button alt icon-button" type="button" onClick={() => applyEditorCommand("bold")}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M8 5h6a4 4 0 0 1 0 8H8zm0 10h7a4 4 0 0 1 0 8H8z" />
                        </svg>
                      </button>
                      <button className="button alt icon-button" type="button" onClick={() => applyEditorCommand("italic")}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M10 4h8v2h-3l-4 12h3v2H6v-2h3l4-12h-3z" />
                        </svg>
                      </button>
                      <button className="button alt icon-button" type="button" onClick={() => applyEditorCommand("formatBlock", "p")}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 4h6a5 5 0 1 1 0 10H9v6H6zm3 3v4h3a2 2 0 0 0 0-4z" />
                        </svg>
                      </button>
                      <button className="button alt icon-button" type="button" onClick={() => applyEditorCommand("insertUnorderedList")}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 6h11v2H9zm0 5h11v2H9zm0 5h11v2H9zM4 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm0 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm0 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
                        </svg>
                      </button>
                      <button className="button alt icon-button" type="button" onClick={applyLink}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M10.6 13.4a1 1 0 0 0 1.4 1.4l3.9-3.9a3 3 0 1 0-4.2-4.2l-2 2a1 1 0 0 0 1.4 1.4l2-2a1 1 0 1 1 1.4 1.4zm2.8-2.8a1 1 0 0 0-1.4-1.4l-3.9 3.9a3 3 0 0 0 4.2 4.2l2-2a1 1 0 1 0-1.4-1.4l-2 2a1 1 0 1 1-1.4-1.4z" />
                        </svg>
                      </button>
                    </div>
                    <div
                      className="admin-editor"
                      ref={descriptionRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={updateDescriptionFromEditor}
                    />
                  </label>
                </div>
              )}
              {productEditorMode === "existing" && activeProduct ? (
                <div className="admin-price-list">
                  {isLocalPricelistView ? (
                    <>
                      <div className={`small pricelist-status ${getProductRemoteSyncStatus(activeProduct)}`}>
                        {getProductRemoteSyncStatus(activeProduct)}
                      </div>
                      {hasPendingProductRemoteApply(activeProduct) ? (
                        <div className="small">Needs push to Local Line</div>
                      ) : null}
                      {activeProduct?.pricingProfile?.remoteSyncMessage ? (
                        <div className="small">{activeProduct.pricingProfile.remoteSyncMessage}</div>
                      ) : null}
                    </>
                  ) : null}
                  {activeProduct.images?.length ? (
                    <div className="admin-grid">
                      {(activeProduct.images || []).map((image, index) => {
                        const entry = getImageEntry(image, index);
                        if (!entry.src) return null;
                        return (
                          <div key={entry.key} className="admin-image-tile">
                            <img
                              src={entry.thumbnailUrl || entry.src}
                              alt={activeProduct.name}
                              className="admin-thumb"
                            />
                            {isLocalPricelistView ? (
                              <button
                                className="button alt icon-button admin-image-delete-button"
                                type="button"
                                aria-label="Delete image"
                                title="Delete image"
                                disabled={imageDeleteLoadingKey === entry.key}
                                onClick={() => handleImageDelete(activeProduct.id, image, index)}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M9 3h6l1 2h4v2H4V5h4zm1 6h2v8h-2zm4 0h2v8h-2zM7 9h2v8H7zm1 12a2 2 0 0 1-2-2V8h12v11a2 2 0 0 1-2 2z" />
                                </svg>
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="small">
                      {isLocalPricelistView ? "No local images uploaded yet." : "No images uploaded yet."}
                    </div>
                  )}
                  <div className="small">Upload image{isLocalPricelistView ? "s" : ""}</div>
                  <input
                    type="file"
                    accept="image/*"
                    multiple={isLocalPricelistView}
                    disabled={imageUploadLoading}
                    onChange={(event) => {
                      if (!event.target.files?.length) return;
                      handleImageUpload(activeProduct.id, event.target.files);
                      event.target.value = "";
                    }}
                  />
                </div>
              ) : null}
              {productEditorMode === "new" && isLocalPricelistView ? (
                <div className="small">Save the product first, then upload images.</div>
              ) : null}
              {!isLocalPricelistView && canPushToLocalLine && (productEditorMode === "new" || linkedLocalLineProductId <= 0) ? (
                <label className="filter-toggle">
                  <input
                    type="checkbox"
                    checked={pushToLocalLineOnSave}
                    onChange={(event) => setPushToLocalLineOnSave(event.target.checked)}
                  />
                  <span>Push to Local Line when saving</span>
                </label>
              ) : null}
              <div className="admin-product-actions">
                <button
                  className="button"
                  type="button"
                  onClick={handleProductSave}
                  disabled={productSaveLoading}
                >
                  {productSaveLoading
                    ? (productEditorMode === "new" ? "Creating..." : "Saving...")
                    : (
                      productEditorMode === "new"
                        ? "Create product"
                        : (isLocalPricelistView ? "Save Local Changes" : "Save product")
                    )}
                </button>
              </div>
                  </section>
                </div>
              </div>
            </div>
          )}

          {activeSection === "dropSites" && canManageDropSites && (
            <section className="admin-section">
              <h3>Drop Sites</h3>
              <div className="small">
                Local Line fulfillment pulls now live in the <strong>Local Line</strong> section.
                This view shows the local drop-site records, including locally cached Local Line
                fulfillments.
              </div>
              <div className="response-card drop-site-performance-card">
                <div className="title">Host Credit Performance</div>
                <div className="small">
                  Hosts should average at least {Number(dropSitePerformance?.thresholdAverage || 4).toFixed(0)} orders per
                  scheduled drop week. Green is over {Number(dropSitePerformance?.strongAverage || 5).toFixed(0)},
                  orange is {Number(dropSitePerformance?.thresholdAverage || 4).toFixed(0)} to {Number(dropSitePerformance?.strongAverage || 5).toFixed(0)},
                  and red is under {Number(dropSitePerformance?.thresholdAverage || 4).toFixed(0)}.
                </div>
                <div className="pricelist-toolbar-actions drop-site-performance-controls">
                  <label className="filter-field pricelist-page-size">
                    <span className="small">Month</span>
                    <select
                      className="select"
                      value={dropSitePerformanceMonth || dropSitePerformance?.selectedMonth || ""}
                      onChange={(event) => {
                        setDropSitePerformanceMonth(event.target.value);
                      }}
                    >
                      {!(dropSitePerformance?.months || []).length ? (
                        <option value="">No order months yet</option>
                      ) : null}
                      {(dropSitePerformance?.months || []).length ? (
                        <option value="__trend6__">Last 6 month trend</option>
                      ) : null}
                      {(dropSitePerformance?.months || []).map((value) => (
                        <option key={`drop-site-month-${value}`} value={value}>
                          {formatMonthLabel(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="checkbox drop-site-filter-toggle">
                    <input
                      type="checkbox"
                      checked={showZeroDeliverySites}
                      onChange={(event) => setShowZeroDeliverySites(event.target.checked)}
                    />
                    <span>show 0 delivery sites</span>
                  </label>
                  <label className="checkbox drop-site-filter-toggle">
                    <input
                      type="checkbox"
                      checked={showHomeDeliverySites}
                      onChange={(event) => setShowHomeDeliverySites(event.target.checked)}
                    />
                    <span>show home deliveries</span>
                  </label>
                  <label className="checkbox drop-site-filter-toggle">
                    <input
                      type="checkbox"
                      checked={showDropSiteOrderCounts}
                      onChange={(event) => setShowDropSiteOrderCounts(event.target.checked)}
                    />
                    <span>show # orders and scheduled drops</span>
                  </label>
                </div>
                {dropSitesSectionLoading ? (
                  <div className="drop-site-loading">
                    <span className="loading-spinner" aria-hidden="true" />
                    <span className="small">Loading drop sites...</span>
                  </div>
                ) : null}
                <div className="drop-site-performance-chart">
                  {filteredDropSitePerformanceRows.map((site) => {
                    const averageWeeklyOrders = Number(site.averageWeeklyOrders) || 0;
                    const displayAverage = dropSiteTrendMode
                      ? averageWeeklyOrders
                      : averageWeeklyOrders;
                    const widthPercent = Math.max(
                      0,
                      Math.min(100, Math.round((averageWeeklyOrders / maxDropSiteAverage) * 100))
                    );
                    const trendLayout = buildTrendSvgLayout(site.trendSeries || [], maxDropSiteAverage);
                    return (
                      <div className="drop-site-performance-row" key={`drop-site-performance-${site.id}`}>
                        <div className="drop-site-performance-meta">
                          <strong>{site.name}</strong>
                          <div className="small">
                            {displayAverage.toFixed(2)} avg/week
                            {dropSiteTrendMode ? " (6 mo avg)" : ""}
                          </div>
                          {site.derivedHostContact?.name || site.derivedHostContact?.phone ? (
                            <div className="small">
                              Derived Contact: {[site.derivedHostContact?.name, site.derivedHostContact?.phone]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          ) : null}
                          {showDropSiteOrderCounts ? (
                            <div className="small">
                              {Number(site.orderCount || 0)} orders · {Number(site.scheduledDrops || 0)} scheduled drops
                            </div>
                          ) : null}
                        </div>
                        <div className="drop-site-performance-bar-row">
                          {dropSiteTrendMode ? (
                            <div className="drop-site-trend-shell">
                              <svg
                                className="drop-site-trend-svg"
                                viewBox={`0 0 ${trendLayout.width} ${trendLayout.height}`}
                                aria-label={`${site.name} last 6 month trend`}
                                role="img"
                              >
                                <polyline
                                  className="drop-site-trend-line"
                                  fill="none"
                                  points={trendLayout.polylinePoints}
                                />
                                {trendLayout.points.map((point) => (
                                  <circle
                                    key={`${site.id}-${point.weekStart || point.month}`}
                                    className={`drop-site-trend-dot ${point.performanceTier || "bad"}`}
                                    cx={point.x}
                                    cy={point.y}
                                    r="3.5"
                                  >
                                    <title>
                                      {`${formatWeekOfLabel(point.weekStart)} \u00b7 ${formatDeliveryCount(point.orderCount)}`}
                                    </title>
                                  </circle>
                                ))}
                              </svg>
                            </div>
                          ) : (
                            <div className="drop-site-performance-bar-shell">
                              <div
                                className={`drop-site-performance-bar ${site.performanceTier || "bad"}`}
                                style={{ width: `${widthPercent}%` }}
                              />
                              {site.performanceTier === "bad" ? (
                                <span className="drop-site-performance-warning">
                                  does not qualify for drop site host credit this month
                                </span>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!filteredDropSitePerformanceRows.length ? (
                    <div className="small">No drop-site performance data is available for this month yet.</div>
                  ) : null}
                </div>
              </div>
              <div className="admin-grid">
                {filteredDropSites.map((site) => (
                  <div key={site.id} className="card pad">
                    <strong>{site.name}</strong>
                    <div className="small">
                      {site.source === "localline" ? "Local Line fulfillment" : "Local drop site"}
                      {site.type ? ` · ${site.type}` : ""}
                      {site.active ? "" : " · inactive"}
                    </div>
                    {site.address ? <div className="small">{site.address}</div> : null}
                    {site.dayOfWeek || site.openTime || site.closeTime ? (
                      <div className="small">
                        {[site.dayOfWeek, site.openTime && site.closeTime ? `${site.openTime} - ${site.closeTime}` : site.openTime || site.closeTime]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    ) : null}
                    {site.instructions ? (
                      <div className="small">{stripHtml(site.instructions)}</div>
                    ) : null}
                    {site.priceListsJson ? (
                      <div className="small">
                        Price lists: {parseJsonArray(site.priceListsJson).map((entry) => entry.name).filter(Boolean).join(", ") || "None"}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="admin-grid">
                <input className="input" placeholder="Name" value={newDropSite.name} onChange={(event) => setNewDropSite((prev) => ({ ...prev, name: event.target.value }))} />
                <input className="input" placeholder="Address" value={newDropSite.address} onChange={(event) => setNewDropSite((prev) => ({ ...prev, address: event.target.value }))} />
                <input className="input" placeholder="Day of week" value={newDropSite.dayOfWeek} onChange={(event) => setNewDropSite((prev) => ({ ...prev, dayOfWeek: event.target.value }))} />
                <input className="input" placeholder="Open time" value={newDropSite.openTime} onChange={(event) => setNewDropSite((prev) => ({ ...prev, openTime: event.target.value }))} />
                <input className="input" placeholder="Close time" value={newDropSite.closeTime} onChange={(event) => setNewDropSite((prev) => ({ ...prev, closeTime: event.target.value }))} />
                <button className="button alt" type="button" onClick={handleAddDropSite}>Add drop site</button>
              </div>
            </section>
          )}

          {activeSection === "pricelist" && canManagePricing && (
            <>
              <AdminPriceListSection
                token={token}
                categories={categories}
                vendors={vendors}
                onDataRefresh={loadAll}
                onCatalogRefresh={refreshCatalogFromAdmin}
                onAddProduct={startNewProductDraft}
                onDuplicateProduct={handleDuplicateProduct}
                onDeleteProduct={handleDeleteProduct}
                onOpenPricingGuide={() => openAdminManual("pricing")}
                onOpenProductDetails={(productId) => {
                  setProductEditorMode("existing");
                  setSelectedProductId(productId);
                }}
              />
            </>
          )}

          {activeSection === "manual" && currentAdmin && (
            <AdminManualSection focusTopic={manualFocusTopic} />
          )}

          {activeSection === "localLine" && canManageLocalLine && (
            <section className="admin-section">
              <h3>Local Line</h3>
              <div className="small">
                Review incoming Local Line catalog changes and run dataset pulls for products,
                fulfillments, and orders from one place.
              </div>
              {localLineStatusState.loading && !localLineStatus ? (
                <div className="small">Loading Local Line status...</div>
              ) : null}
              {localLineStatusState.error ? (
                <div className="small">{localLineStatusState.error}</div>
              ) : null}
              <div className="audit-summary-grid">
                <div className="response-card">
                  <div className="title">Product Review</div>
                  <div className="small">Cached products: {Number(localLineStatus?.products?.cachedProducts || 0)}</div>
                  <div className="small">Sync issues: {Number(localLineStatus?.products?.syncIssues || 0)}</div>
                  <div className="small">Last product sync: {localLineStatus?.products?.lastSyncedAt || "Never"}</div>
                  <div className="small">Latest pull job: {localLineStatus?.products?.latestJob?.status || "Never run"}</div>
                  <div className="admin-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={handleLocalLineAudit}
                      disabled={localLineAuditState.loading || !canPullFromLocalLine}
                    >
                      {localLineAuditState.loading ? "Reviewing..." : "Review Local Line"}
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={handleLocalLineFullSync}
                      disabled={!canPullFromLocalLine || localLineCacheState.loading || fullSyncRunning}
                    >
                      {localLineCacheState.loading
                        ? "Starting Pull..."
                        : fullSyncRunning
                          ? "Pull Running..."
                          : "Pull Products"}
                    </button>
                  </div>
                </div>
                <div className="response-card">
                  <div className="title">Fulfillments</div>
                  <div className="small">Stored locally: {Number(localLineStatus?.fulfillments?.totalRows || 0)}</div>
                  <div className="small">Active: {Number(localLineStatus?.fulfillments?.activeRows || 0)}</div>
                  <div className="small">Last fulfillment sync: {localLineStatus?.fulfillments?.lastSyncedAt || "Never"}</div>
                  <div className="small">Cursor status: {localLineStatus?.fulfillments?.cursor?.lastStatus || "Never run"}</div>
                  <div className="admin-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={handleLocalLineFulfillmentSync}
                      disabled={fulfillmentPullRunning}
                    >
                      {fulfillmentPullRunning ? "Pull Running..." : "Pull Fulfillments"}
                    </button>
                  </div>
                </div>
                <div className="response-card">
                  <div className="title">Orders</div>
                  <div className="small">Stored locally: {Number(localLineStatus?.orders?.totalRows || 0)}</div>
                  <div className="small">Latest remote order: {localLineStatus?.orders?.latestCreatedAt || "Never"}</div>
                  <div className="small">Cursor: {localLineStatus?.orders?.cursor?.cursorValue || "Not set"}</div>
                  <div className="small">Cursor status: {localLineStatus?.orders?.cursor?.lastStatus || "Never run"}</div>
                  <div className="small">
                    Sync window start: January 1, 2026
                  </div>
                  <div className="admin-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={handleLocalLineOrderSync}
                      disabled={!canPullFromLocalLine || ordersPullRunning || localLineOrdersState.loading}
                    >
                      {ordersPullRunning || localLineOrdersState.loading ? "Pull Running..." : "Pull Orders"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="audit-section">
                <h4>Recent Orders</h4>
                <div className="response-list">
                  {(localLineStatus?.orders?.recentOrders || []).map((order) => (
                    <div className="response-card" key={`recent-localline-order-${order.localLineOrderId}`}>
                      <div className="title">Order {order.localLineOrderId}</div>
                      <div className="small">Created: {order.createdAtRemote || "n/a"}</div>
                      <div className="small">Status: {order.status || "n/a"}</div>
                      <div className="small">Customer: {order.customerName || "n/a"}</div>
                      <div className="small">Price list: {order.priceListName || "n/a"}</div>
                      <div className="small">Total: {order.total || "0.00"}</div>
                    </div>
                  ))}
                  {!(localLineStatus?.orders?.recentOrders || []).length ? (
                    <div className="small">No Local Line orders cached yet.</div>
                  ) : null}
                </div>
              </div>
              <div className="audit-section">
                <h4>Review Local Line</h4>
                {renderLocalLineAuditContent()}
              </div>
              <div className="audit-section">
                <h4>Pull Products</h4>
                {renderLocalLineCacheContent()}
              </div>
              <div className="audit-section">
                <h4>Pull Fulfillments</h4>
                {renderLocalLinePullJobContent(
                  localLineFulfillmentState,
                  "No Local Line fulfillment pull has run yet."
                )}
              </div>
              <div className="audit-section">
                <h4>Pull Orders</h4>
                {renderLocalLinePullJobContent(
                  localLineOrdersState,
                  "No Local Line order pull has run yet."
                )}
              </div>
            </section>
          )}

          {activeSection === "orders" && canManageOrders && (
            <AdminOrdersSection token={token} />
          )}

          {activeSection === "inventory" && canManageInventory && (
            <AdminInventorySection
              token={token}
              products={products}
              categories={categories}
              vendors={vendors}
              onDataRefresh={loadAll}
              onCatalogRefresh={refreshCatalogFromAdmin}
            />
          )}

          {activeSection === "membership" && canManageMembership && (
            <AdminMembershipSection
              token={token}
              products={products}
              categories={categories}
              onDataRefresh={loadAll}
              onCatalogRefresh={refreshCatalogFromAdmin}
            />
          )}

          {activeSection === "users" && canManageUsers && (
            <AdminUsersSection token={token} currentAdmin={currentAdmin} />
          )}

          {activeSection === "categories" && canManageCoreAdmin && (
            <section className="admin-section">
              <h3>Categories</h3>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((category) => (
                    <tr key={category.id}>
                      <td>{category.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="admin-grid">
                <input
                  className="input"
                  placeholder="New category"
                  value={newCategory}
                  onChange={(event) => setNewCategory(event.target.value)}
                />
                <button className="button alt" type="button" onClick={handleAddCategory}>
                  Add category
                </button>
              </div>
            </section>
          )}

          {activeSection === "vendors" && canManageCoreAdmin && (
            <section className="admin-section">
              <h3>Vendors</h3>
              <div className="small">
                Set the vendor-level pricelist markup and, for Deck / Hyland / Creamy vendors,
                the FFCSA factor used by source-priced products.
              </div>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Pricelist Markup %</th>
                    <th>FFCSA Factor</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedVendors.map((vendor) => {
                    const draft = vendorEdits[vendor.id] || createVendorPricingDraft(vendor);
                    const isDirty = !vendorPricingDraftEquals(vendor, draft);
                    const isSourceVendor = isSourcePricingVendorName(vendor?.name);
                    const isSaving = savingVendorId === vendor.id;

                    return (
                      <tr key={vendor.id} className={isDirty ? "edited" : ""}>
                        <td>{vendor.name}</td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            step="0.01"
                            value={draft.priceListMarkup}
                            onChange={(event) =>
                              updateVendorDraft(vendor, {
                                priceListMarkup: event.target.value === "" ? "" : Number(event.target.value)
                              })
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            step="0.0001"
                            value={draft.sourceMultiplier}
                            placeholder={isSourceVendor ? "0.5412" : "N/A"}
                            disabled={!isSourceVendor}
                            onChange={(event) =>
                              updateVendorDraft(vendor, {
                                sourceMultiplier: event.target.value
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="button alt"
                            type="button"
                            disabled={!isDirty || isSaving}
                            onClick={() => handleSaveVendorPricing(vendor)}
                          >
                            {isSaving ? "Saving..." : "Save"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="admin-grid">
                <input
                  className="input"
                  placeholder="New vendor"
                  value={newVendor}
                  onChange={(event) => setNewVendor(event.target.value)}
                />
                <button className="button alt" type="button" onClick={handleAddVendor}>
                  Add vendor
                </button>
              </div>
            </section>
          )}

          {activeSection === "recipes" && canManageCoreAdmin && (
            <section className="admin-section">
              <h3>Recipes</h3>
              <div className="admin-grid">
                {recipes.map((recipe) => (
                  <div key={recipe.id} className="card pad">
                    <strong>{recipe.title}</strong>
                    <div className="small">{recipe.note}</div>
                  </div>
                ))}
              </div>
              <div className="admin-grid">
                <input className="input" placeholder="Title" value={newRecipe.title} onChange={(event) => setNewRecipe((prev) => ({ ...prev, title: event.target.value }))} />
                <input className="input" placeholder="Image URL" value={newRecipe.imageUrl} onChange={(event) => setNewRecipe((prev) => ({ ...prev, imageUrl: event.target.value }))} />
                <textarea className="textarea" placeholder="Note" value={newRecipe.note} onChange={(event) => setNewRecipe((prev) => ({ ...prev, note: event.target.value }))} />
                <textarea className="textarea" placeholder="Ingredients (one per line)" value={newRecipe.ingredients} onChange={(event) => setNewRecipe((prev) => ({ ...prev, ingredients: event.target.value }))} />
                <textarea className="textarea" placeholder="Steps (one per line)" value={newRecipe.steps} onChange={(event) => setNewRecipe((prev) => ({ ...prev, steps: event.target.value }))} />
                <button className="button alt" type="button" onClick={handleAddRecipe}>Add recipe</button>
              </div>
            </section>
          )}

          {activeSection === "reviews" && canManageMembers && (
            <section className="admin-section">
              <h3>Reviews</h3>
              <div className="admin-grid">
                {reviews.map((review) => (
                  <div key={review.id} className="card pad">
                    <strong>{review.title || "Review"}</strong>
                    <div className="small">Rating: {review.rating}</div>
                    {review.userEmail && <div className="small">User: {review.userEmail}</div>}
                    <div className="small">Status: {review.status}</div>
                    <button className="button alt" type="button" onClick={() => handleReviewStatus(review.id, "approved")}>Approve</button>
                    <button className="button alt" type="button" onClick={() => handleReviewStatus(review.id, "rejected")}>Reject</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {applyState.open && (
        <div className="modal-backdrop" onClick={closeApplyPanel}>
          <div className="modal response-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Updates Applied</h3>
            <div className="response-progress">
              Updating {applyState.results.length} of {applyState.updates.length} products
            </div>
            {applyState.error && <div className="small">{applyState.error}</div>}
            <div className="response-list">
              {applyState.updates.map((update) => {
                const result = (applyState.results || []).find(
                  (item) => item.productId === update.productId
                );
                const databaseOk = result ? result.databaseUpdate : null;
                const localLineOk = result ? result.localLineUpdate : null;
                const localLinePriceOk = result ? result.localLinePriceUpdate : null;
                const dbLabel = databaseOk === null || databaseOk === undefined ? "Pending" : databaseOk ? "Updated" : "Failed";
                const llLabel = localLineOk === null || localLineOk === undefined ? "Skipped" : localLineOk ? "Updated" : "Failed";
                const llPriceLabel =
                  localLinePriceOk === null || localLinePriceOk === undefined
                    ? "Skipped"
                    : localLinePriceOk
                    ? "Updated"
                    : "Failed";
                const dbClass = databaseOk ? "ok" : databaseOk === null ? "pending" : "warn";
                const llClass = localLineOk ? "ok" : localLineOk === null ? "pending" : "warn";
                const llPriceClass = localLinePriceOk ? "ok" : localLinePriceOk === null ? "pending" : "warn";

                return (
                  <div className="response-card" key={update.productId}>
                    <div className="title">{update.productName}</div>
                    <div className="small">Category: {update.category}</div>
                    <div className="small">
                      Visible: {update.display.visible} · Track: {update.display.trackInventory} · Stock: {update.display.inventory}
                    </div>
                    <div className="small">
                      Sale: {update.display.onSale} · Discount: {update.display.saleDiscount}%
                    </div>
                    <div>Database: <span className={`status ${dbClass}`}>{dbLabel}</span></div>
                    <div>LocalLine: <span className={`status ${llClass}`}>{llLabel}</span></div>
                    <div>LocalLine Pricing: <span className={`status ${llPriceClass}`}>{llPriceLabel}</span></div>
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

    </div>
  );
}
