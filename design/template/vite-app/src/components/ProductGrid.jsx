import React from "react";

function renderStars(rating) {
  const safeRating = Math.max(0, Math.min(5, rating || 0));
  return "*".repeat(safeRating) + "-".repeat(5 - safeRating);
}

export function ProductGrid({
  products,
  showCartAction = false,
  onSelect,
  filterLabel,
  sectionRef,
  eyebrow = "Featured this cycle",
  title = "Fresh cuts and staples ready to ship or pickup.",
  embedded = false,
  getPrice
}) {
  const priceFor = (product) => (getPrice ? getPrice(product) : product.price);
  const content = (
    <>
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="h2">{title}</h2>
      {filterLabel && <div className="small">Showing: {filterLabel}</div>}
      {products.length === 0 ? (
        <div className="card pad">
          <strong>No products in this category yet.</strong>
          <div className="small">Try another category or check back soon.</div>
        </div>
      ) : (
        <div className="grid four">
          {products.map((product) => (
            <div key={product.name} className="product-card">
              <button
                className="product-image button-reset"
                type="button"
                onClick={() => onSelect?.(product)}
              >
                <img
                  src={product.thumbnailUrl || product.imageUrl || product.image}
                  alt={product.name}
                  loading="lazy"
                />
              </button>
              <strong>{product.name}</strong>
              <div className="small">{product.note}</div>
              <div className="price">{priceFor(product) ? `$${priceFor(product)}` : "Price TBD"}</div>
              {product.reviews && product.reviews.length > 0 ? (
                <div className="small">
                  {renderStars(product.rating)} {product.rating || 0}/5 ·{" "}
                  {product.reviews.length} review(s)
                </div>
              ) : (
                <div className="small">No reviews yet</div>
              )}
              <button className="button alt" type="button" onClick={() => onSelect?.(product)}>
                View details
              </button>
              {showCartAction && (
                <button className="button alt" type="button">
                  Add to cart
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="product-grid" id="product-grid" ref={sectionRef}>
        {content}
      </div>
    );
  }

  return (
    <section className="section" id="product-grid" ref={sectionRef}>
      <div className="container">{content}</div>
    </section>
  );
}
