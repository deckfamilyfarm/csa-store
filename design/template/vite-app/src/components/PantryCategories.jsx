import React from "react";

export function PantryCategories({ categories, selectedKey, onSelect }) {
  return (
    <section className="section tight" id="shop">
      <div className="container">
        <div className="eyebrow">Shop by pantry</div>
        <h2 className="h2">Browse by Category</h2>
        <div className="grid four">
          {categories.map((category) => (
            <button
              key={category.title}
              className={`category-tile button-reset ${
                selectedKey === category.key ? "selected" : ""
              }`}
              type="button"
              onClick={() => onSelect?.(category.key)}
            >
              {category.image && (
                <div className="category-image">
                  <img src={category.image} alt={category.title} loading="lazy" />
                </div>
              )}
              <div className="icon">{category.icon}</div>
              <strong>{category.title}</strong>
              <span className="small">{category.note}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
