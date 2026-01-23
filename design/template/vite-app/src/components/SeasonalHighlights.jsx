import React from "react";

export function SeasonalHighlights({ seasonalHighlights }) {
  return (
    <section className="section tight">
      <div className="container grid two">
        {seasonalHighlights.map((highlight) => (
          <div key={highlight.title} className="card pad">
            <div className="eyebrow">{highlight.eyebrow}</div>
            <h2 className="h2">{highlight.title}</h2>
            <p className="lede">{highlight.body}</p>
            <a className="button" href="#">
              {highlight.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
