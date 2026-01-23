import React from "react";

export function CsaPlansSection({ csaPlanTiles }) {
  return (
    <section className="section" id="csa">
      <div className="container">
        <div className="grid two">
          <div>
            <div className="eyebrow">Monthly credits</div>
            <h2 className="h2">CSA plans that roll forward.</h2>
            <p className="lede">
              Choose the level that fits your household. Credits never expire, and you can pause
              or donate leftover balance to Feed-a-Friend.
            </p>
          </div>
          <div className="grid three">
            {csaPlanTiles.map((plan) => (
              <div key={plan.price} className={`plan ${plan.featured ? "featured" : ""}`}>
                <div className="plan-price">{plan.price}</div>
                <div>{plan.title}</div>
                <div className="small">{plan.note}</div>
                <a className={plan.featured ? "button" : "button alt"} href="#">
                  Select
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
