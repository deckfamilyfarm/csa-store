import React, { useEffect, useMemo, useState } from "react";
import { DeckPageHeader } from "./DeckPageHeader.jsx";
import { SubscribeFooter } from "./SubscribeFooter.jsx";

const DEFAULT_PRODUCT_IMAGE = "/images/subscribe-products.jpg";

function cleanText(value, maxLength = 128) {
  const text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function searchableProductText(product) {
  return [product?.name, product?.category, product?.vendor, product?.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesTerms(product, terms) {
  const text = searchableProductText(product);
  return terms.some((term) => text.includes(term));
}

function normalizeCategoryName(value) {
  return cleanText(value, 255).toLowerCase();
}

function categoryMatchesProduct(category, product) {
  if (String(product?.categoryId || "") === String(category?.id || "")) return true;
  if (!product?.category || !category?.name) return false;
  return normalizeCategoryName(product.category) === normalizeCategoryName(category.name);
}

function buildVisitorLiabilityReleaseUrl() {
  if (typeof window === "undefined") return "/liability/visitor";
  try {
    const url = new URL(window.location.origin);
    url.pathname = "/liability/visitor";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_error) {
    return "/liability/visitor";
  }
}

function productImage(product, fallback = DEFAULT_PRODUCT_IMAGE) {
  return (
    product?.thumbnailUrl ||
    product?.imageUrl ||
    product?.images?.find((image) => image?.thumbnailUrl)?.thumbnailUrl ||
    product?.images?.find((image) => image?.url)?.url ||
    fallback
  );
}

function displayPrice(product, getPrice) {
  const raw = getPrice ? getPrice(product) : product?.price;
  if (raw === null || raw === undefined || raw === "") return "Seasonal";
  const number = Number(raw);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : String(raw);
}

function uniqueProducts(products) {
  const seen = new Set();
  return products.filter((product) => {
    const key = String(product?.id || product?.name || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function useActiveGroup(groups) {
  const [activeGroupId, setActiveGroupId] = useState("");

  useEffect(() => {
    if (!groups.length) {
      setActiveGroupId("");
      return;
    }
    setActiveGroupId((current) =>
      current && groups.some((group) => group.id === current) ? current : groups[0].id
    );
  }, [groups]);

  const activeGroup = groups.find((group) => group.id === activeGroupId) || groups[0] || null;
  return [activeGroup, setActiveGroupId];
}

export function HomeLandingPage({
  catalog,
  catalogError = "",
  getPrice,
  onSelectProduct,
  isLoggedIn = false,
  isAdmin = false,
  onAuthAction = null,
  subscribeUrl = "#/subscribe"
}) {
  const products = useMemo(
    () => uniqueProducts((catalog?.products || []).filter((product) => product?.name)),
    [catalog?.products]
  );

  const featuredProducts = useMemo(() => {
    const featured = products.filter((product) => product.featured);
    return (featured.length ? featured : products).slice(0, 10);
  }, [products]);

  const groups = useMemo(() => {
    const categoryGroups = (catalog?.categories || []).map((category) => {
      const groupProducts = products.filter((product) => categoryMatchesProduct(category, product));
      const name = cleanText(category.name, 80);
      return {
        id: `category-${category.id}`,
        categoryId: category.id,
        title: name,
        shortTitle: name,
        description: `${name} from the current store catalog.`,
        count: groupProducts.length,
        products: groupProducts.slice(0, 8)
      };
    });
    categoryGroups.sort((left, right) => {
      if (left.count && !right.count) return -1;
      if (!left.count && right.count) return 1;
      return left.title.localeCompare(right.title);
    });
    if (categoryGroups.length) return categoryGroups;
    return [
      {
        id: "featured",
        title: "Featured products",
        shortTitle: "Featured",
        description: "A quick look at what is currently listed in the catalog.",
        count: featuredProducts.length,
        products: featuredProducts.slice(0, 8)
      }
    ];
  }, [catalog?.categories, products, featuredProducts]);

  const [activeGroup, setActiveGroupId] = useActiveGroup(groups);

  const boxProducts = useMemo(() => {
    const boxGroup = groups.find((group) =>
      normalizeCategoryName(group.title).includes("bundle") ||
      normalizeCategoryName(group.title).includes("special")
    );
    const directMatches = products.filter((product) =>
      matchesTerms(product, ["box", "bundle", "variety pack", "special"])
    );
    return uniqueProducts([...(boxGroup?.products || []), ...directMatches]).slice(0, 5);
  }, [groups, products]);

  const boxLead = boxProducts[0] || null;
  const vendorCount = catalog?.vendors?.length || 0;
  const activeProducts = activeGroup ? activeGroup.products : featuredProducts.slice(0, 8);
  const visitorLiabilityReleaseUrl = useMemo(() => buildVisitorLiabilityReleaseUrl(), []);

  const navLinks = useMemo(
    () => [
      {
        label: "Our Farm",
        children: [
          { label: "About", href: "https://www.deckfamilyfarm.com/the-farm" },
          { label: "Our Farmily", href: "https://www.deckfamilyfarm.com/the-farmily" },
          { label: "Education", href: "https://www.deckfamilyfarm.com/intern-program" },
          { label: "Farm Dogs", href: "https://www.deckfamilyfarm.com/dogs" }
        ]
      },
      {
        label: "Full Farm CSA",
        children: [
          { label: "Subscribe", href: subscribeUrl },
          { label: "Plans", href: subscribeUrl },
          { label: "Locations", href: "#pickup" },
          { label: "Herdshare", href: subscribeUrl },
          { label: "Vendors", href: "#shop" },
          { label: "Frequently Asked Questions", href: subscribeUrl }
        ]
      },
      { label: "Newsletter", href: "https://www.deckfamilyfarm.com/newsletter" },
      { label: "Events", href: "https://www.deckfamilyfarm.com/events" },
      {
        label: "Shop",
        children: [
          { label: "CSA Shopping", href: "#shop" },
          { label: "Merchandise", href: "https://www.deckfamilyfarm.com/merchandise" }
        ]
      }
    ],
    [subscribeUrl]
  );

  const authLabel = isLoggedIn ? (isAdmin ? "Admin" : "Account") : "Log in";

  return (
    <div className="subscribe-page home-landing-page">
      <DeckPageHeader
        navLinks={navLinks}
        authLabel={onAuthAction ? authLabel : ""}
        onAuthAction={onAuthAction}
      />

      <section className="home-store-hero">
        <div className="container home-store-hero-content">
          <div className="home-draft-label">DRAFT STORE</div>
          <div className="eyebrow">Deck Family Farm</div>
          <h1 className="home-store-title">Full Farm Direct</h1>
          <p className="home-store-lede">
            Shop pasture-raised meat, raw dairy, seasonal produce, pantry staples, and partner-farm
            foods in one weekly catalog.
          </p>
          <div className="home-store-actions">
            <a className="button" href="#shop">
              Shop the catalog
            </a>
            <a className="button home-store-hero-button-alt" href="#boxes">
              Build a box
            </a>
          </div>
        </div>
      </section>

      {catalogError ? (
        <section className="home-store-section home-store-alert-section">
          <div className="container">
            <div className="home-store-alert">{catalogError}</div>
          </div>
        </section>
      ) : null}

      <section className="home-store-section home-shop-section" id="shop">
        <div className="container">
          <div className="home-section-head">
            <div>
              <div className="eyebrow">Live catalog</div>
              <h2 className="h2">Shop by how you cook.</h2>
            </div>
            <p>
              Start with a box, choose a store category, or scan the week's staples from local farms and
              producers.
            </p>
          </div>

          <div className="home-shop-browser">
            <div className="home-shop-tabs" role="tablist" aria-label="Store categories">
              {groups.map((group) => (
                <button
                  key={group.id}
                  className={`home-shop-tab${activeGroup?.id === group.id ? " active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeGroup?.id === group.id ? "true" : "false"}
                  onClick={() => setActiveGroupId(group.id)}
                >
                  <span>{group.shortTitle}</span>
                  <strong>{group.count}</strong>
                </button>
              ))}
            </div>

            <div className="home-product-preview" role="tabpanel">
              <div className="home-product-preview-head">
                <div>
                  <h3>{activeGroup?.title || "Featured products"}</h3>
                  <p>{activeGroup?.description || "A quick look at the current catalog."}</p>
                </div>
                <span>{vendorCount ? `${vendorCount} producers` : "Local producers"}</span>
              </div>

              {activeProducts.length ? (
                <div className="home-product-grid">
                  {activeProducts.map((product) => (
                    <button
                      key={product.id || product.name}
                      className="home-product-card"
                      type="button"
                      onClick={() => onSelectProduct?.(product)}
                    >
                      <span className="home-product-image">
                        <img src={productImage(product)} alt={product.name} loading="lazy" />
                      </span>
                      <span className="home-product-meta">
                        {product.category || product.vendor || "Full Farm"}
                      </span>
                      <strong>{product.name}</strong>
                      <span className="home-product-copy">
                        {cleanText(product.description || product.vendor || product.category, 94)}
                      </span>
                      <span className="home-product-price">{displayPrice(product, getPrice)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="home-empty-catalog">
                  Catalog products are loading.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="home-store-section home-box-section" id="boxes">
        <div className="container">
          <div className="home-section-head">
            <div>
              <div className="eyebrow">Box design</div>
              <h2 className="h2">Build a week around one box.</h2>
            </div>
            <p>
              A simple shopping path for members who want meals planned from farm staples without
              sorting the entire catalog.
            </p>
          </div>

          <div className="home-box-builder">
            {boxProducts.length ? (
              <div className="home-box-grid-only" aria-label="Box products">
                {boxProducts.map((product) => (
                  <button
                    key={product.id || product.name}
                    className={`home-box-card${boxLead?.id === product.id ? " featured" : ""}`}
                    type="button"
                    onClick={() => onSelectProduct?.(product)}
                  >
                    <span className="home-box-card-image">
                      <img src={productImage(product, DEFAULT_PRODUCT_IMAGE)} alt={product.name} loading="lazy" />
                    </span>
                    <span className="home-product-meta">{product.category || "Box"}</span>
                    <strong>{product.name}</strong>
                    <span className="home-product-copy">
                      {cleanText(product.description || product.vendor || product.category, 130)}
                    </span>
                    <span className="home-product-price">{displayPrice(product, getPrice)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="home-empty-catalog">
                Box products are loading.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="home-store-section home-pickup-section" id="pickup">
        <div className="container home-pickup-grid">
          <div>
            <div className="eyebrow">Pickup and delivery</div>
            <h2 className="h2">Choose the rhythm that fits your household.</h2>
            <p>
              Members can order around their schedule, use pickup sites, and keep monthly food
              credit rolling forward for future shopping.
            </p>
            <a className="button" href={subscribeUrl}>
              Become a member
            </a>
          </div>

          <div className="home-pickup-list">
            {(catalog?.dropSites || []).slice(0, 5).map((site) => (
              <div key={site.id || site.name} className="home-pickup-row">
                <strong>{site.name}</strong>
                <span>{[site.dayOfWeek, site.address].filter(Boolean).join(" - ") || "Pickup site"}</span>
              </div>
            ))}
            {!(catalog?.dropSites || []).length ? (
              <div className="home-pickup-row">
                <strong>Pickup locations</strong>
                <span>Loading current options.</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <SubscribeFooter visitorLiabilityReleaseUrl={visitorLiabilityReleaseUrl} />
    </div>
  );
}
