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
import {
  deleteReview,
  fetchCatalog,
  fetchMe,
  fetchMyReviews,
  requestPasswordReset,
  resetPasswordWithToken,
  submitReview,
  updateReview,
  userLogin
} from "../api.js";
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
  const [loginState, setLoginState] = useState({ username: "", password: "", error: "" });
  const [loginMode, setLoginMode] = useState("login");
  const [forgotState, setForgotState] = useState({
    username: "",
    message: "",
    error: "",
    submitting: false
  });
  const [resetToken, setResetToken] = useState("");
  const [resetState, setResetState] = useState({
    password: "",
    confirm: "",
    message: "",
    error: "",
    submitting: false
  });
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
  const isAdmin = user?.role === "administrator" || user?.role === "admin";
  const priceTier = isAdmin || user?.role === "member" ? "member" : "guest";
  const [reviewForm, setReviewForm] = useState({ rating: "5", title: "", body: "" });
  const [reviewStatus, setReviewStatus] = useState({ message: "", error: "" });
  const [userReviews, setUserReviews] = useState([]);
  const [editingReviewId, setEditingReviewId] = useState(null);

  async function reloadCatalog() {
    const data = await fetchCatalog();
    setCatalog({
      categories: data.categories || [],
      vendors: data.vendors || [],
      products: data.products || [],
      recipes: data.recipes || [],
      dropSites: data.dropSites || []
    });
    setCatalogError("");
    setSelectedCategory((current) => current || "");
  }

  function getHashRoute() {
    const raw = window.location.hash.replace(/^#\/?/, "").trim();
    if (!raw) return null;
    const route = raw.split("?")[0];
    if (route === "admin" || route === "account" || route === "home" || route === "reset-password") {
      return route;
    }
    return null;
  }

  useEffect(() => {
    function syncView() {
      const route = getHashRoute();
      if (route === "admin") {
        setView("admin");
        return;
      }
      if (route === "reset-password") {
        const query = window.location.hash.split("?")[1] || "";
        const params = new URLSearchParams(query);
        setResetToken(params.get("token") || "");
        setView("resetPassword");
        return;
      }
      setView(route === "account" ? "account" : "home");
    }

    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  useEffect(() => {
    reloadCatalog()
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
        const role = data.user?.role;
        const route = getHashRoute();
        if (role === "administrator" || role === "admin") {
          localStorage.setItem("adminToken", userToken);
          if (!route) {
            window.location.hash = "#/admin";
          }
        } else if (!route) {
          window.location.hash = "#/home";
        }
      })
      .catch(() => {
        localStorage.removeItem("userToken");
        setUserToken("");
        setUser(null);
      });
  }, [userToken]);

  const isAccountView = view === "account";
  const isAdminView = view === "admin";
  const isResetPasswordView = view === "resetPassword";
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
  const sortedVendors = useMemo(
    () =>
      (catalog.vendors || [])
        .slice()
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""))),
    [catalog.vendors]
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

  useEffect(() => {
    setReviewForm({ rating: "5", title: "", body: "" });
    setReviewStatus({ message: "", error: "" });
    setEditingReviewId(null);
  }, [selectedProduct?.id]);

  useEffect(() => {
    if (!selectedProduct || !userToken) {
      setUserReviews([]);
      return;
    }
    fetchMyReviews(selectedProduct.id, userToken)
      .then((data) => {
        const reviews = data.reviews || [];
        setUserReviews(reviews);
        if (reviews.length && !editingReviewId) {
          const review = reviews[0];
          setEditingReviewId(review.id);
          setReviewForm({
            rating: String(review.rating || 5),
            title: review.title || "",
            body: review.body || ""
          });
        }
      })
      .catch(() => setUserReviews([]));
  }, [selectedProduct?.id, userToken]);

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

  function getDisplayPrice(product) {
    if (!product) return null;
    const memberPrice =
      product.memberPrice ?? product.guestPrice ?? product.basePrice ?? product.price;
    const guestPrice = product.guestPrice ?? product.basePrice ?? product.price;
    const raw = priceTier === "member" ? memberPrice : guestPrice;
    if (raw === null || raw === undefined) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num.toFixed(2) : null;
  }

  async function handleReviewSubmit(event) {
    event.preventDefault();
    if (!selectedProduct) return;
    setReviewStatus({ message: "", error: "" });
    try {
      if (editingReviewId) {
        await updateReview(
          editingReviewId,
          {
            rating: Number(reviewForm.rating),
            title: reviewForm.title,
            body: reviewForm.body
          },
          userToken
        );
        setReviewStatus({ message: "Review updated. Pending approval.", error: "" });
      } else {
        await submitReview(
          {
            productId: selectedProduct.id,
            rating: Number(reviewForm.rating),
            title: reviewForm.title,
            body: reviewForm.body
          },
          userToken
        );
        setReviewStatus({ message: "Thanks! Your review is pending approval.", error: "" });
      }
      setReviewForm({ rating: "5", title: "", body: "" });
      setEditingReviewId(null);
      const data = await fetchMyReviews(selectedProduct.id, userToken);
      setUserReviews(data.reviews || []);
    } catch (err) {
      setReviewStatus({ message: "", error: err.message || "Unable to submit review." });
    }
  }

  function startEditReview(review) {
    setEditingReviewId(review.id);
    setReviewForm({
      rating: String(review.rating || 5),
      title: review.title || "",
      body: review.body || ""
    });
  }

  async function handleDeleteReview(reviewId) {
    try {
      await deleteReview(reviewId, userToken);
      const data = await fetchMyReviews(selectedProduct.id, userToken);
      setUserReviews(data.reviews || []);
    } catch (err) {
      setReviewStatus({ message: "", error: err.message || "Unable to delete review." });
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginState((prev) => ({ ...prev, error: "" }));
    try {
      const result = await userLogin(loginState.username, loginState.password);
      localStorage.setItem("userToken", result.token);
      setUserToken(result.token);
      setUser(result.user || null);
      setLoginOpen(false);
      setLoginState({ username: "", password: "", error: "" });
      const role = result.user?.role;
      if (role === "administrator" || role === "admin") {
        localStorage.setItem("adminToken", result.token);
        window.location.hash = "#/admin";
      } else {
        window.location.hash = "#/home";
      }
    } catch (err) {
      setLoginState((prev) => ({ ...prev, error: "Invalid login" }));
    }
  }

  async function handleForgotPassword(event) {
    event.preventDefault();
    setForgotState((prev) => ({ ...prev, submitting: true, error: "", message: "" }));
    try {
      await requestPasswordReset(forgotState.username || loginState.username);
      setForgotState((prev) => ({
        ...prev,
        submitting: false,
        message: "If that username matches an active user with a reset email, a reset email has been sent."
      }));
    } catch (err) {
      setForgotState((prev) => ({
        ...prev,
        submitting: false,
        error: err?.message || "Unable to request password reset."
      }));
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    if (resetState.password !== resetState.confirm) {
      setResetState((prev) => ({ ...prev, error: "Passwords do not match.", message: "" }));
      return;
    }
    setResetState((prev) => ({ ...prev, submitting: true, error: "", message: "" }));
    try {
      await resetPasswordWithToken(resetToken, resetState.password);
      setResetState({
        password: "",
        confirm: "",
        submitting: false,
        error: "",
        message: "Password set. You can sign in now."
      });
      setLoginMode("login");
      setLoginOpen(true);
    } catch (err) {
      setResetState((prev) => ({
        ...prev,
        submitting: false,
        error: err?.message || "Unable to reset password."
      }));
    }
  }

  function handleLogout() {
    localStorage.removeItem("userToken");
    localStorage.removeItem("adminToken");
    setUserToken("");
    setUser(null);
    window.location.hash = "#/home";
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
          <AdminPanel onCatalogRefresh={reloadCatalog} />
        ) : isResetPasswordView ? (
          <section className="section tight">
            <div className="container reset-password-panel">
              <div className="eyebrow">Account access</div>
              <h2 className="h2">Set Password</h2>
              <form className="admin-form" onSubmit={handleResetPassword}>
                <input
                  className="input"
                  placeholder="New password"
                  type="password"
                  value={resetState.password}
                  onChange={(event) =>
                    setResetState((prev) => ({ ...prev, password: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="Confirm password"
                  type="password"
                  value={resetState.confirm}
                  onChange={(event) =>
                    setResetState((prev) => ({ ...prev, confirm: event.target.value }))
                  }
                />
                {resetState.error ? <div className="small">{resetState.error}</div> : null}
                {resetState.message ? <div className="small">{resetState.message}</div> : null}
                <button className="button" type="submit" disabled={resetState.submitting || !resetToken}>
                  {resetState.submitting ? "Setting..." : "Set password"}
                </button>
              </form>
            </div>
          </section>
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
                            {sortedVendors.map((vendor) => (
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
                        getPrice={getDisplayPrice}
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
                  getPrice={getDisplayPrice}
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
                  getPrice={getDisplayPrice}
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
                {loginMode === "forgot" ? (
                  <>
                    <h2 className="h2">Reset password</h2>
                    <form className="admin-form" onSubmit={handleForgotPassword}>
                      <input
                        className="input"
                        placeholder="Username"
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
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => setLoginMode("login")}
                      >
                        Back to sign in
                      </button>
                    </form>
                  </>
                ) : (
                  <>
                    <h2 className="h2">Log in</h2>
                    <form className="admin-form" onSubmit={handleLogin}>
                      <input
                        className="input"
                        placeholder="Username"
                        value={loginState.username}
                        onChange={(event) =>
                          setLoginState((prev) => ({ ...prev, username: event.target.value }))
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
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => {
                          setForgotState((prev) => ({
                            ...prev,
                            username: prev.username || loginState.username
                          }));
                          setLoginMode("forgot");
                        }}
                      >
                        Forgot password
                      </button>
                    </form>
                  </>
                )}
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
                {(() => {
                  const imageItems = (selectedProduct.images || []).map((item) =>
                    typeof item === "string" ? { url: item, thumbnailUrl: item } : item
                  );
                  const activeImage = imageItems[selectedImageIndex] || {};
                  const mainUrl =
                    activeImage.url || selectedProduct.imageUrl || selectedProduct.image;
                  return (
                    <>
                      <img src={mainUrl} alt={selectedProduct.name} />
                      {imageItems.length > 1 && (
                        <div className="modal-thumbs">
                          {imageItems.map((image, index) => (
                            <button
                              key={image.url || image.thumbnailUrl || index}
                              className={`thumb ${index === selectedImageIndex ? "active" : ""}`}
                              type="button"
                              onClick={() => setSelectedImageIndex(index)}
                            >
                              <img
                                src={image.thumbnailUrl || image.url}
                                alt={`${selectedProduct.name} ${index + 1}`}
                              />
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              <div>
                <div className="eyebrow">Product detail</div>
                <h2 className="h2">{selectedProduct.name}</h2>
                <div className="price">
                  {getDisplayPrice(selectedProduct) ? `$${getDisplayPrice(selectedProduct)}` : "Price TBD"}
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
                      <div key={review.id || review.createdAt || review.title} className="review">
                        <div className="small">
                          {review.rating} {review.title ? `"${review.title}"` : ""}
                        </div>
                        {review.body && <div className="small">{review.body}</div>}
                      </div>
                    ))
                  ) : (
                    <div className="small">No reviews yet.</div>
                  )}
                  {isMember ? (
                    <>
                      {userReviews.length > 0 && (
                        <div className="review-own">
                          <div className="small">Your reviews</div>
                          {userReviews.map((review) => (
                            <div key={review.id} className="review-own-item">
                              <div className="small">
                                {review.rating}★ {review.title || "Review"} · {review.status}
                              </div>
                              {review.body && <div className="small">{review.body}</div>}
                              <div className="review-actions">
                                <button
                                  className="button alt"
                                  type="button"
                                  onClick={() => startEditReview(review)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="button alt"
                                  type="button"
                                  onClick={() => handleDeleteReview(review.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <form className="review-form" onSubmit={handleReviewSubmit}>
                        <div className="small">
                          {editingReviewId ? "Edit your review" : "Add your review"}
                        </div>
                        <div className="review-grid">
                          <label className="filter-field">
                            <span className="small">Rating</span>
                            <select
                              className="select"
                              value={reviewForm.rating}
                              onChange={(event) =>
                                setReviewForm((prev) => ({ ...prev, rating: event.target.value }))
                              }
                            >
                              {[5, 4, 3, 2, 1].map((value) => (
                                <option key={value} value={value}>
                                  {value} stars
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="filter-field">
                            <span className="small">Title</span>
                            <input
                              className="input"
                              value={reviewForm.title}
                              onChange={(event) =>
                                setReviewForm((prev) => ({ ...prev, title: event.target.value }))
                              }
                            />
                          </label>
                        </div>
                        <label className="filter-field">
                          <span className="small">Review</span>
                          <textarea
                            className="textarea"
                            value={reviewForm.body}
                            onChange={(event) =>
                              setReviewForm((prev) => ({ ...prev, body: event.target.value }))
                            }
                          />
                        </label>
                        {reviewStatus.error && <div className="small">{reviewStatus.error}</div>}
                        {reviewStatus.message && <div className="small">{reviewStatus.message}</div>}
                        <div className="button-row">
                          {editingReviewId && (
                            <button
                              className="button alt"
                              type="button"
                              onClick={() => {
                                setEditingReviewId(null);
                                setReviewForm({ rating: "5", title: "", body: "" });
                              }}
                            >
                              Cancel
                            </button>
                          )}
                          <button className="button alt" type="submit">
                            {editingReviewId ? "Update review" : "Submit review"}
                          </button>
                        </div>
                      </form>
                    </>
                  ) : (
                    <div className="small">Log in to leave a review.</div>
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
