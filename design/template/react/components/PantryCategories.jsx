import React from "react";

export function PantryCategories({ categories }) {
  return (
    <section className="section tight" id="shop">
      <div className="container">
        <div className="eyebrow">Shop by pantry</div>
        <h2 className="h2">A clear, catalog-driven browse.</h2>
        <div className="grid four">
          {categories.map((category) => (
            <div key={category.title} className="category-tile">
              <div className="icon">{category.icon}</div>
              <strong>{category.title}</strong>
              <span className="small">{category.note}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
