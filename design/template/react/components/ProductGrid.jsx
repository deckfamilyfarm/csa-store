import React from "react";

export function ProductGrid({ products }) {
  return (
    <section className="section">
      <div className="container">
        <div className="eyebrow">Featured this cycle</div>
        <h2 className="h2">Fresh cuts and staples ready to ship or pickup.</h2>
        <div className="grid four">
          {products.map((product) => (
            <div key={product.name} className="product-card">
              <div className="product-image">
                <img src={product.image} alt={product.name} loading="lazy" />
              </div>
              <strong>{product.name}</strong>
              <div className="small">{product.note}</div>
              <div className="price">{product.price}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
