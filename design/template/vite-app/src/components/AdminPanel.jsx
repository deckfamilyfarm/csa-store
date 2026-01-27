import React, { useEffect, useRef, useState } from "react";
import {
  adminGet,
  adminLogin,
  adminPost,
  adminPut,
  adminUploadImage
} from "../adminApi.js";

export function AdminPanel() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [loginState, setLoginState] = useState({ username: "", password: "", error: "" });
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState("products");
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
  const [productCategoryFilter, setProductCategoryFilter] = useState("");
  const [productVendorFilter, setProductVendorFilter] = useState("");
  const [productVisibleFilter, setProductVisibleFilter] = useState("visible");
  const [productEdits, setProductEdits] = useState({});
  const [applyState, setApplyState] = useState({ open: false, updates: [], results: [], error: "" });
  const [applyLoading, setApplyLoading] = useState(false);
  const activeProduct = products.find((product) => product.id === selectedProductId);
  const descriptionRef = useRef(null);

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

  useEffect(() => {
    if (token) {
      localStorage.setItem("adminToken", token);
      loadAll();
    }
  }, [token]);

  useEffect(() => {
    if (activeProduct) {
      setProductDraft({
        name: activeProduct.name || "",
        description: sanitizeHtml(activeProduct.description || ""),
        vendorId: activeProduct.vendorId ? String(activeProduct.vendorId) : "",
        categoryId: activeProduct.categoryId ? String(activeProduct.categoryId) : "",
        visible: Boolean(activeProduct.visible)
      });
    } else {
      setProductDraft(null);
    }
  }, [activeProduct]);

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
      setToken(result.token);
    } catch (err) {
      setLoginState((prev) => ({ ...prev, error: "Invalid credentials" }));
    }
  }

  async function handleProductUpdate(productId, field, value) {
    setMessage("");
    try {
      await adminPut(`products/${productId}`, token, { [field]: value });
      setMessage("Product updated.");
      await loadAll();
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
      setMessage("Product updated.");
      await loadAll();
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
    } catch (err) {
      setMessage("Image upload failed.");
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
    const editEntries = Object.entries(productEdits);
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

  if (!token) {
    return (
      <div className="container admin-panel">
        <h2 className="h2">Admin Login</h2>
        <form className="admin-form" onSubmit={handleLogin}>
          <input
            className="input"
            placeholder="Admin email"
            value={loginState.username}
            onChange={(event) => setLoginState((prev) => ({ ...prev, username: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Password"
            type="password"
            value={loginState.password}
            onChange={(event) => setLoginState((prev) => ({ ...prev, password: event.target.value }))}
          />
          {loginState.error && <div className="small">{loginState.error}</div>}
          <button className="button" type="submit">
            Sign in
          </button>
        </form>
      </div>
    );
  }

  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
  const productMap = new Map(products.map((product) => [product.id, product]));

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

  function updateProductEdit(productId, patch) {
    const product = productMap.get(productId);
    if (!product) return;
    const defaults = getProductDefaults(product);
    setProductEdits((prev) => {
      const next = { ...prev };
      const current = next[productId] ? { ...defaults, ...next[productId] } : { ...defaults };
      const updated = { ...current, ...patch };
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

  const filteredProducts = products.filter((product) => {
    const categoryMatch = !productCategoryFilter || String(product.categoryId) === productCategoryFilter;
    const vendorMatch = !productVendorFilter || String(product.vendorId) === productVendorFilter;
    const visibleMatch =
      productVisibleFilter === "all" ||
      (productVisibleFilter === "visible" && product.visible) ||
      (productVisibleFilter === "hidden" && !product.visible);
    return categoryMatch && vendorMatch && visibleMatch;
  });

  return (
    <div className="container admin-panel">
      <div className="admin-header">
        <h2 className="h2">Admin Dashboard</h2>
      </div>
      {message && <div className="small">{message}</div>}
      {loading && <div className="small">Loading...</div>}

      <div className="admin-layout">
        <aside className="admin-nav">
          <button
            className={`admin-nav-item ${activeSection === "products" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("products");
              setSelectedProductId(null);
            }}
            type="button"
          >
            Products
          </button>
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
            className={`admin-nav-item ${activeSection === "dropSites" ? "active" : ""}`}
            onClick={() => setActiveSection("dropSites")}
            type="button"
          >
            Drop Sites
          </button>
          <button
            className={`admin-nav-item ${activeSection === "recipes" ? "active" : ""}`}
            onClick={() => setActiveSection("recipes")}
            type="button"
          >
            Recipes
          </button>
          <button
            className={`admin-nav-item ${activeSection === "reviews" ? "active" : ""}`}
            onClick={() => setActiveSection("reviews")}
            type="button"
          >
            Reviews
          </button>
        </aside>

        <div className="admin-content">
          {activeSection === "products" && !selectedProductId && (
            <section className="admin-section">
              <h3>Products</h3>
              <div className="filters">
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
                    {vendors.map((vendor) => (
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
              </div>
              <div className="admin-actions">
                <button
                  className="button"
                  type="button"
                  onClick={handleApplyChanges}
                  disabled={applyLoading || Object.keys(productEdits).length === 0}
                >
                  {applyLoading ? "Applying..." : "Apply Changes"}
                </button>
              </div>
              <table className="admin-table">
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
            </section>
          )}

          {activeSection === "products" && selectedProductId && activeProduct && (
            <section className="admin-section">
              <button className="button alt" type="button" onClick={() => setSelectedProductId(null)}>
                Back to products
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
                      {vendors.map((vendor) => (
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
                {(activeProduct.images || []).map((url) => (
                  <img key={url} src={url} alt={activeProduct.name} className="admin-thumb" />
                ))}
              </div>
              <div className="small">Upload image</div>
              <input type="file" onChange={(event) => event.target.files?.[0] && handleImageUpload(activeProduct.id, event.target.files[0])} />
              <button className="button" type="button" onClick={handleProductSave}>
                Save product
              </button>
            </section>
          )}

          {activeSection === "dropSites" && (
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

          {activeSection === "categories" && (
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

          {activeSection === "vendors" && (
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

          {activeSection === "recipes" && (
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

          {activeSection === "reviews" && (
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
