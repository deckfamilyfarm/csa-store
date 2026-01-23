import React from "react";

export function AccountPanelSection({ accountPanel, dropSite }) {
  return (
    <section className="section" id="account">
      <div className="container">
        <div className="grid two">
          <div className="card pad">
            <div className="eyebrow">Account</div>
            <h2 className="h2">{accountPanel.title}</h2>
            <p className="lede">{accountPanel.body}</p>
            <div className="account-row">
              <div>
                <strong>Default drop site</strong>
                <div className="small">Used for recurring orders</div>
              </div>
              <select className="select">
                {dropSite.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="account-row">
              <div>
                <strong>Pickup notes</strong>
                <div className="small">Add locker or cooler details</div>
              </div>
              <div className="pill">Add notes</div>
            </div>
          </div>
          <div className="card pad">
            <strong>Wallet status</strong>
            <div className="lede">$184.00 credits available</div>
            <div className="small">Next credit posting: Jan 1</div>
            <div className="button-row">
              <a className="button alt" href="#">
                View ledger
              </a>
              <a className="button" href="#">
                Update plan
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
