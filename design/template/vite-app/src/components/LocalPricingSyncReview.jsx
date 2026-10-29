import React, { useState } from "react";
import { useViewportRows } from "./useViewportRows.js";
const money = cents => cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;

export function LocalPricingSyncReview({ revisions }) {
  const scrollRef = useViewportRows(90);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(0);
  const filtered = revisions.filter(row => `${row.productName} ${row.vendorName}`.toLowerCase().includes(search.toLowerCase())
    && (showAll || row.comparison?.some(item => item.status !== "matches")));
  return <>
    <p className="review-environment-note">Prices are in use locally. Compare imported channel prices below; live synchronization is disabled.</p>
    <div className="admin-actions review-filters">
      <input className="input" aria-label="Search price differences" placeholder="Product or vendor" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      <label><input type="checkbox" checked={showAll} onChange={event => { setShowAll(event.target.checked); setPage(0); }} /> Include matching prices</label>
      <span className="small">{filtered.length} products {showAll ? "shown" : "to review"}</span>
    </div>
    <div className="table-wrap review-table-scroll" ref={scrollRef} role="region" aria-label="Price synchronization table" tabIndex={0}><table className="admin-table"><thead><tr><th>Product</th><th>Local price</th><th>Channel synchronization</th></tr></thead><tbody>
      {filtered.slice(page * 50, page * 50 + 50).map(row => <tr key={row.id}>
        <td>{row.productName}<small style={{ display: "block" }}>{row.vendorName}</small></td>
        <td>{row.output.packages.map(pkg => money(pkg.localLineRegularCents)).join(" · ")}<small style={{ display: "block" }}>{row.status === "local-preview" ? "In use locally" : "Needs pricing review"}</small></td>
        <td><details><summary>{(row.comparison || []).filter(item => item.status === "different").length} price differences · {(row.comparison || []).filter(item => item.status === "needs-check").length} need checking</summary>
          <table className="admin-table"><thead><tr><th>Channel / package</th><th>Channel price</th><th>Local price</th><th>Status</th></tr></thead><tbody>
            {(row.comparison || []).map((item, index) => <tr key={index}><td>{item.destination} · {item.label}</td><td>{money(item.currentCents)}</td><td>{money(item.localCents)}</td><td>{item.status === "matches" ? "Matches" : item.status === "different" ? "Price differs" : "Price or mapping needs checking"}</td></tr>)}
          </tbody></table>
        </details></td>
      </tr>)}
    </tbody></table></div>
    <div className="admin-actions review-pagination"><button className="button alt" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous</button><span>{filtered.length ? page * 50 + 1 : 0}–{Math.min(page * 50 + 50, filtered.length)} of {filtered.length}</span><button className="button alt" disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage(value => value + 1)}>Next</button></div>
  </>;
}
