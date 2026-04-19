import React, { useEffect, useRef, useState } from "react";
import { AdminInventorySection } from "./AdminInventorySection.jsx";
import { AdminMembershipSection } from "./AdminMembershipSection.jsx";
import { AdminPriceListSection } from "./AdminPriceListSection.jsx";
import { AdminUsersSection } from "./AdminUsersSection.jsx";
import {
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
    case "pricelist":
      return (
        roleKeys.includes("pricing_admin") ||
        roleKeys.includes("localline_pull") ||
        roleKeys.includes("localline_push")
      );
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
    "pricelist",
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
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [productDraft, setProductDraft] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [dropSites, setDropSites] = useState([]);
  const [message, setMessage] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newVendor, setNewVendor] = useState("");
  const [newDropSite, setNewDropSite] = useState({ name: "", address: "", dayOfWeek: "", openTime: "", closeTime: "" });
  const [newRecipe, setNewRecipe] = useState({ title: "", note: "", imageUrl: "", ingredients: "", steps: "" });
  const [productNameSearch, setProductNameSearch] = useState("");
  const [showProductNameSuggestions, setShowProductNameSuggestions] = useState(false);
  const [productCategoryFilter, setProductCategoryFilter] = useState("");
  const [productVendorFilter, setProductVendorFilter] = useState("");
  const [productVisibleFilter, setProductVisibleFilter] = useState("visible");
  const [productSaleFilter, setProductSaleFilter] = useState("all");
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
  const [localLineProductDetail, setLocalLineProductDetail] = useState(null);
  const [priceListEntryDrafts, setPriceListEntryDrafts] = useState([]);
  const [priceListSaveLoading, setPriceListSaveLoading] = useState(false);
  const activeProduct = products.find((product) => product.id === selectedProductId);
  const descriptionRef = useRef(null);

  async function refreshCatalogFromAdmin() {
    if (typeof onCatalogRefresh !== "function") return;
    try {
      await onCatalogRefresh();
    } catch (_error) {
      // Keep admin flow successful even if storefront refresh fails.
    }
  }

  async function loadAll() {
    setLoading(true);
    try {
      const [productData, categoryData, vendorData, recipeData, reviewData, dropSiteData] = await Promise.all([
        adminGet("products", token),
        adminGet("categories", token),
        adminGet("vendors", token),
        adminGet("recipes", token),
        adminGet("reviews", token),
        adminGet("drop-sites", token)
      ]);
      setProducts(productData.products || []);
      setCategories(categoryData.categories || []);
      setVendors(vendorData.vendors || []);
      setRecipes(recipeData.recipes || []);
      setReviews(reviewData.reviews || []);
      setDropSites(dropSiteData.dropSites || []);
      setProductEdits({});
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
        setSelectedProductId(null);
      }
    } catch (_error) {
      setCurrentAdmin(null);
    }
  }

  useEffect(() => {
    if (token) {
      localStorage.setItem("adminToken", token);
      loadCurrentAdmin();
      loadAll();
    }
  }, [token]);

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
    if (activeProduct) {
      setProductDraft({
        name: activeProduct.name || "",
        description: sanitizeHtml(activeProduct.description || ""),
        vendorId: activeProduct.vendorId ? String(activeProduct.vendorId) : "",
        categoryId: activeProduct.categoryId ? String(activeProduct.categoryId) : "",
        visible: Boolean(activeProduct.visible),
        onSale: Boolean(activeProduct.onSale),
        saleDiscount: Math.round((Number(activeProduct.saleDiscount) || 0) * 100)
      });
    } else {
      setProductDraft(null);
    }
  }, [activeProduct]);

  useEffect(() => {
    if (!token || !selectedProductId) {
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
  }, [token, selectedProductId]);

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
      setSelectedProductId(null);
      setToken(result.token);
    } catch (err) {
      setLoginState((prev) => ({ ...prev, error: "Invalid credentials" }));
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

  async function handlePackageUpdate(packageId, value) {
    setMessage("");
    try {
      await adminPut(`packages/${packageId}`, token, { price: value });
      setMessage("Package price updated.");
      await loadAll();
      await refreshCatalogFromAdmin();
    } catch (err) {
      setMessage("Package update failed.");
    }
  }

  async function handleProductSave() {
    if (!activeProduct || !productDraft) return;
    setMessage("");
    const vendorId = productDraft.vendorId ? Number(productDraft.vendorId) : null;
    const categoryId = productDraft.categoryId ? Number(productDraft.categoryId) : null;
    try {
      const safeDescription = sanitizeHtml(productDraft.description);
      await adminPut(`products/${activeProduct.id}`, token, {
        name: productDraft.name,
        description: safeDescription,
        vendorId,
        categoryId,
        visible: productDraft.visible ? 1 : 0
      });
      const safeDiscount = Math.min(Math.max(Number(productDraft.saleDiscount) || 0, 0), 100);
      await adminPost("products/bulk-update", token, {
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
      setMessage("Product updated.");
      await loadAll();
      await refreshCatalogFromAdmin();
    } catch (err) {
      setMessage("Product update failed.");
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

  async function handleImageUpload(productId, file) {
    setMessage("");
    try {
      await adminUploadImage(productId, token, file);
      setMessage("Image uploaded.");
      await loadAll();
      await refreshCatalogFromAdmin();
    } catch (err) {
      setMessage("Image upload failed.");
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

  async function handleAddDropSite() {
    if (!newDropSite.name) return;
    await adminPost("drop-sites", token, newDropSite);
    setNewDropSite({ name: "", address: "", dayOfWeek: "", openTime: "", closeTime: "" });
    loadAll();
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

  function closeLocalLineCachePanel() {
    setLocalLineCacheState({
      open: false,
      loading: false,
      error: "",
      data: null,
      jobId: ""
    });
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

  function closeLocalLineAuditPanel() {
    setLocalLineAuditState({
      open: false,
      loading: false,
      applying: false,
      applyingFixKey: "",
      appliedFixes: {},
      error: "",
      applyError: "",
      data: null
    });
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
  const productTableWidth = "1376px";
  const currentAdminRoles = currentAdmin?.adminRoles || [];
  const canManageUsers = hasRole(currentAdminRoles, "user_admin");
  const canManagePricing = canAccessAdminSection(currentAdminRoles, "pricelist");
  const canManageInventory = hasRole(currentAdminRoles, "inventory_admin");
  const canManageMembership = hasRole(currentAdminRoles, "membership_admin");
  const canManageDropSites = hasRole(currentAdminRoles, "dropsite_admin");
  const canManageMembers = hasRole(currentAdminRoles, "member_admin");
  const canManageCoreAdmin = currentAdminRoles.includes("admin");

  function getProductPrice(product) {
    const prices = (product.packages || [])
      .map((pkg) => Number(pkg.price))
      .filter((value) => Number.isFinite(value));
    if (!prices.length) return "N/A";
    return `$${Math.min(...prices).toFixed(2)}`;
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

  const normalizedProductNameSearch = productNameSearch.trim().toLowerCase();

  const productsMatchingOtherFilters = products.filter((product) => {
    const categoryMatch = !productCategoryFilter || String(product.categoryId) === productCategoryFilter;
    const vendorMatch = !productVendorFilter || String(product.vendorId) === productVendorFilter;
    const visibleMatch =
      productVisibleFilter === "all" ||
      (productVisibleFilter === "visible" && product.visible) ||
      (productVisibleFilter === "hidden" && !product.visible);
    const saleMatch =
      productSaleFilter === "all" ||
      (productSaleFilter === "onSale" && product.onSale) ||
      (productSaleFilter === "notOnSale" && !product.onSale);
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


  return (
    <div className="container admin-panel">
      <div className="admin-header">
        <h2 className="h2">Admin Dashboard</h2>
      </div>
      {message && <div className="small">{message}</div>}
      {loading && <div className="small">Loading...</div>}

      <div className="admin-layout">
        <aside className="admin-nav">
          {canManagePricing ? (
            <button
              className={`admin-nav-item ${activeSection === "pricelist" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("pricelist");
                setSelectedProductId(null);
              }}
              type="button"
            >
              Pricelist
            </button>
          ) : null}
          {canManageInventory ? (
            <button
              className={`admin-nav-item ${activeSection === "inventory" ? "active" : ""}`}
              onClick={() => {
                setActiveSection("inventory");
                setSelectedProductId(null);
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
                setSelectedProductId(null);
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
                onClick={() => setActiveSection("categories")}
                type="button"
              >
                Categories
              </button>
              <button
                className={`admin-nav-item ${activeSection === "vendors" ? "active" : ""}`}
                onClick={() => setActiveSection("vendors")}
                type="button"
              >
                Vendors
              </button>
              <button
                className={`admin-nav-item ${activeSection === "recipes" ? "active" : ""}`}
                onClick={() => setActiveSection("recipes")}
                type="button"
              >
                Recipes
              </button>
            </>
          ) : null}
          {canManageDropSites ? (
            <button
              className={`admin-nav-item ${activeSection === "dropSites" ? "active" : ""}`}
              onClick={() => setActiveSection("dropSites")}
              type="button"
            >
              Drop Sites
            </button>
          ) : null}
          {canManageMembers ? (
            <button
              className={`admin-nav-item ${activeSection === "reviews" ? "active" : ""}`}
              onClick={() => setActiveSection("reviews")}
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
                setSelectedProductId(null);
              }}
              type="button"
            >
              Users
            </button>
          ) : null}
        </aside>

        <div className="admin-content">
          {activeSection === "products" && !selectedProductId && (
            <section className="admin-section">
              <h3>Products</h3>
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
                            key={`product-suggestion-${product.id}`}
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
                  <span className="small">Category</span>
                  <select
                    className="input"
                    value={productCategoryFilter}
                    onChange={(event) => setProductCategoryFilter(event.target.value)}
                  >
                    <option value="">All categories</option>
                    {categories.map((category) => (
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
                    onChange={(event) => setProductVendorFilter(event.target.value)}
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
                  <span className="small">Visibility</span>
                  <select
                    className="input"
                    value={productVisibleFilter}
                    onChange={(event) => setProductVisibleFilter(event.target.value)}
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
                    onChange={(event) => setProductSaleFilter(event.target.value)}
                  >
                    <option value="all">All</option>
                    <option value="onSale">On sale only</option>
                    <option value="notOnSale">Not on sale</option>
                  </select>
                </label>
              </div>
              <div className="admin-actions">
                <button
                  className="button"
                  type="button"
                  onClick={handleApplyChanges}
                  disabled={applyLoading || pendingProductEditEntries.length === 0}
                >
                  {applyLoading ? "Applying..." : "Apply Changes"}
                </button>
                <button
                  className="button alt"
                  type="button"
                  disabled={applyLoading || pendingProductEditEntries.length === 0}
                  onClick={() => {
                    if (!window.confirm("Discard all pending changes? This cannot be undone.")) {
                      return;
                    }
                    setProductEdits({});
                    setMessage("Pending changes discarded.");
                  }}
                >
                  Cancel Changes
                </button>
              </div>
              <div className="admin-table-shell">
                <table
                  className="admin-table admin-table-head"
                  style={{ width: productTableWidth, minWidth: productTableWidth }}
                >
                  <colgroup>
                    <col style={{ width: "160px" }} />
                    <col style={{ width: "260px" }} />
                    <col style={{ width: "180px" }} />
                    <col style={{ width: "110px" }} />
                    <col style={{ width: "96px" }} />
                    <col style={{ width: "132px" }} />
                    <col style={{ width: "110px" }} />
                    <col style={{ width: "96px" }} />
                    <col style={{ width: "132px" }} />
                    <col style={{ width: "100px" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Name</th>
                      <th>Vendor</th>
                      <th>Price</th>
                      <th>Visible</th>
                      <th>Track Inventory</th>
                      <th>Stock</th>
                      <th>On Sale</th>
                      <th>Discount %</th>
                      <th></th>
                    </tr>
                  </thead>
                </table>
                <div className="admin-table-body-scroll">
                  <table
                    className="admin-table admin-table-body"
                    style={{ width: productTableWidth, minWidth: productTableWidth }}
                  >
                    <colgroup>
                      <col style={{ width: "160px" }} />
                      <col style={{ width: "260px" }} />
                      <col style={{ width: "180px" }} />
                      <col style={{ width: "110px" }} />
                      <col style={{ width: "96px" }} />
                      <col style={{ width: "132px" }} />
                      <col style={{ width: "110px" }} />
                      <col style={{ width: "96px" }} />
                      <col style={{ width: "132px" }} />
                      <col style={{ width: "100px" }} />
                    </colgroup>
                    <tbody>
                      {filteredProducts.map((product) => {
                        const defaults = getProductDefaults(product);
                        const edits = productEdits[product.id];
                        const rowValues = edits ? { ...defaults, ...edits } : defaults;
                        return (
                          <tr key={product.id} className={edits ? "edited" : ""}>
                            <td>{categoryMap.get(product.categoryId) || "Uncategorized"}</td>
                            <td>{product.name}</td>
                            <td>{vendorMap.get(product.vendorId) || "N/A"}</td>
                            <td>{getProductPrice(product)}</td>
                            <td>
                              <button
                                className={`toggle-switch ${rowValues.visible ? "active" : ""}`}
                                type="button"
                                onClick={() =>
                                  updateProductEdit(product.id, { visible: !rowValues.visible })
                                }
                              />
                            </td>
                            <td>
                              <button
                                className={`toggle-switch ${rowValues.trackInventory ? "active" : ""}`}
                                type="button"
                                onClick={() =>
                                  updateProductEdit(product.id, { trackInventory: !rowValues.trackInventory })
                                }
                              />
                            </td>
                            <td>
                              <input
                                className="stock-input"
                                type="number"
                                value={rowValues.inventory}
                                onChange={(event) =>
                                  updateProductEdit(product.id, { inventory: Number(event.target.value) })
                                }
                              />
                            </td>
                            <td>
                              <button
                                className={`toggle-switch ${rowValues.onSale ? "active" : ""}`}
                                type="button"
                                onClick={() =>
                                  updateProductEdit(product.id, { onSale: !rowValues.onSale })
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
                                    updateProductEdit(product.id, { saleDiscount: Number(event.target.value) })
                                  }
                                />
                                <span className="sale-discount-suffix">%</span>
                              </span>
                            </td>
                            <td>
                              <button
                                className="button alt"
                                type="button"
                                onClick={() => setSelectedProductId(product.id)}
                              >
                                Details
                              </button>
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

          {(activeSection === "products" || (activeSection === "pricelist" && canManagePricing)) &&
            selectedProductId &&
            activeProduct && (
            <section className="admin-section">
              <button className="button alt" type="button" onClick={() => setSelectedProductId(null)}>
                {activeSection === "pricelist" ? "Back to pricelist" : "Back to products"}
              </button>
              <h3>{activeProduct.name}</h3>
              {productDraft && (
                <div className="admin-fields">
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
                      onChange={(event) =>
                        setProductDraft((prev) => ({ ...prev, vendorId: event.target.value }))
                      }
                    >
                      <option value="">Select vendor</option>
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
                  <div className="admin-price-list">
                    <div className="small">Prices</div>
                    {(activeProduct.packages || []).map((pkg) => (
                      <label key={pkg.id} className="admin-row">
                        <span className="small">{pkg.name}</span>
                        <input
                          className="input"
                          defaultValue={pkg.price || ""}
                          onBlur={(event) => handlePackageUpdate(pkg.id, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="admin-price-list">
                    <div className="small">Local Line Price Lists</div>
                    {localLineProductDetail?.productMeta ? (
                      <div className="small">
                        Local Line product {localLineProductDetail.productMeta.localLineProductId} · Last synced{" "}
                        {localLineProductDetail.productMeta.lastSyncedAt || "n/a"}
                      </div>
                    ) : null}
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
                  </div>
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
                  <div className="admin-row">
                    <span className="small">On sale</span>
                    <button
                      className={`toggle-switch ${productDraft.onSale ? "active" : ""}`}
                      type="button"
                      onClick={() =>
                        setProductDraft((prev) => ({ ...prev, onSale: !prev.onSale }))
                      }
                    />
                  </div>
                  <label className="filter-field">
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
              <div className="admin-grid">
                {(activeProduct.images || []).map((image, index) => {
                  const entry = getImageEntry(image, index);
                  if (!entry.src) return null;
                  return (
                    <img
                      key={entry.key}
                      src={entry.thumbnailUrl || entry.src}
                      alt={activeProduct.name}
                      className="admin-thumb"
                    />
                  );
                })}
              </div>
              <div className="small">Upload image</div>
              <input type="file" onChange={(event) => event.target.files?.[0] && handleImageUpload(activeProduct.id, event.target.files[0])} />
              <button className="button" type="button" onClick={handleProductSave}>
                Save product
              </button>
            </section>
          )}

          {activeSection === "dropSites" && canManageDropSites && (
            <section className="admin-section">
              <h3>Drop Sites</h3>
              <div className="admin-grid">
                {dropSites.map((site) => (
                  <div key={site.id} className="card pad">
                    <strong>{site.name}</strong>
                    <div className="small">{site.dayOfWeek} {site.openTime} - {site.closeTime}</div>
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

          {activeSection === "pricelist" && canManagePricing && !selectedProductId && (
            <>
              <AdminPriceListSection
                token={token}
                categories={categories}
                vendors={vendors}
                onDataRefresh={loadAll}
                onCatalogRefresh={refreshCatalogFromAdmin}
                onReviewLocalLine={handleLocalLineAudit}
                reviewLocalLineLoading={localLineAuditState.loading}
                onPullFromLocalLine={handleLocalLineFullSync}
                pullFromLocalLineLoading={localLineCacheState.loading}
                pullFromLocalLineRunning={fullSyncRunning}
                onOpenProductDetails={(productId) => setSelectedProductId(productId)}
              />
              {localLineAuditState.open && (
                <div className="admin-inline-audit">
                  <div className="admin-inline-audit-header">
                    <h4>Review Local Line</h4>
                    <button className="button alt" type="button" onClick={closeLocalLineAuditPanel}>
                      Close
                    </button>
                  </div>
                  {renderLocalLineAuditContent()}
                </div>
              )}
              {localLineCacheState.open && (
                <div className="admin-inline-audit">
                  <div className="admin-inline-audit-header">
                    <h4>Pull From Local Line</h4>
                    <button className="button alt" type="button" onClick={closeLocalLineCachePanel}>
                      Close
                    </button>
                  </div>
                  {renderLocalLineCacheContent()}
                </div>
              )}
            </>
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
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((vendor) => (
                    <tr key={vendor.id}>
                      <td>{vendor.name}</td>
                    </tr>
                  ))}
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
