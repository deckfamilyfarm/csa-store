import React from "react";

export function DeliverySection({ delivery, dropSite }) {
  return (
    <section className="section" id="delivery">
      <div className="container">
        <div className="grid two">
          <div>
            <div className="eyebrow">{delivery.eyebrow}</div>
            <h2 className="h2">{delivery.title}</h2>
            <p className="lede">{delivery.body}</p>
            <div className="grid two">
              {delivery.routes.map((route) => (
                <div key={route.title} className="card pad">
                  <strong>{route.title}</strong>
                  <div className="small">{route.note}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="side-stack">
            <div className="map-card">
              <img src={delivery.mapImage} alt="Delivery zones map" loading="lazy" />
            </div>
            <div className="card pad">
              <strong>Default drop site</strong>
              <div className="small">Set in account settings</div>
              <div className="pill">{dropSite.defaultSite}</div>
              <a className="button alt" href="#account">
                Update drop site
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
