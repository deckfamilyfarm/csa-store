import React from "react";
import { getCategoryMeta } from "../categoryMeta.js";

export function PantryCategories({ categories, selectedKey, onSelect }) {
  return (
    <section className="section tight" id="shop">
      <div className="container">
        <div className="eyebrow">Shop by pantry</div>
        <h2 className="h2">Browse by Category</h2>
        <div className="grid four">
          {categories.map((category) => {
            const meta = getCategoryMeta(category.name);
            return (
            <button
              key={category.id}
              className={`category-tile button-reset ${
                selectedKey === category.id ? "selected" : ""
              }`}
              type="button"
              onClick={() => onSelect?.(category.id)}
            >
              {meta.image && (
                <div className="category-image">
                  <img src={meta.image} alt={category.name} loading="lazy" />
                </div>
              )}
              <div className="icon">{meta.icon}</div>
              <strong>{category.name}</strong>
              <span className="small">{meta.note}</span>
            </button>
          );})}
        </div>
      </div>
    </section>
  );
}
