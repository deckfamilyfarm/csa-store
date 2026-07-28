import React from "react";

export function SubscribeFooter({
  visitorLiabilityReleaseUrl = "/liability/visitor",
  firearmLiabilityReleaseUrl = "/liability/firearm"
}) {
  return (
    <footer className="subscribe-footer">
      <div className="container subscribe-footer-row">
        <div className="subscribe-footer-brand">
          <div className="subscribe-footer-brand-top">
            <img
              className="subscribe-footer-logo"
              src="/images/subscribe-footer-logo.avif"
              alt="Deck Family Farm icon logo"
            />
            <strong className="subscribe-footer-wordmark">Deck Family Farm</strong>
          </div>
          <div className="small">
            Full Farm is Deck Family Farm's membership program, featuring pasture-raised food from
            our farm and trusted local partners, with convenient neighborhood pickup sites and home
            delivery.
          </div>
        </div>
        <div className="subscribe-footer-contact">
          <div>25362 High Pass Road</div>
          <div>Junction City, OR 97448</div>
          <div>
            <a href="tel:15413210925">541-321-0925</a>
          </div>
          <div>
            <a href="mailto:fullfarmcsa@deckfamilyfarm.com">fullfarmcsa@deckfamilyfarm.com</a>
          </div>
        </div>
        <div className="subscribe-footer-links">
          <a className="subscribe-review-link" href={visitorLiabilityReleaseUrl}>
            <span className="subscribe-review-link-star" aria-hidden="true">
              !
            </span>
            <span>Visitor Liability Release</span>
          </a>
          <a className="subscribe-review-link" href={firearmLiabilityReleaseUrl}>
            <span className="subscribe-review-link-star" aria-hidden="true">
              !
            </span>
            <span>Firearms Liability Release</span>
          </a>
          <a
            className="subscribe-review-link"
            href="https://app.goodreviews.io/mode?type=link&grid=GRI_ZN9UOZ3YIM5"
            target="_blank"
            rel="noreferrer"
          >
            <span className="subscribe-review-link-star" aria-hidden="true">
              *
            </span>
            <span>Leave us a Review!</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
