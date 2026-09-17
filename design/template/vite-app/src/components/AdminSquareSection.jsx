import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";

function toNumber(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCents(value, currency = "USD") {
  const numeric = toNumber(value);
  if (numeric === null) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD"
  }).format(numeric / 100);
}

function formatScore(value) {
  const numeric = toNumber(value);
  if (numeric === null) return "";
  return `${Math.round(numeric * 100)}%`;
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function getCandidateLabel(candidate) {
  return [candidate.itemName, candidate.variationName].filter(Boolean).join(" / ") || "Unnamed";
}

function getLinkedLabel(linked) {
  if (!linked) return "Unlinked";
  return [linked.itemName, linked.variationName].filter(Boolean).join(" / ") || linked.squareVariationId;
}

function formatPriceBasis(value) {
  if (value === "vendor-retail-price") return "Vendor's Retail Price";
  if (value === "local-package-price") return "Local package price";
  return value || "";
}

export function AdminSquareSection({
  token,
  canPullSquare = false,
  canPushSquare = false
}) {
  const [status, setStatus] = useState(null);
  const [matches, setMatches] = useState([]);
  const [matchSummary, setMatchSummary] = useState(null);
  const [auditRows, setAuditRows] = useState([]);
  const [auditSummary, setAuditSummary] = useState(null);
  const [applySummary, setApplySummary] = useState(null);
  const [search, setSearch] = useState("");
  const [matchFilter, setMatchFilter] = useState("all");
  const [auditFilter, setAuditFilter] = useState("changed");
  const [candidateSelections, setCandidateSelections] = useState({});
  const [matchesCollapsed, setMatchesCollapsed] = useState(false);
  const [includeAllProducts, setIncludeAllProducts] = useState(false);
  const [loadingAction, setLoadingAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadStatus() {
    const response = await adminGet("square/status", token);
    setStatus(response);
  }

  async function loadMatches() {
    const response = await adminGet(
      `square/matches${includeAllProducts ? "?includeAllProducts=1" : ""}`,
      token
    );
    setMatches(response.rows || []);
    setMatchSummary(response.summary || null);
  }

  async function refreshAll() {
    if (!token) return;
    setError("");
    setMessage("");
    setLoadingAction("load");
    try {
      await Promise.all([loadStatus(), loadMatches()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to load Square data.");
    } finally {
      setLoadingAction("");
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, includeAllProducts]);

  useEffect(() => {
    setAuditRows([]);
    setAuditSummary(null);
    setApplySummary(null);
    setCandidateSelections({});
  }, [includeAllProducts]);

  async function handleCatalogSync() {
    setError("");
    setMessage("");
    setLoadingAction("cache");
    try {
      const response = await adminPost("square/cache-sync", token, {});
      setMessage(
        `Square catalog refreshed: ${response.summary?.items || 0} items, ${response.summary?.variations || 0} variations.`
      );
      await refreshAll();
    } catch (nextError) {
      setError(nextError?.message || "Unable to refresh Square catalog.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleApprove(row, candidate) {
    if (!candidate) return;
    setError("");
    setMessage("");
    setLoadingAction(`approve-${row.packageId}`);
    try {
      await adminPost("square/matches/approve", token, {
        productId: row.productId,
        packageId: row.packageId,
        squareItemId: candidate.squareItemId,
        squareVariationId: candidate.squareVariationId,
        matchScore: candidate.score
      });
      setMessage(`Linked ${row.productName} / ${row.packageName}.`);
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to approve Square match.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleUnlink(row) {
    setError("");
    setMessage("");
    setLoadingAction(`unlink-${row.packageId}`);
    try {
      await adminPost("square/matches/unlink", token, {
        packageId: row.packageId
      });
      setMessage(`Unlinked ${row.productName} / ${row.packageName}.`);
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to unlink Square match.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleAudit() {
    setError("");
    setMessage("");
    setApplySummary(null);
    setLoadingAction("audit");
    try {
      const response = await adminPost("square/audit-prices", token, {
        includeAllProducts
      });
      setAuditRows(response.rows || []);
      setAuditSummary(response.summary || null);
      setMessage(`Square audit complete: ${response.summary?.changed || 0} changed.`);
    } catch (nextError) {
      setError(nextError?.message || "Unable to audit Square prices.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleApplyChanged() {
    const packageIds = auditRows
      .filter((row) => row.status === "changed")
      .map((row) => row.packageId);
    if (!packageIds.length) return;
    const confirmed = window.confirm(`Apply ${packageIds.length} Square price update${packageIds.length === 1 ? "" : "s"}?`);
    if (!confirmed) return;

    setError("");
    setMessage("");
    setLoadingAction("apply");
    try {
      const response = await adminPost("square/apply-prices", token, {
        packageIds,
        includeAllProducts
      });
      setAuditRows(response.rows || []);
      setApplySummary(response.summary || null);
      setAuditFilter("all");
      setMessage(`Square apply complete: ${response.summary?.updated || 0} updated.`);
      await Promise.all([loadStatus(), loadMatches()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to apply Square prices.");
    } finally {
      setLoadingAction("");
    }
  }

  const filteredMatches = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return matches.filter((row) => {
      if (matchFilter === "linked" && !row.linked) return false;
      if (matchFilter === "unlinked" && row.linked) return false;
      if (matchFilter === "suggested" && (row.linked || !(row.candidates || []).length)) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        row.productName,
        row.packageName,
        row.packageCode,
        row.vendorName,
        row.categoryName,
        row.linked?.itemName,
        row.linked?.variationName,
        ...(row.candidates || []).flatMap((candidate) => [
          candidate.itemName,
          candidate.variationName,
          candidate.sku
        ])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [matches, matchFilter, search]);

  const filteredAuditRows = useMemo(() => {
    return auditRows.filter((row) => auditFilter === "all" || row.status === auditFilter);
  }, [auditRows, auditFilter]);

  const changedAuditCount = auditRows.filter((row) => row.status === "changed").length;
  const busy = Boolean(loadingAction);

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <div>
          <h3>Square</h3>
          <div className="small">
            {status?.enabled ? "Connected" : "Not configured"} · {status?.environment || "production"} · {status?.currency || "USD"}
          </div>
        </div>
        <div className="admin-actions">
          <button className="button alt" type="button" onClick={refreshAll} disabled={busy}>
            Refresh
          </button>
          <button
            className="button"
            type="button"
            onClick={handleCatalogSync}
            disabled={busy || !canPullSquare || !status?.enabled}
          >
            {loadingAction === "cache" ? "Refreshing..." : "Refresh Square Catalog"}
          </button>
        </div>
      </div>

      {message ? <div className="form-message success">{message}</div> : null}
      {error ? <div className="form-message error">{error}</div> : null}

      <div className="admin-metric-grid">
        <div className="metric-card">
          <div className="metric-label">Square Items</div>
          <div className="metric-value">{status?.counts?.items ?? 0}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Square Variations</div>
          <div className="metric-value">{status?.counts?.variations ?? 0}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Approved Links</div>
          <div className="metric-value">{status?.counts?.links ?? 0}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Last Run</div>
          <div className="metric-value metric-value-small">
            {formatDateTime(status?.latestRuns?.[0]?.finishedAt || status?.latestRuns?.[0]?.startedAt)}
          </div>
        </div>
      </div>

      <div className={`square-scope-box ${includeAllProducts ? "warning" : ""}`}>
        <div>
          <div className="title">Square product scope</div>
          <div className="small">
            Default: Deck Family Farm, Hyland Processing, and Full Farm CSA tote bags.
          </div>
          {includeAllProducts ? (
            <div className="small square-scope-warning">
              Be careful: all local products are visible and can be matched to Square, including other vendors.
            </div>
          ) : null}
        </div>
        <label className="filter-toggle square-scope-toggle">
          <input
            type="checkbox"
            checked={includeAllProducts}
            onChange={(event) => setIncludeAllProducts(event.target.checked)}
          />
          <span>Include all products</span>
        </label>
      </div>

      <div className="admin-subsection">
        <div className="admin-section-header">
          <div>
            <h4>Matches</h4>
            <div className="small">
              {matchSummary?.linked || 0} linked · {matchSummary?.unmatched || 0} unlinked
            </div>
          </div>
          <div className="admin-actions">
            {!matchesCollapsed ? (
              <div className="filters compact">
                <input
                  className="input"
                  type="search"
                  placeholder="Search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <select
                  className="input"
                  value={matchFilter}
                  onChange={(event) => setMatchFilter(event.target.value)}
                >
                  <option value="all">All</option>
                  <option value="suggested">Suggested</option>
                  <option value="linked">Linked</option>
                  <option value="unlinked">Unlinked</option>
                </select>
              </div>
            ) : null}
            <button
              className="button alt"
              type="button"
              onClick={() => setMatchesCollapsed((prev) => !prev)}
            >
              {matchesCollapsed ? "Expand Matches" : "Collapse Matches"}
            </button>
          </div>
        </div>
        {matchesCollapsed ? (
          <div className="small">
            Matches collapsed. Approved links are still used by the price audit.
          </div>
        ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>CSA Package</th>
                <th>Square Link</th>
                <th>Best Candidate</th>
                <th>Score</th>
                <th>Price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.map((row) => {
                const selectedCandidateId = candidateSelections[row.packageId];
                const candidate =
                  (row.candidates || []).find(
                    (entry) => entry.squareVariationId === selectedCandidateId
                  ) ||
                  row.candidates?.[0] ||
                  null;
                const rowBusy =
                  loadingAction === `approve-${row.packageId}` ||
                  loadingAction === `unlink-${row.packageId}`;
                return (
                  <tr key={`square-match-${row.packageId}`}>
                    <td>
                      <div className="title">{row.productName}</div>
                      <div className="small">{row.packageName || "Package"}</div>
                      {row.vendorName ? <div className="small">{row.vendorName}</div> : null}
                    </td>
                    <td>
                      <div>{getLinkedLabel(row.linked)}</div>
                      {row.linked?.sku ? <div className="small">SKU {row.linked.sku}</div> : null}
                    </td>
                    <td>
                      {candidate ? (
                        <>
                          <div>{getCandidateLabel(candidate)}</div>
                          {candidate.sku ? <div className="small">SKU {candidate.sku}</div> : null}
                          {(row.candidates || []).length > 1 ? (
                            <select
                              className="input compact-input"
                              value={candidate.squareVariationId}
                              onChange={(event) =>
                                setCandidateSelections((prev) => ({
                                  ...prev,
                                  [row.packageId]: event.target.value
                                }))
                              }
                            >
                              {row.candidates.map((entry) => (
                                <option
                                  key={`${row.packageId}-${entry.squareVariationId}`}
                                  value={entry.squareVariationId}
                                >
                                  {getCandidateLabel(entry)} · {formatScore(entry.score)}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </>
                      ) : (
                        <span className="small">No candidate</span>
                      )}
                    </td>
                    <td>{candidate ? formatScore(candidate.score) : ""}</td>
                    <td>{candidate ? formatCents(candidate.priceAmount, candidate.currency) : ""}</td>
                    <td>
                      <div className="admin-actions">
                        <button
                          className="button alt"
                          type="button"
                          onClick={() => handleApprove(row, candidate)}
                          disabled={busy || rowBusy || !candidate || !canPullSquare}
                        >
                          {row.linked ? "Relink" : "Approve"}
                        </button>
                        {row.linked ? (
                          <button
                            className="button text"
                            type="button"
                            onClick={() => handleUnlink(row)}
                            disabled={busy || rowBusy || !canPullSquare}
                          >
                            Unlink
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!filteredMatches.length ? (
                <tr>
                  <td colSpan={6}>No Square match rows found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        )}
      </div>

      <div className="admin-subsection">
        <div className="admin-section-header">
          <div>
            <h4>Price Audit</h4>
            <div className="small">
              {auditSummary
                ? `${auditSummary.changed || 0} changed · ${auditSummary.synced || 0} synced · ${auditSummary.blocked || 0} blocked`
                : "No audit loaded"}
            </div>
          </div>
          <div className="admin-actions">
            <select
              className="input"
              value={auditFilter}
              onChange={(event) => setAuditFilter(event.target.value)}
            >
              <option value="changed">Changed</option>
              <option value="blocked">Blocked</option>
              <option value="synced">Synced</option>
              <option value="updated">Updated</option>
              <option value="submitted">Submitted</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="all">All</option>
            </select>
            <button className="button alt" type="button" onClick={handleAudit} disabled={busy}>
              {loadingAction === "audit" ? "Auditing..." : "Audit Prices"}
            </button>
            <button
              className="button"
              type="button"
              onClick={handleApplyChanged}
              disabled={busy || !canPushSquare || !changedAuditCount || !status?.enabled}
            >
              {loadingAction === "apply" ? "Applying..." : `Apply Changed (${changedAuditCount})`}
            </button>
          </div>
        </div>
        {applySummary ? (
          <div className="small">
            Last apply: {applySummary.updated || 0} updated · {applySummary.failed || 0} failed · {applySummary.blocked || 0} blocked
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>CSA Package</th>
                <th>Square Variation</th>
                <th>Square Price</th>
                <th>CSA Store Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredAuditRows.map((row) => (
                <tr key={`square-audit-${row.packageId}-${row.squareVariationId}`}>
                  <td>
                    <div className="title">{row.productName}</div>
                    <div className="small">{row.packageName || "Package"}</div>
                  </td>
                  <td>
                    <div>{[row.squareItemName, row.squareVariationName].filter(Boolean).join(" / ")}</div>
                    {row.squareSku ? <div className="small">SKU {row.squareSku}</div> : null}
                  </td>
                  <td>{formatCents(row.remoteAmount, row.currency)}</td>
                  <td>
                    {formatCents(row.proposedAmount, row.currency)}
                    {row.saleApplied ? <div className="small">Sale applied</div> : null}
                    {row.priceBasis ? <div className="small">{formatPriceBasis(row.priceBasis)}</div> : null}
                  </td>
                  <td>
                    <span className={`status-pill ${row.status}`}>{row.status}</span>
                    {row.message ? <div className="small">{row.message}</div> : null}
                  </td>
                </tr>
              ))}
              {!filteredAuditRows.length ? (
                <tr>
                  <td colSpan={5}>No Square audit rows found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
