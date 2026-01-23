import React from "react";

export function PlanChooser({ plans }) {
  return (
    <section className="section tight" id="plan-chooser">
      <div className="container">
        <div className="eyebrow">New here?</div>
        <h2 className="h2">Start with a plan, then shop the pantry.</h2>
        <p className="lede">
          Plans fund your monthly credits and unlock member-only pricing. Pick a plan to open the
          store and start building your share.
        </p>
        <div className="grid three">
          {plans.map((plan) => (
            <div key={plan.price} className={`plan ${plan.featured ? "featured" : ""}`}>
              <div className="plan-price">{plan.price}</div>
              <div>{plan.title}</div>
              <div className="small">{plan.note}</div>
              <a className={plan.featured ? "button" : "button alt"} href="#">
                Start at {plan.price}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
