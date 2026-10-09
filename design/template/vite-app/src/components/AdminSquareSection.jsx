import React, { useEffect, useMemo, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { localRetailPriceForMatch, squareMatchPriceIssue, newSquareMatchPublication, publishSquareMatch, squareMatchChoices } from "./squareMatchPublication.js";

const PUBLICATION_STORAGE = "csa-square-match-publications-v1";
function readPublications() {
  try {
    const value = JSON.parse(localStorage.getItem(PUBLICATION_STORAGE) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

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
  canPushSquare = false,
  matchesOnly = false,
  embedded = false,
  vendorGroup = "deck-enterprises",
  scopeProductIds = null,
  selectedProductIds = [],
  onSelectedProductsChange,
  refreshVersion = 0,
  externalBusy = false,
  focusedProduct = null,
  onClearFocusedProduct,
  onMatchesChanged,
  onReleaseStarted
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
  const [matchPage, setMatchPage] = useState(1);
  const [includeAllProducts, setIncludeAllProducts] = useState(false);
  const [loadingAction, setLoadingAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [creation, setCreation] = useState(null);
  const [creationError, setCreationError] = useState("");
  const [publications, setPublications] = useState(readPublications);
  const publicationController = useRef(null);
  const lastRefreshVersion = useRef(refreshVersion);

  useEffect(() => () => publicationController.current?.abort(), [token]);

  function savePublication(packageId, progress) {
    const next = readPublications();
    if (progress) next[packageId] = progress;
    else delete next[packageId];
    localStorage.setItem(PUBLICATION_STORAGE, JSON.stringify(next));
    if (!publicationController.current?.signal.aborted) setPublications(next);
  }

  async function loadStatus() {
    const response = await adminGet("square/status", token);
    setStatus(response);
  }

  async function loadMatches() {
    const response = await adminGet(
      `square/matches${matchesOnly || includeAllProducts ? "?includeAllProducts=1" : ""}`,
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
  }, [token, includeAllProducts, matchesOnly]);

  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    // Refresh rows after a publication without erasing its confirmation or
    // replacing the in-flight link operation's busy state.
    Promise.all([loadStatus(), loadMatches()]).catch(nextError => setError(nextError.message));
  }, [refreshVersion]);

  useEffect(() => {
    setSearch("");
    setMatchFilter("all");
    setCandidateSelections({});
    setMatchesCollapsed(false);
    setMessage("");
  }, [focusedProduct]);

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
      setMessage(`Link confirmed for ${row.productName} / ${row.packageName}. Square’s price is unchanged; publishing prices requires Square Push access.`);
      onMatchesChanged?.();
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to approve Square match.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleLinkAndUpdate(row, candidate) {
    if (!canPullSquare || !canPushSquare) return;
    setError(""); setMessage("");
    setLoadingAction(`publish-${row.packageId}`);
    const controller = new AbortController();
    publicationController.current = controller;
    try {
      const existing = publications[row.packageId];
      const operation = existing || newSquareMatchPublication(row, candidate);
      // An approval response may have been lost even though the link was saved.
      if (row.linked?.squareVariationId === operation.squareVariationId) operation.linked = true;
      const result = await publishSquareMatch(operation, {
        get: path => adminGet(path, token), post: (path, body) => adminPost(path, token, body),
        checkpoint: progress => savePublication(row.packageId, progress),
        onRelease: receipt => { if (!controller.signal.aborted) onReleaseStarted?.(receipt); },
        signal: controller.signal
      });
      savePublication(row.packageId, null);
      if (controller.signal.aborted) return;
      setCandidateSelections(prev => { const next = { ...prev }; delete next[row.packageId]; return next; });
      const retail = localRetailPriceForMatch(row);
      setMessage(`Link confirmed for ${row.productName}. Square ${result.alreadyMatched ? "already matches" : "confirmed"} ${formatCents(result.expectedProposedAmount, result.currency)}${retail?.unit ? ` / ${retail.unit}` : ""}.`);
      onMatchesChanged?.();
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      if (nextError.needsReview) savePublication(row.packageId, null);
      if (!controller.signal.aborted) {
        setError(nextError.message || "Unable to finish the Square update. Resume to check the saved progress.");
        await Promise.allSettled([loadMatches(), loadStatus()]);
      }
    } finally {
      if (!controller.signal.aborted) setLoadingAction("");
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
      onMatchesChanged?.();
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      setError(nextError?.message || "Unable to unlink Square match.");
    } finally {
      setLoadingAction("");
    }
  }

  async function handleCreationPreview(row) {
    setError(""); setMessage(""); setCreationError("");
    setLoadingAction(`preview-${row.productId}`);
    try {
      const preview = await adminPost("square/products/preview", token, { productId: row.productId });
      if (preview.status === "completed") {
        setMessage(`${preview.productName} was already created in Square. Refresh the catalog to review its existing links.`);
        await Promise.all([loadMatches(), loadStatus()]);
      } else setCreation(preview);
    } catch (nextError) { setError(nextError.message || "Unable to preview Square creation."); }
    finally { setLoadingAction(""); }
  }

  async function handleCreate() {
    setCreationError(""); setLoadingAction("create");
    try {
      const result = await adminPost(`square/products/${creation.id}/create`, token, {});
      setCreation(null);
      setMessage(`Created ${result.productName} in Square and linked ${result.variations.length} package${result.variations.length === 1 ? "" : "s"}.`);
      onMatchesChanged?.();
      await Promise.all([loadMatches(), loadStatus()]);
    } catch (nextError) {
      setCreationError(nextError.message || "Unable to finish creation. Retry to check the same request.");
    } finally { setLoadingAction(""); }
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

  const scopedMatches = useMemo(() => matches.filter(row => {
    if (scopeProductIds?.length && !scopeProductIds.includes(Number(row.productId))) return false;
    if (focusedProduct) return Number(row.productId) === Number(focusedProduct.productId);
    return !matchesOnly || (embedded ? vendorGroup === "all" : includeAllProducts) || /deck family farm|hyland|creamy cow/i.test(row.vendorName || "");
  }), [matches, matchesOnly, includeAllProducts, focusedProduct, embedded, vendorGroup, scopeProductIds]);
  const visibleMatchSummary = matchesOnly || focusedProduct
    ? { linked: scopedMatches.filter(row => row.linked).length, unmatched: scopedMatches.filter(row => !row.linked).length }
    : matchSummary;
  const filteredMatches = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return scopedMatches.filter((row) => {
      if (matchFilter === "linked" && !row.linked) return false;
      if (matchFilter === "unlinked" && row.linked) return false;
      if (matchFilter === "suggested" && (row.linked || !(row.candidates || []).length)) return false;
      if (!normalizedSearch) return true;
      const haystack = [
        row.productName,
        row.productId,
        row.packageId,
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
  }, [scopedMatches, matchFilter, search]);
  useEffect(() => { setMatchPage(1); }, [search, matchFilter, vendorGroup, includeAllProducts, scopeProductIds]);
  const matchPages = Math.max(1, Math.ceil(filteredMatches.length / 30));
  const currentMatchPage = Math.min(matchPage, matchPages);
  const displayedMatches = filteredMatches.slice((currentMatchPage - 1) * 30, currentMatchPage * 30);

  const filteredAuditRows = useMemo(() => {
    return auditRows.filter((row) => auditFilter === "all" || row.status === auditFilter);
  }, [auditRows, auditFilter]);

  const changedAuditCount = auditRows.filter((row) => row.status === "changed").length;
  const busy = Boolean(loadingAction) || externalBusy;

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        {!embedded && <div>
          <h3>Square</h3>
          <div className="small">
            {status?.enabled ? "Connected" : "Not configured"} · {status?.environment || "production"} · {status?.currency || "USD"}
          </div>
        </div>}
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
      <p className="small">Compare <strong>Local store retail price</strong> with the <strong>Square price</strong>, choose the matching Square variation, then click <strong>Link &amp; update Square price</strong>. This uses the Retail Price shown in Products, with any active sale applied. Guest, member, Herd Share and SNAP markups do not affect the Square price. The result is confirmed after Square responds.</p>
      {!canPullSquare && <p className="small">Approving or changing links requires Square Pull access. Ask an administrator to grant that permission.</p>}
      {canPullSquare && !canPushSquare && <p className="small">You can confirm a link with your current access. Updating Square prices also requires Square Push access.</p>}

      {!matchesOnly && <div className="admin-metric-grid">
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
      </div>}

      {!embedded && (focusedProduct ? <div className="square-scope-box">
        <div><div className="title">Square match for {focusedProduct.productName}</div><div className="small">Showing this product’s packages · #{focusedProduct.productId}</div></div>
        <button className="button alt" type="button" onClick={onClearFocusedProduct} disabled={busy}>Show all matches</button>
      </div> : <div className={`square-scope-box ${includeAllProducts ? "warning" : ""}`}>
        <div>
          <div className="title">Square product scope</div>
          <div className="small">
            {matchesOnly ? "Default: Deck Enterprises (Deck Family Farm, Hyland, and Creamy Cow)." : "Default: Deck Family Farm, Hyland Processing, and Full Farm CSA tote bags."}
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
      </div>)}

      <div className="admin-subsection">
        <div className="admin-section-header">
          <div>
            <h4>{embedded ? "Products & prices" : "Matches"}</h4>
            <div className="small">
              {visibleMatchSummary?.linked || 0} linked · {visibleMatchSummary?.unmatched || 0} unlinked
            </div>
          </div>
          <div className="admin-actions">
            {onSelectedProductsChange && <><button disabled={busy || !displayedMatches.length} onClick={() => onSelectedProductsChange([...new Set([...selectedProductIds, ...displayedMatches.map(row => Number(row.productId))])])}>Select this page</button><button disabled={busy || !selectedProductIds.length} onClick={() => onSelectedProductsChange([])}>Clear selection</button></>}
            {!matchesCollapsed ? (
              <div className="filters compact">
                <input
                  className="input"
                  type="search"
                  placeholder="Search"
                  aria-label="Search Square matches"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <select
                  className="input"
                  value={matchFilter}
                  aria-label="Square match status"
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
                <th>Local product / package</th>
                <th>Square Link</th>
                <th>Suggested Square variation</th>
                <th>Score</th>
                <th>Local store retail price</th>
                <th>Square price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedMatches.map((row) => {
                const progress = publications[row.packageId];
                const choices = squareMatchChoices(row);
                const selectedCandidateId = progress?.squareVariationId || candidateSelections[row.packageId] || row.linked?.squareVariationId;
                const candidate =
                  choices.find(
                    (entry) => entry.squareVariationId === selectedCandidateId
                  ) ||
                  choices[0] ||
                  null;
                const retail = localRetailPriceForMatch(row);
                const priceIssue = squareMatchPriceIssue(row, candidate);
                const selectedIsLinked = candidate?.squareVariationId === row.linked?.squareVariationId && Boolean(row.linked);
                const priceMatches = selectedIsLinked && Number.isInteger(retail?.amount) && candidate.priceAmount === retail.amount && candidate.currency === retail.currency;
                const canPublishPrice = !priceIssue;
                const rowBusy =
                  loadingAction === `approve-${row.packageId}` ||
                  loadingAction === `publish-${row.packageId}` ||
                  loadingAction === `unlink-${row.packageId}`;
                return (
                  <tr key={`square-match-${row.packageId}`}>
                    <td>
                      <label>{onSelectedProductsChange && <input type="checkbox" aria-label={`Check Square product ${row.productName} / ${row.packageName}`} checked={selectedProductIds.includes(Number(row.productId))} disabled={busy} onChange={() => onSelectedProductsChange(selectedProductIds.includes(Number(row.productId)) ? selectedProductIds.filter(id => id !== Number(row.productId)) : [...selectedProductIds, Number(row.productId)])} />}<strong>{row.productName}</strong></label>
                      <div className="small">{row.packageName || "Package"}</div>
                      <div className="small">Product #{row.productId} · Package #{row.packageId}</div>
                      {row.vendorName ? <div className="small">{row.vendorName}</div> : null}
                    </td>
                    <td>
                      <div>{getLinkedLabel(row.linked)}</div>
                      {row.linked && <div className="small">Confirmed link</div>}
                      {row.linked?.sku ? <div className="small">SKU {row.linked.sku}</div> : null}
                    </td>
                    <td>
                      {candidate ? (
                        <>
                          <div>{getCandidateLabel(candidate)}</div>
                          {candidate.sku ? <div className="small">SKU {candidate.sku}</div> : null}
                          {choices.length > 1 ? (
                            <select
                              className="input compact-input"
                              value={candidate.squareVariationId}
                              disabled={busy || Boolean(progress)}
                              aria-label={`Square variation for ${row.productName} / ${row.packageName}`}
                              onChange={(event) =>
                                setCandidateSelections((prev) => ({
                                  ...prev,
                                  [row.packageId]: event.target.value
                                }))
                              }
                            >
                              {choices.map((entry) => (
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
                        <span className="small">No suggested match. Refresh Square Catalog to check for new items, or use Create in Square if this product has not been added yet.</span>
                      )}
                    </td>
                    <td>{candidate ? formatScore(candidate.score) : ""}</td>
                    <td>
                      {formatCents(retail?.regularAmount, retail?.currency)}
                      {retail?.unit && <div className="small">per {retail.unit}</div>}
                      {retail?.saleApplied && <div className="small">Sale price sent to Square: {formatCents(retail.amount, retail.currency)}</div>}
                    </td>
                    <td>{candidate ? formatCents(candidate.priceAmount, candidate.currency) : ""}</td>
                    <td>
                      <div className="admin-actions">
                        <button
                          className="button alt"
                          type="button"
                          onClick={() => canPushSquare ? handleLinkAndUpdate(row, candidate) : handleApprove(row, candidate)}
                          disabled={busy || rowBusy || !canPullSquare || (canPushSquare ? (!status?.enabled || (!progress && (!canPublishPrice || priceMatches))) : (Boolean(progress) || !candidate || selectedIsLinked))}
                        >
                          {rowBusy ? "Working…" : progress ? "Resume link & price update" : !canPushSquare ? selectedIsLinked ? "Link confirmed" : "Confirm link only" : priceMatches ? "Linked · price matches" : selectedIsLinked ? "Update Square price" : row.linked ? "Relink & update Square price" : "Link & update Square price"}
                        </button>
                        {!row.linked && <button className="button" type="button" onClick={() => handleCreationPreview(row)} disabled={busy || Boolean(progress) || !canPullSquare || !canPushSquare || !status?.enabled}>Create in Square</button>}
                        {row.linked ? (
                          <button
                            className="button text"
                            type="button"
                            onClick={() => handleUnlink(row)}
                            disabled={busy || rowBusy || Boolean(progress) || !canPullSquare}
                          >
                            Unlink
                          </button>
                        ) : null}
                      </div>
                      {progress && <div className="small" role="status">{progress.phase}{progress.releaseId ? ` · Release #${progress.releaseId}` : ""}</div>}
                      {canPushSquare && candidate && priceIssue && <div className="small">{priceIssue}</div>}
                      {!canPullSquare ? <div className="small">Square Pull access required.</div> : !candidate ? <div className="small">A Square match is required before approval.</div> : null}
                      {!row.linked && !canPushSquare && <div className="small">Creating an item requires Square Push access.</div>}
                    </td>
                  </tr>
                );
              })}
              {!filteredMatches.length ? (
                <tr>
                  <td colSpan={7}>No Square match rows found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        )}
        {!matchesCollapsed && matchPages > 1 && <div className="sync-pagination"><button disabled={currentMatchPage === 1} onClick={() => setMatchPage(currentMatchPage - 1)}>Previous products</button><span>Page {currentMatchPage} of {matchPages}</span><button disabled={currentMatchPage === matchPages} onClick={() => setMatchPage(currentMatchPage + 1)}>Next products</button></div>}
      </div>

      {creation && <div className="modal-backdrop"><div className="modal square-creation-modal" role="dialog" aria-modal="true" aria-label="Create product in Square">
        <h3>{creation.resuming ? "Finish Square creation" : "Create in Square"}</h3>
        <p>Create <strong>{creation.productName}</strong> with these variations in Square ({creation.environment}), then link each CSA package.</p>
        {creation.presentAtAllLocations && <p className="small">The item and all variations will be available at all Square locations.</p>}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Variation</th><th>SKU</th><th>Price</th><th>Price basis</th></tr></thead><tbody>{creation.variations.map(row => <tr key={row.packageId}><td>{row.name}</td><td>{row.sku || "—"}</td><td>{formatCents(row.amount, row.currency)}</td><td>{formatPriceBasis(row.priceBasis)}</td></tr>)}</tbody></table></div>
        <p className="small">This adds a catalog item with all of this product’s packages. Manage photos, taxes, inventory, and online availability in Square.</p>
        {creation.resuming && <p className="small">A previous creation is awaiting confirmation. Continue to finish that same request.</p>}
        {(creationError || creation.error) && <div className="form-message error" role="alert">{creationError || creation.error}</div>}
        <div className="admin-actions"><button className="button alt" type="button" disabled={busy} onClick={() => setCreation(null)}>Close</button><button className="button" type="button" disabled={busy || !canPullSquare || !canPushSquare} onClick={handleCreate}>{loadingAction === "create" ? "Creating and linking…" : creation.resuming ? "Continue creation and linking" : "Approve creation and link"}</button></div>
      </div></div>}

      {!matchesOnly && <div className="admin-subsection">
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
                <th>Local retail price for Square</th>
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
      </div>}
    </section>
  );
}
