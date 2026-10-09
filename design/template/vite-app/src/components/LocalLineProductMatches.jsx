import React, { useEffect, useState } from "react";
import { inSyncVendorScope, localLineUpdateLabel, pacificDateTime } from "./productSyncView.js";

export function LocalLineProductMatches({ rows, vendorGroup, scopeIds, selected, onSelect, onCheck, onReview, busy, loading }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [search, filter, vendorGroup, scopeIds]);
  const filtered = rows.filter(row => inSyncVendorScope(row, vendorGroup)
    && (!scopeIds?.length || scopeIds.includes(row.id))
    && (filter !== "unlinked" || !row.localLineProductId)
    && (filter !== "pending" || row.pending)
    && (filter !== "attention" || localLineUpdateLabel(row) === "Needs attention")
    && [row.name, row.vendorName, row.id, row.localLineName, row.localLineProductId].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 30)), current = Math.min(page, pages);
  const displayed = filtered.slice((current - 1) * 30, current * 30);
  const money = value => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  return <div className="sync-local-products">
    <div className="sync-filters">
      <input className="input" type="search" aria-label="Search Local Line products" placeholder="Search product, vendor, or either ID" value={search} onChange={event => setSearch(event.target.value)} />
      <select className="input" aria-label="Local Line product status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All products</option><option value="pending">Local changes pending</option><option value="unlinked">No Local Line link</option><option value="attention">Needs attention</option></select>
      <button disabled={busy || loading || !displayed.length} onClick={() => onSelect([...new Set([...selected, ...displayed.map(row => row.id)])])}>Select this page</button>
      <button disabled={busy || !selected.length} onClick={() => onSelect([])}>Clear selection</button>
    </div>
    <p className="small">{filtered.length} products · {selected.length} selected for checking. Dates are Pacific. Saved links and cached names are shown until you check Local Line.</p>
    {loading && <p role="status">Loading Local Line products…</p>}
    <div className="table-wrap"><table className="admin-table sync-local-table"><thead><tr><th>Local product</th><th>Local Line product</th><th>Update status</th><th>Last checked</th><th>Last published to Local Line</th><th>Actions &amp; details</th></tr></thead><tbody>
      {displayed.map(row => <tr key={row.id}>
        <td><label><input type="checkbox" aria-label={`Check Local Line product ${row.name}`} checked={selected.includes(row.id)} disabled={busy || loading} onChange={() => onSelect(selected.includes(row.id) ? selected.filter(id => id !== row.id) : [...selected, row.id])} /><strong>{row.name}</strong></label><div className="small">{row.vendorName} · Local #{row.id}</div></td>
        <td>{row.localLineProductId ? <><div>{row.localLineName || "Linked product — check to load name"}</div><div className="small">Local Line #{row.localLineProductId}{row.remoteDeleted ? " · Deleted remotely" : " · Linked"}</div></> : "No link"}</td>
        <td>{localLineUpdateLabel(row)}{row.latestComparison?.message && <div className="small">{row.latestComparison.message}</div>}</td>
        <td>{pacificDateTime(row.lastCheckedAt)}</td><td>{pacificDateTime(row.lastPublishedAt)}</td>
        <td><button className="button alt" disabled={busy || loading} onClick={() => onCheck([row.id])}>Check this product</button>
          <details><summary>Review details</summary>
            <p className="small">Cached Local Line data: {pacificDateTime(row.cachedAt)}</p>
            {!row.localLineProductId && <p className="small">Check this product to review a creation proposal. No product is created until you approve it.</p>}
            <table><thead><tr><th>Local package</th><th>Local Line package</th><th>Local base price</th><th>Cached Local Line base price</th></tr></thead><tbody>{(row.packages || []).map(pkg => <tr key={pkg.id}><td>{pkg.name}<div className="small">#{pkg.id}</div></td><td>{pkg.localLinePackageId ? <>{pkg.localLineName || "Linked package"}<div className="small">#{pkg.localLinePackageId}</div></> : "No saved package link"}</td><td>{money(pkg.localPrice)}</td><td>{money(pkg.localLinePrice)}</td></tr>)}</tbody></table>
            <p className="small">Base prices exclude customer pricelist adjustments. Check this product to review the exact prices, markups, sales, and other changes to publish.</p>
            {row.latestComparison && <button disabled={busy || loading} onClick={() => onReview(row)}>View last comparison</button>}
          </details>
        </td>
      </tr>)}
      {!displayed.length && !loading && <tr><td colSpan={6}>No products match these filters.</td></tr>}
    </tbody></table></div>
    {pages > 1 && <div className="sync-pagination"><button disabled={current === 1} onClick={() => setPage(current - 1)}>Previous products</button><span>Page {current} of {pages}</span><button disabled={current === pages} onClick={() => setPage(current + 1)}>Next products</button></div>}
  </div>;
}
