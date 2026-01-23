import React, { useEffect, useRef, useState } from "react";
import {
  accountPanel,
  brand,
  categories,
  csaPlanTiles,
  delivery,
  dropSite,
  herdshare,
  hero,
  plans,
  productDetail,
  products,
  recipes,
  seasonalHighlights,
} from "../data";
import { AccountPanelSection } from "./AccountPanelSection.jsx";
import { CsaPlansSection } from "./CsaPlansSection.jsx";
import { DeliverySection } from "./DeliverySection.jsx";
import { FooterSection } from "./FooterSection.jsx";
import { HerdshareBanner } from "./HerdshareBanner.jsx";
import { HeroSection } from "./HeroSection.jsx";
import { PantryCategories } from "./PantryCategories.jsx";
import { PlanChooser } from "./PlanChooser.jsx";
import { ProductDetailSection } from "./ProductDetailSection.jsx";
import { ProductGrid } from "./ProductGrid.jsx";
import { RecipesSection } from "./RecipesSection.jsx";
import { SeasonalHighlights } from "./SeasonalHighlights.jsx";

export function Storefront() {
  const [isMember, setIsMember] = useState(false);
  const [view, setView] = useState("home");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const productGridRef = useRef(null);

  useEffect(() => {
    function syncView() {
      const hash = window.location.hash.replace("#/", "");
      setView(hash === "account" ? "account" : "home");
    }

    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  const isAccountView = view === "account";
  const activeCategory = categories.find((category) => category.key === selectedCategory);
  const featuredProducts = products.filter((product) => product.featured);
  const filteredProducts =
    selectedCategory === "all"
      ? products
      : products.filter((product) => product.category === selectedCategory);

  useEffect(() => {
    if (isMember && productGridRef.current) {
      productGridRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedCategory, isMember]);

  function renderStars(rating) {
    const safeRating = Math.max(0, Math.min(5, rating || 0));
    return "*".repeat(safeRating) + "-".repeat(5 - safeRating);
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
            <button className="button" type="button" onClick={() => setIsMember(!isMember)}>
              {isMember ? "Log out" : "Log in"}
            </button>
          </div>
        </div>
        {isAccountView ? (
          <AccountPanelSection accountPanel={accountPanel} dropSite={dropSite} />
        ) : (
          <>
            {!isMember && <HeroSection hero={hero} showEyebrow={!isMember} showCard={!isMember} />}
            {isMember ? (
              <PantryCategories
                categories={categories}
                selectedKey={selectedCategory}
                onSelect={(key) => setSelectedCategory(key)}
              />
            ) : (
              <PlanChooser plans={plans} />
            )}
            {isMember ? (
              <>
                <ProductGrid
                  products={filteredProducts}
                  showCartAction
                  onSelect={(product) => setSelectedProduct(product)}
                  filterLabel={activeCategory ? activeCategory.title : "All"}
                  sectionRef={productGridRef}
                  eyebrow="Catalog"
                  title="All products in this category."
                />
                <ProductGrid
                  products={featuredProducts}
                  showCartAction
                  onSelect={(product) => setSelectedProduct(product)}
                />
                <ProductDetailSection productDetail={productDetail} />
                <RecipesSection recipes={recipes} onSelect={(recipe) => setSelectedRecipe(recipe)} />
              </>
            ) : (
              <>
                <CsaPlansSection csaPlanTiles={csaPlanTiles} />
                <SeasonalHighlights seasonalHighlights={seasonalHighlights} />
                <ProductGrid
                  products={featuredProducts}
                  onSelect={(product) => setSelectedProduct(product)}
                />
                <HerdshareBanner herdshare={herdshare} />
                <DeliverySection delivery={delivery} dropSite={dropSite} />
                <ProductDetailSection productDetail={productDetail} />
                <RecipesSection recipes={recipes} onSelect={(recipe) => setSelectedRecipe(recipe)} />
              </>
            )}
          </>
        )}
      </main>

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
                <img src={selectedProduct.image} alt={selectedProduct.name} />
              </div>
              <div>
                <div className="eyebrow">Product detail</div>
                <h2 className="h2">{selectedProduct.name}</h2>
                <div className="price">{selectedProduct.price}</div>
                <div className="small">
                  {renderStars(selectedProduct.rating)} {selectedProduct.rating || 0}/5
                </div>
                <p className="lede">{selectedProduct.description}</p>
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
                <img src={selectedRecipe.image} alt={selectedRecipe.title} />
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
