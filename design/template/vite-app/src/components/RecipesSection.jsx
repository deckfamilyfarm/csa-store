import React from "react";

export function RecipesSection({ recipes, onSelect }) {
  return (
    <section className="section" id="recipes">
      <div className="container">
        <div className="eyebrow">From the kitchen</div>
        <h2 className="h2">Recipes from the farm and community!</h2>
        <div className="grid three">
          {recipes.map((recipe) => (
            <button
              key={recipe.title}
              className="card pad button-reset"
              type="button"
              onClick={() => onSelect?.(recipe)}
            >
              {(recipe.imageUrl || recipe.image) && (
                <div className="recipe-image">
                  <img src={recipe.imageUrl || recipe.image} alt={recipe.title} loading="lazy" />
                </div>
              )}
              <strong>{recipe.title}</strong>
              <p className="small">{recipe.note}</p>
            </button>
          ))}
        </div>
        <div className="recipe-share">
          <a className="button alt" href="#">
            Share your recipe with the community
          </a>
        </div>
      </div>
    </section>
  );
}
