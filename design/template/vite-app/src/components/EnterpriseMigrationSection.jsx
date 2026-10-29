import React, { useEffect, useState } from "react";
import { adminGet } from "../adminApi.js";
import { useViewportRows } from "./useViewportRows.js";
import "./EnterpriseReviewSection.css";

export function EnterpriseMigrationSection({ token }) {
  const [migrationReport, setMigrationReport] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scrollRef = useViewportRows();
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    adminGet("enterprise-pricing/migration-report?limit=1000", token)
      .then(rows => { if (!cancelled) setMigrationReport(rows); })
      .catch(error => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, refresh]);

  return <section className="card enterprise-review-page">
    <div className="admin-section-heading"><h2>Migration comparison</h2></div>
    <div className="admin-actions">
      <span className="small" role="status">{loading ? "Loading comparison…" : `${migrationReport.length} package rows`}</span>
      <button className="button alt" type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!loading && !error && !migrationReport.length && <p>No migration comparisons available.</p>}
      <div className="table-wrap review-table-scroll" ref={scrollRef} role="region" aria-label="Migration comparison table" tabIndex={0}><table className="admin-table"><thead><tr><th>Product / package</th><th>Current local</th><th>Local Line</th><th>Square</th><th>Proposed</th><th>Difference</th><th>Action</th></tr></thead><tbody>
        {migrationReport.map(row => <tr key={`${row.productId}-${row.packageId}`}><td>{row.product} · {row.package}</td><td>{row.currentLocalPrice == null ? "—" : `$${Number(row.currentLocalPrice).toFixed(2)}`}</td><td>{row.currentRemote.localLine.map(entry => `${entry.list}: $${entry.price.toFixed(2)}`).join(" · ") || "—"}{row.basketConflict && " · basket conflict"}</td><td>{row.currentRemote.square.map(price => `$${price.toFixed(2)}`).join(", ") || "—"}</td><td>{row.proposedPrice == null ? "—" : `$${row.proposedPrice.toFixed(2)}`}</td><td>{row.difference == null ? "—" : `$${row.difference.toFixed(2)} (${row.differencePercent}%)`}</td><td>{row.action}</td></tr>)}
      </tbody></table></div>
  </section>;
}
