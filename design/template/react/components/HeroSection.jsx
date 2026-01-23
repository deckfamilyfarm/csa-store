import React from "react";

export function HeroSection({ hero }) {
  return (
    <section className="section">
      <div className="container hero">
        <div className="hero-inner">
          <div className="hero-card">
            <div className="eyebrow">{hero.eyebrow}</div>
            <h1 className="h1">{hero.title}</h1>
            <p className="lede">{hero.body}</p>
            <div className="button-row">
              <a className="button" href="#shop">
                {hero.primary}
              </a>
              <a className="button alt" href="#csa">
                {hero.secondary}
              </a>
            </div>
          </div>
          <div className="hero-visual">
            <img src={hero.image} alt="Farm landscape" loading="lazy" />
          </div>
        </div>
      </div>
    </section>
  );
}
