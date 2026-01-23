import React from "react";

export function FooterSection({ brand }) {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <div className="logo">{brand}</div>
          <p className="small">Pasture-raised, family-run, and built for steady weekly rhythm.</p>
        </div>
        <div>
          <strong>Store</strong>
          <div className="small">Catalog</div>
          <div className="small">CSA plans</div>
          <div className="small">Delivery zones</div>
        </div>
        <div>
          <strong>Members</strong>
          <div className="small">Wallet and credits</div>
          <div className="small">Order history</div>
          <div className="small">Preferences</div>
        </div>
      </div>
    </footer>
  );
}
