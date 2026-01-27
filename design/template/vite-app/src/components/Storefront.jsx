import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  accountPanel,
  brand,
  csaPlanTiles,
  delivery,
  dropSite,
  herdshare,
  hero,
  plans,
  productDetail,
  seasonalHighlights,
} from "../data";
import { fetchCatalog, fetchMe, userLogin } from "../api.js";
import { AccountPanelSection } from "./AccountPanelSection.jsx";
import { CsaPlansSection } from "./CsaPlansSection.jsx";
import { DeliverySection } from "./DeliverySection.jsx";
import { FooterSection } from "./FooterSection.jsx";
import { HerdshareBanner } from "./HerdshareBanner.jsx";
import { HeroSection } from "./HeroSection.jsx";
import { PlanChooser } from "./PlanChooser.jsx";
import { ProductDetailSection } from "./ProductDetailSection.jsx";
import { ProductGrid } from "./ProductGrid.jsx";
import { RecipesSection } from "./RecipesSection.jsx";
import { AdminPanel } from "./AdminPanel.jsx";
import { SeasonalHighlights } from "./SeasonalHighlights.jsx";

export function Storefront() {
  const [userToken, setUserToken] = useState(() => localStorage.getItem("userToken") || "");
  const [user, setUser] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginState, setLoginState] = useState({ email: "", password: "", error: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [view, setView] = useState("home");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedVendor, setSelectedVendor] = useState("");
  const [onSaleOnly, setOnSaleOnly] = useState(false);
  const [catalog, setCatalog] = useState({
    categories: [],
    vendors: [],
    products: [],
    recipes: [],
    dropSites: []
  });
  const [catalogError, setCatalogError] = useState("");
  const productGridRef = useRef(null);
  const categoryRef = useRef(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const isMember = Boolean(userToken);

  useEffect(() => {
    function syncView() {
      const hash = window.location.hash.replace("#/", "");
      if (hash === "admin") {
        setView("admin");
        return;
      }
      setView(hash === "account" ? "account" : "home");
    }

    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  useEffect(() => {
    fetchCatalog()
      .then((data) => {
        setCatalog({
          categories: data.categories || [],
          vendors: data.vendors || [],
          products: data.products || [],
          recipes: data.recipes || [],
          dropSites: data.dropSites || []
        });
        setSelectedCategory((current) => current || "");
      })
      .catch((err) => {
        console.error(err);
        setCatalogError("Unable to load catalog.");
      });
  }, []);

  useEffect(() => {
    if (!userToken) {
      setUser(null);
      return;
    }
    fetchMe(userToken)
      .then((data) => {
        setUser(data.user || null);
      })
      .catch(() => {
        localStorage.removeItem("userToken");
        setUserToken("");
        setUser(null);
      });
  }, [userToken]);

  const isAccountView = view === "account";
  const isAdminView = view === "admin";
  const activeCategory = catalog.categories.find(
    (category) => String(category.id) === String(selectedCategory)
  );
  const featuredProducts = useMemo(
    () => catalog.products.filter((product) => product.featured),
    [catalog.products]
  );
  const filteredProducts = useMemo(
    () =>
      catalog.products.filter((product) => {
        if (selectedCategory && String(product.categoryId) !== String(selectedCategory)) {
          return false;
        }
        if (selectedVendor && String(product.vendorId) !== String(selectedVendor)) {
          return false;
        }
        if (onSaleOnly && !product.onSale) {
          return false;
        }
        return true;
      }),
    [catalog.products, selectedCategory, selectedVendor, onSaleOnly]
  );

  const dropSiteData = useMemo(() => {
    const names = (catalog.dropSites || []).map((site) => site.name).filter(Boolean);
    return {
      defaultSite: names[0] || dropSite.defaultSite,
      options: names.length ? names : dropSite.options
    };
  }, [catalog.dropSites]);

  useEffect(() => {
    if (isMember && productGridRef.current) {
      productGridRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedCategory, isMember]);

  useEffect(() => {
    if (isMember && categoryRef.current) {
      categoryRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [isMember]);

  useEffect(() => {
    if (selectedProduct || selectedRecipe) {
      document.body.classList.add("modal-open");
      return () => document.body.classList.remove("modal-open");
    }
    document.body.classList.remove("modal-open");
  }, [selectedProduct, selectedRecipe]);

  useEffect(() => {
    setSelectedImageIndex(0);
  }, [selectedProduct]);

  function renderStars(rating) {
    const safeRating = Math.max(0, Math.min(5, rating || 0));
    return "*".repeat(safeRating) + "-".repeat(5 - safeRating);
  }

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
      const result = await userLogin(loginState.email, loginState.password);
      localStorage.setItem("userToken", result.token);
      setUserToken(result.token);
      setUser(result.user || null);
      setLoginOpen(false);
      setLoginState({ email: "", password: "", error: "" });
    } catch (err) {
      setLoginState((prev) => ({ ...prev, error: "Invalid login" }));
    }
  }

  function handleLogout() {
    localStorage.removeItem("userToken");
    setUserToken("");
    setUser(null);
  }

  return (
    <div className="page">
      <main>
        <div className="utility-bar">
          <div className="brand">
            <img src="/images/full-farm-csa-logo.png" alt={brand} />
            <span className="brand-title">Full Farm CSA</span>
          </div>
          <div className="utility-actions">
            {isMember &&
              (isAccountView ? (
                <a className="button alt" href="#/home">
                  Back to shop
                </a>
              ) : (
                <>
                  <a className="button alt" href="#/account">
                    Member settings
                  </a>
                  <button className="button alt" type="button">
                    Cart (2)
                  </button>
                </>
              ))}
            <button
              className="button"
              type="button"
              onClick={() => (isMember ? handleLogout() : setLoginOpen(true))}
            >
              {isMember ? "Log out" : "Log in"}
            </button>
          </div>
        </div>
        {isAdminView ? (
          <AdminPanel />
        ) : isAccountView ? (
          <AccountPanelSection accountPanel={accountPanel} dropSite={dropSite} />
        ) : (
          <>
            {!isMember && <HeroSection hero={hero} showEyebrow={!isMember} showCard={!isMember} />}
            {isMember ? (
              <div ref={categoryRef}>
                <section className="section tight" id="shop">
                  <div className="container shop-layout">
                    <aside className="shop-filters">
                      <div className="eyebrow">Shop by pantry</div>
                      <h2 className="h2">Filters</h2>
                      <div className="filters vertical">
                        <label className="filter-field">
                          <span className="small">Category</span>
                          <select
                            className="select"
                            value={selectedCategory}
                            onChange={(event) => setSelectedCategory(event.target.value)}
                          >
                            <option value="">All categories</option>
                            {catalog.categories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="filter-field">
                          <span className="small">Vendor</span>
                          <select
                            className="select"
                            value={selectedVendor}
                            onChange={(event) => setSelectedVendor(event.target.value)}
                          >
                            <option value="">All vendors</option>
                            {catalog.vendors.map((vendor) => (
                              <option key={vendor.id} value={vendor.id}>
                                {vendor.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="filter-toggle">
                          <input
                            type="checkbox"
                            checked={onSaleOnly}
                            onChange={(event) => setOnSaleOnly(event.target.checked)}
                          />
                          <span>On sale</span>
                        </label>
                      </div>
                    </aside>
                    <div className="shop-main">
                      {catalogError && <div className="card pad">{catalogError}</div>}
                      <ProductGrid
                        products={filteredProducts}
                        showCartAction
                        onSelect={(product) => setSelectedProduct(product)}
                        filterLabel={activeCategory ? activeCategory.name : "All"}
                        sectionRef={productGridRef}
                        eyebrow="Catalog"
                        title="All products in this category."
                        embedded
                      />
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <PlanChooser plans={plans} />
            )}
            {isMember ? (
              <>
                <ProductGrid
                  products={featuredProducts}
                  showCartAction
                  onSelect={(product) => setSelectedProduct(product)}
                />
                <ProductDetailSection productDetail={productDetail} />
                <RecipesSection
                  recipes={catalog.recipes}
                  onSelect={(recipe) => setSelectedRecipe(recipe)}
                />
              </>
            ) : (
              <>
                <CsaPlansSection csaPlanTiles={csaPlanTiles} />
                <SeasonalHighlights seasonalHighlights={seasonalHighlights} />
                {catalogError && <div className="card pad">{catalogError}</div>}
                <ProductGrid
                  products={featuredProducts}
                  onSelect={(product) => setSelectedProduct(product)}
                />
                <HerdshareBanner herdshare={herdshare} />
                <DeliverySection delivery={delivery} dropSite={dropSiteData} />
                <ProductDetailSection productDetail={productDetail} />
                <RecipesSection
                  recipes={catalog.recipes}
                  onSelect={(recipe) => setSelectedRecipe(recipe)}
                />
              </>
            )}
          </>
        )}
      </main>

      {loginOpen && (
        <div className="modal-backdrop" onClick={() => setLoginOpen(false)}>
          <div className="modal modal-small" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setLoginOpen(false)}>
              Close
            </button>
            <div className="modal-body single">
              <div>
                <div className="eyebrow">Member access</div>
                <h2 className="h2">Log in</h2>
                <form className="admin-form" onSubmit={handleLogin}>
                  <input
                    className="input"
                    placeholder="Email"
                    value={loginState.email}
                    onChange={(event) =>
                      setLoginState((prev) => ({ ...prev, email: event.target.value }))
                    }
                  />
                  <input
                    className="input"
                    placeholder="Password"
                    type={showPassword ? "text" : "password"}
                    value={loginState.password}
                    onChange={(event) =>
                      setLoginState((prev) => ({ ...prev, password: event.target.value }))
                    }
                  />
                  <label className="filter-toggle">
                    <input
                      type="checkbox"
                      checked={showPassword}
                      onChange={(event) => setShowPassword(event.target.checked)}
                    />
                    <span>Show password</span>
                  </label>
                  {loginState.error && <div className="small">{loginState.error}</div>}
                  <button className="button" type="submit">
                    Sign in
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      <FooterSection brand={brand} />

      {selectedProduct && (
        <div className="modal-backdrop" onClick={() => setSelectedProduct(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              onClick={() => setSelectedProduct(null)}
            >
              Close
            </button>
            <div className="modal-body">
              <div className="modal-image">
                <img
                  src={
                    (selectedProduct.images && selectedProduct.images[selectedImageIndex]) ||
                    selectedProduct.imageUrl ||
                    selectedProduct.image
                  }
                  alt={selectedProduct.name}
                />
                {selectedProduct.images && selectedProduct.images.length > 1 && (
                  <div className="modal-thumbs">
                    {selectedProduct.images.map((image, index) => (
                      <button
                        key={image}
                        className={`thumb ${index === selectedImageIndex ? "active" : ""}`}
                        type="button"
                        onClick={() => setSelectedImageIndex(index)}
                      >
                        <img src={image} alt={`${selectedProduct.name} ${index + 1}`} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="eyebrow">Product detail</div>
                <h2 className="h2">{selectedProduct.name}</h2>
                <div className="price">
                  {selectedProduct.price ? `$${selectedProduct.price}` : "Price TBD"}
                </div>
                {selectedProduct.reviews && selectedProduct.reviews.length > 0 && (
                  <div className="small">
                    {renderStars(selectedProduct.rating)} {selectedProduct.rating || 0}/5
                  </div>
                )}
                {selectedProduct.description ? (
                  <div
                    className="lede product-description"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeHtml(selectedProduct.description)
                    }}
                  />
                ) : (
                  <p className="lede">Description coming soon.</p>
                )}
                <div className="review-block">
                  <strong>Reviews</strong>
                  {selectedProduct.reviews && selectedProduct.reviews.length > 0 ? (
                    selectedProduct.reviews.map((review) => (
                      <div key={review.quote} className="review">
                        <div className="small">
                          {review.rating} "{review.quote}"
                        </div>
                        <div className="small">- {review.author}</div>
                      </div>
                    ))
                  ) : (
                    <div className="small">No reviews yet.</div>
                  )}
                </div>
                <div className="button-row">
                  <button className="button" type="button">
                    Add to cart
                  </button>
                  <button className="button alt" type="button">
                    Save for recurring
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedRecipe && (
        <div className="modal-backdrop" onClick={() => setSelectedRecipe(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setSelectedRecipe(null)}>
              Close
            </button>
            <div className="modal-body">
              <div className="modal-image">
                <img
                  src={selectedRecipe.imageUrl || selectedRecipe.image}
                  alt={selectedRecipe.title}
                />
              </div>
              <div>
                <div className="eyebrow">Recipe</div>
                <h2 className="h2">{selectedRecipe.title}</h2>
                <p className="lede">{selectedRecipe.note}</p>
                <div className="recipe-detail">
                  <strong>Ingredients</strong>
                  <ul>
                    {(selectedRecipe.ingredients || []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="recipe-detail">
                  <strong>Steps</strong>
                  <ol>
                    {(selectedRecipe.steps || []).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
