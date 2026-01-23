import React from "react";

export function RecipesSection({ recipes }) {
  return (
    <section className="section" id="recipes">
      <div className="container">
        <div className="eyebrow">From the kitchen</div>
        <h2 className="h2">Recipes and stories from the farm.</h2>
        <div className="grid three">
          {recipes.map((recipe) => (
            <div key={recipe.title} className="card pad">
              <strong>{recipe.title}</strong>
              <p className="small">{recipe.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
