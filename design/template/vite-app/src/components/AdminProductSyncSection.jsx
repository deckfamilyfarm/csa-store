import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { AdminSquareSection } from "./AdminSquareSection.jsx";
import { PLATFORM_NAMES, hasSyncRole, countLabel, auditScopeText, pacificDateTime, pacificInput, pacificCandidates, groupSyncActions, comparisonRows, isReleaseActive, releaseProgress, elapsedText } from "./productSyncView.js";
import "./AdminProductSyncSection.css";

const valueText = value => value == null ? "—" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const fieldLabel = value => value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^fields · /, "");
const emptyResults = () => ({ rows: [], total: 0, productCount: 0, platformCounts: [], vendors: [] });
function ReleaseProgress({ release, error, onDismiss }) {
  const [now, setNow] = useState(Date.now());
  const active = isReleaseActive(release);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const progress = releaseProgress(release);
  const updated = Math.max(Date.parse(release.startedAt || release.createdAt) || now, ...(release.actions || []).map(action => Date.parse(action.updatedAt) || 0));
  return <div className="sync-publish-progress" aria-label={`Publication progress: ${release.name}`}>
    <header><strong>{active ? release.status === "queued" ? "Waiting to publish" : "Publishing approved changes" : release.status === "completed" ? "Publication complete" : "Publication needs review"} · {release.name}</strong>
      <span>{elapsedText(release.startedAt || release.createdAt, release.finishedAt || now)} elapsed</span>{!active && <button onClick={onDismiss}>Dismiss</button>}</header>
    <progress max={Math.max(progress.total, 1)} value={progress.processed} aria-label="Updates processed" />
    <p role="status">{progress.processed} of {progress.total} updates processed · {progress.completed} confirmed · {progress.failed} failed · {progress.held} held{progress.cancelled ? ` · ${progress.cancelled} cancelled` : ""}</p>
    <div className="sync-platform-results">{["localline", "square"].map(platform => {
      const actions = (release.actions || []).filter(action => action.platform === platform);
      return actions.length ? <span key={platform}>{PLATFORM_NAMES[platform]}: {actions.filter(action => action.status === "completed").length}/{actions.length} confirmed</span> : null;
    })}</div>
    <div className="sync-current-work">{progress.current.map(action => <p key={action.id}><strong>{action.productName} · {PLATFORM_NAMES[action.platform]}{action.packageName ? ` · ${action.packageName}` : ""}</strong> — {action.message}</p>)}
      {active && !progress.current.length && <p>{release.status === "queued" ? "Your approval is saved. Waiting for the publishing worker or another release to finish." : "Preparing the next update…"}</p>}
      {!active && progress.failed + progress.held > 0 && <p>Open Scheduled Releases &amp; History below for details and retry or review options.</p>}
    </div>
    {active && <p className="small">Each update is checked before publishing and confirmed afterward. You can leave this page and return to follow progress.</p>}
    {active && now - updated > 60000 && <p className="small">This step is taking longer than a minute. The last saved status is shown above; checking continues.</p>}
    {error && <p className="small" role="status">Progress connection interrupted. Showing the last saved status and reconnecting… {error}</p>}
  </div>;
}
function Comparison({ action, all = false }) {
  const rows = comparisonRows(action, !all);
  return <div className="sync-comparison"><table><thead><tr><th>Field</th><th>Current</th><th>Proposed value</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}><th scope="row">{fieldLabel(row.key)}</th><td>{valueText(row.current)}</td><td>{valueText(row.proposed)}</td></tr>)}</tbody></table>
    {!rows.length && <p className="small">Remote values match. {Object.keys(action.staged || {}).length ? "Staged local changes will apply at release." : "No changes."}</p>}
    {Object.keys(action.staged || {}).length > 0 && <p className="small">Staged locally: {Object.entries(action.staged).map(([key, value]) => `${fieldLabel(key)}: ${value}`).join(" · ")}</p>}
  </div>;
}
function ActionRow({ action, selected, onToggle, eligible, busy }) {
  const differences = comparisonRows(action);
  return <div className="sync-action">
    <div className="sync-action-heading">
      <label><input type="checkbox" checked={selected} onChange={onToggle} disabled={busy || !eligible} aria-label={`Select ${PLATFORM_NAMES[action.platform]} ${action.productName} ${action.packageName || action.kind}`} />
        <strong>{PLATFORM_NAMES[action.platform]}</strong> {action.packageName || (action.kind === "create" ? "Create product" : action.direction === "incoming" ? "Local catalog repair" : "Product update")}
      </label>
      <span className={`sync-status ${action.status}`}>{action.released ? "In release" : action.status}</span>
    </div>
    {action.message && <p className="small">{action.message}</p>}
    {action.result?.message && <p className="small">{action.result.message}</p>}
    {action.display && <>
      <div className="sync-preview">{differences.slice(0, 3).map(row => <span key={row.key}><b>{fieldLabel(row.key)}:</b> {valueText(row.current)} → {valueText(row.proposed)}</span>)}</div>
      <details><summary>Review {differences.length} changed fields and all proposed values</summary><Comparison action={action} all /></details>
    </>}
  </div>;
}
export function AdminProductSyncSection({ token, roles = [], handoff = null, onAuditCreated, onClearScope, onReleaseCreated }) {
  const has = role => hasSyncRole(roles, role);
  const allowed = ["localline", "square"].filter(platform => has(`${platform}_pull`) || has(`${platform}_push`) || has("pricing_admin"));
  const [platforms, setPlatforms] = useState(allowed);
  const [vendorGroup, setVendorGroup] = useState("deck-enterprises");
  const [productScope, setProductScope] = useState("pending");
  const [pending, setPending] = useState(null);
  const [scope, setScope] = useState(handoff || null);
  const [audit, setAudit] = useState(null);
  const [previousAudit, setPreviousAudit] = useState(null);
  const [status, setStatus] = useState([]);
  const [data, setData] = useState(emptyResults);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [loadedResultsKey, setLoadedResultsKey] = useState("");
  const [filters, setFilters] = useState({ direction: handoff?.incoming ? "incoming" : "outgoing", status: "changed", platform: "", vendor: "", search: "", page: 1 });
  const [selection, setSelection] = useState([]);
  const [search, setSearch] = useState("");
  const [trackedReleases, setTrackedReleases] = useState([]);
  const [progressError, setProgressError] = useState("");
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(Boolean(handoff?.history));
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [localMatches, setLocalMatches] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [approval, setApproval] = useState(null);
  const [releaseName, setReleaseName] = useState("Product release");
  const [releaseAt, setReleaseAt] = useState(() => pacificInput(Math.ceil((Date.now() + 1000) / 3600000) * 3600000));
  const [foldChoice, setFoldChoice] = useState(0);
  const candidates = pacificCandidates(releaseAt);
  useEffect(() => { const timer = setTimeout(() => setSearch(filters.search), 250); return () => clearTimeout(timer); }, [filters.search]);
  const query = useMemo(() => new URLSearchParams(Object.entries({ ...filters, search }).filter(([, value]) => value !== "")).toString(), [filters, search]);
  const resultsKey = `${audit?.id}:${query}`;
  const resultsStale = resultsLoading || loadedResultsKey !== resultsKey || search !== filters.search;
  const activeReleaseIds = trackedReleases.filter(isReleaseActive).map(release => release.id).join(",");
  const auditing = audit?.status === "running";
  const groups = groupSyncActions(data.rows);
  const eligible = action => action.status === "changed" && !action.released && (action.direction === "incoming" ? has("localline_pull") : has(`${action.platform}_push`));
  const pendingRows = pending || [];
  const selectedScope = Boolean(scope?.productIds?.length);
  const effectiveScope = selectedScope ? "selected" : productScope;
  const auditDisabled = !!busy || auditing || !platforms.length || (effectiveScope === "pending" && (pending === null || !pendingRows.length));

  async function loadStatus() { const result = await adminGet("product-sync/status", token); setStatus(result.platforms || []); }
  async function loadHistory() {
    const result = await adminGet("product-sync/releases", token);
    setHistory([...(result.releases || []), ...(result.legacy || []).map(item => ({ ...item, legacy: true }))].sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt) || b.id - a.id));
  }
  useEffect(() => {
    let live = true;
    adminGet("product-sync/audits/latest", token).then(result => {
      if (!live) return;
      setPreviousAudit(result);
      if (!handoff && result?.status === "running") setAudit(result);
    }).catch(err => live && setError(err.message));
    loadStatus().catch(err => live && setError(err.message));
    adminGet("product-sync/releases/active", token).then(result => { if (live) setTrackedReleases(prev => [...prev, ...(result.releases || []).filter(release => !prev.some(row => row.id === release.id))]); }).catch(err => live && setProgressError(err.message));
    return () => { live = false; };
  }, [token]);
  useEffect(() => {
    if (handoff) {
      setScope(handoff); setSelection([]);
      if (handoff.auditId) adminGet(`product-sync/audits/${handoff.auditId}`, token).then(setAudit).catch(err => setError(err.message));
      else setAudit(null);
      if (handoff.incoming) setFilters(prev => ({ ...prev, direction: "incoming", page: 1 }));
    }
  }, [handoff]);
  useEffect(() => {
    let live = true;
    adminGet(`product-sync/pending?vendorGroup=${vendorGroup}`, token).then(result => { if (live) setPending(result.rows || []); }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [token, vendorGroup, reload]);
  useEffect(() => {
    if (!audit?.id || auditing) { setResultsLoading(false); return; }
    let live = true;
    setResultsLoading(true);
    adminGet(`product-sync/audits/${audit.id}/actions?${query}`, token).then(result => { if (live) { setData(result); setLoadedResultsKey(resultsKey); } }).catch(err => live && setError(err.message)).finally(() => { if (live) setResultsLoading(false); });
    return () => { live = false; };
  }, [audit?.id, audit?.status, query, token, reload]);
  useEffect(() => {
    if (!auditing) return;
    let live = true, timer;
    async function poll() {
      try {
        const next = await adminGet(`product-sync/audits/${audit.id}`, token);
        if (!live) return;
        setAudit(next);
        if (next.status !== "running") { setPreviousAudit(next); setReload(value => value + 1); await loadStatus(); return; }
      } catch (err) { setError(err.message); }
      if (live) timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [audit?.id, auditing, token]);
  useEffect(() => {
    if (!activeReleaseIds) return;
    let live = true, timer;
    const ids = activeReleaseIds.split(",");
    async function poll() {
      const responses = await Promise.allSettled(ids.map(id => adminGet(`product-sync/releases/${id}/progress`, token)));
      if (!live) return;
      const updates = responses.filter(result => result.status === "fulfilled").map(result => result.value);
      setProgressError(responses.find(result => result.status === "rejected")?.reason?.message || "");
      if (updates.some(release => !isReleaseActive(release))) {
        const refreshed = await Promise.allSettled([adminGet("product-sync/status", token), audit?.id ? adminGet(`product-sync/audits/${audit.id}`, token) : Promise.resolve(null)]);
        if (!live) return;
        if (refreshed[0].status === "fulfilled") setStatus(refreshed[0].value.platforms || []);
        if (refreshed[1].status === "fulfilled" && refreshed[1].value) setAudit(refreshed[1].value);
        setReload(value => value + 1);
      }
      setTrackedReleases(prev => prev.map(release => updates.find(row => row.id === release.id) || release));
      if (live) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [activeReleaseIds, token, audit?.id]);
  useEffect(() => { if (historyOpen) loadHistory().catch(err => setError(err.message)); }, [historyOpen, token, reload]);
  useEffect(() => {
    if (matchesOpen && allowed.includes("localline")) adminGet("product-sync/matches/localline", token).then(result => setLocalMatches(result.rows || [])).catch(err => setError(err.message));
  }, [matchesOpen, reload, token]);
  function changeFilter(key, value) { setFilters(prev => ({ ...prev, [key]: value, page: 1 })); setSelection([]); }
  async function task(key, fn) {
    setBusy(key); setError(""); setMessage("");
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  function clearAuditResults() {
    if (audit) setPreviousAudit(audit);
    setAudit(null); setSelection([]); setData(emptyResults());
  }
  async function runAudit() {
    await task("audit", async () => {
      const productIds = selectedScope ? scope.productIds : productScope === "pending" ? pendingRows.map(row => row.productId) : [];
      if (effectiveScope !== "all" && !productIds.length) return;
      const result = await adminPost("product-sync/audits", token, { platforms, vendorGroup, productIds, productScope: effectiveScope,
        staged: scope?.staged || [], incoming: has("localline_pull") && platforms.includes("localline") });
      setAudit(await adminGet(`product-sync/audits/${result.id}`, token));
      setSelection([]); setData(emptyResults());
      setFilters({ direction: "outgoing", status: "changed", platform: "", search: "", vendor: "", page: 1 });
      onAuditCreated?.(result.id);
    });
  }
  async function selectFiltered() {
    await task("select", async () => {
      const result = await adminGet(`product-sync/audits/${audit.id}/action-ids?${query}`, token);
      setSelection(result.ids || []);
    });
  }
  async function openApproval(mode) {
    await task("review", async () => {
      const result = await adminPost(`product-sync/audits/${audit.id}/selection`, token, { actionIds: selection });
      setApproval({ mode, actions: result.actions });
    });
  }
  async function approve() {
    await task("publish", async () => {
      if (approval.mode === "incoming") {
        const result = await adminPost("product-sync/incoming/apply", token, { auditId: audit.id, actionIds: selection });
        setMessage(`${result.results.filter(row => row.status === "applied").length} repairs applied. ${result.results.filter(row => row.status !== "applied").length} need review.`);
      } else {
        const scheduledAt = approval.mode === "schedule" ? candidates[foldChoice] : null;
        if (approval.mode === "schedule" && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) throw new Error("Choose a future hourly Pacific time. This time may fall in the daylight-saving gap.");
        const result = await adminPost("product-sync/releases", token, { auditId: audit.id, actionIds: selection, name: releaseName, scheduledAt, background: !scheduledAt });
        onReleaseCreated?.(result, scope?.entries || []);
        const releasedProducts = new Set((result.actions || []).map(action => action.productId));
        setScope(prev => prev ? { ...prev, staged: (prev.staged || []).filter(row => !releasedProducts.has(row.productId)), entries: (prev.entries || []).filter(entry => !releasedProducts.has(entry.meta.productId)) } : null);
        if (!scheduledAt) {
          setTrackedReleases(prev => [result, ...prev.filter(release => release.id !== result.id)]);
          setProgressError("");
        } else { setMessage(`Release “${result.name}”: ${result.status}.`); setHistoryOpen(true); }
      }
      setApproval(null); setSelection([]); setReload(value => value + 1); await loadStatus();
      setAudit(await adminGet(`product-sync/audits/${audit.id}`, token));
    });
  }
  async function releaseAction(release, action) {
    await task(`release-${release.id}`, async () => {
      const path = release.legacy ? `pricelist/scheduled-batches/${release.id}/${action}` : `product-sync/releases/${release.id}/${action}`;
      const background = !release.legacy && ["run-now", "retry"].includes(action);
      const result = await adminPost(path, token, { background });
      if (background) { setTrackedReleases(prev => [result, ...prev.filter(row => row.id !== result.id)]); setProgressError(""); }
      if (action === "review") { setAudit(await adminGet(`product-sync/audits/${result.id}`, token)); setSelection([]); setFilters(prev => ({ ...prev, direction: "outgoing", status: "changed", page: 1 })); }
      setReload(value => value + 1); await loadStatus();
    });
  }
  const canSelect = filters.direction === "incoming" ? has("localline_pull") : allowed.some(platform => has(`${platform}_push`));
  return <section className="admin-section product-sync">
    <div className="admin-section-header"><div><h3>Product Sync</h3><p className="small">Compare products, review the differences, then approve what to publish.</p></div><button className="button alt" disabled={!!busy} onClick={() => task("refresh", async () => { await loadStatus(); setReload(value => value + 1); })}>Refresh status</button></div>
    <div className="sync-platforms">{status.filter(item => allowed.includes(item.platform)).map(item => <div className="sync-platform" key={item.platform}>
      <strong>{item.label}</strong><span className="small">{item.enabled ? "Connected" : "Not configured"}</span>
      <dl><dt>Last comparison refresh</dt><dd>{pacificDateTime(item.lastRefresh)}</dd><dt>Last published</dt><dd>{pacificDateTime(item.lastPush)}</dd><dt>Approved updates</dt><dd>{item.pending} waiting to publish · {item.failed} failed or held</dd></dl>
    </div>)}</div>
    {error && <div className="form-message error" role="alert">{error}</div>}{message && <div className="form-message success" role="status">{message}</div>}
    {trackedReleases.map(release => <ReleaseProgress key={release.id} release={release} error={isReleaseActive(release) ? progressError : ""} onDismiss={() => setTrackedReleases(prev => prev.filter(row => row.id !== release.id))} />)}
    <div className="sync-audit-setup">
      <h4>1. Compare products</h4>
      <p className="small">An audit reads the latest Local Line and Square data and compares it with CSA Store. It shows proposed changes without publishing or changing your local products.</p>
      <div className="sync-audit-controls">
        <label>Products to compare<select className="input" aria-label="Products to compare" value={effectiveScope} disabled={!!busy || auditing || selectedScope} onChange={event => { setProductScope(event.target.value); clearAuditResults(); }}>
          {selectedScope && <option value="selected">{countLabel(scope.productIds.length, "selected product")} from Products</option>}
          <option value="pending">Pending local products{pending !== null ? ` (${pendingRows.length})` : ""}</option><option value="all">All products — include remote differences</option>
        </select></label>
        <label>Vendors<select className="input" aria-label="Audit vendors" value={vendorGroup} disabled={!!busy || auditing} onChange={event => { setVendorGroup(event.target.value); setPending(null); clearAuditResults(); }}><option value="deck-enterprises">Deck Enterprises</option><option value="all">All vendors</option></select></label>
        <fieldset disabled={!!busy || auditing}><legend>Compare with</legend>{allowed.map(platform => <label key={platform}><input type="checkbox" checked={platforms.includes(platform)} onChange={() => { setPlatforms(prev => prev.includes(platform) ? prev.filter(value => value !== platform) : [...prev, platform]); clearAuditResults(); }} />{PLATFORM_NAMES[platform]}</label>)}</fieldset>
        <button className="button" disabled={auditDisabled} onClick={runAudit}>{auditing ? "Auditing…" : "Run audit"}</button>
      </div>
      {vendorGroup === "deck-enterprises" && <p className="small">Deck Enterprises includes Deck Family Farm, Hyland, and Creamy Cow.</p>}
      {selectedScope && <div className="sync-scope"><span>{countLabel(scope.productIds.length, "product")} from Products · {countLabel(scope.staged?.length || 0, "staged draft")}. Only products matching the vendor selection are included. Drafts apply when their release runs.</span><button className="button alt" disabled={!!busy || auditing} onClick={() => { onClearScope?.(); setScope(null); setProductScope("pending"); clearAuditResults(); }}>Clear selection from Products</button></div>}
      {effectiveScope === "pending" && <div className="sync-pending">
        <strong>{pending === null ? "Loading pending products…" : `${countLabel(pendingRows.length, "pending local product")} to compare`}</strong>
        <p className="small">This list tracks new products and saved changes awaiting Local Line sync. The audit checks these same products on each selected destination. Square may need fewer updates because it syncs prices only. Choose All products to check for differences elsewhere in the catalog.</p>
        {!!pendingRows.length && <details><summary>View the {countLabel(pendingRows.length, "product")} to compare</summary><div className="sync-match-list">{pendingRows.map(row => <div key={row.productId}><span><strong>{row.productName}</strong> · {row.vendorName} · #{row.productId}</span><span>{row.kind === "create" ? "New to Local Line" : "Saved local changes"}</span></div>)}</div></details>}
      </div>}
      {effectiveScope === "all" && <p className="small">This compares the entire catalog within the selected vendors, including products with no pending local edits. It can find additional remote differences.</p>}
    </div>
    {!audit && previousAudit && <div className="sync-previous"><span className="small">Last saved audit: {auditScopeText(previousAudit)} · {pacificDateTime(previousAudit.createdAt)}</span><button disabled={!!busy} onClick={() => task("load-audit", async () => { setSelection([]); setAudit(await adminGet(`product-sync/audits/${previousAudit.id}`, token)); })}>View saved results</button></div>}
    {audit && <>
    <div className="sync-results-heading"><h4>2. Review audit results</h4><p><strong>{auditScopeText(audit)}</strong></p><p className="small" role="status">Audit #{audit.id} · {pacificDateTime(audit.createdAt)} · {audit.status}{audit.error ? ` · ${audit.error}` : ""}. These results reflect the products and destinations recorded for this audit.</p></div>
    {auditing ? <div className="sync-audit-loading" role="status">
      <strong><span className="sync-spinner" aria-hidden="true" /> Comparing products…</strong>
      <p>The review list will appear when the audit finishes. Nothing is being published.</p>
      {(audit.options?.platforms || []).map(platform => {
        const count = (audit.overview || []).find(row => row.platform === platform && row.direction === "outgoing")?.productCount || 0;
        return <p key={platform}>{PLATFORM_NAMES[platform]}: {count}{audit.options?.auditedProductCount != null ? ` of ${audit.options.auditedProductCount}` : ""} products compared</p>;
      })}
      <p className="small">Includes current prices, product matches, and any requested Local Line catalog checks. You can leave this page while it runs.</p>
    </div> : <>
    <div className="sync-tabs" role="tablist" aria-label="Sync direction"><button role="tab" aria-selected={filters.direction === "outgoing"} onClick={() => changeFilter("direction", "outgoing")}>Outgoing Changes</button>{has("localline_pull") && <button role="tab" aria-selected={filters.direction === "incoming"} onClick={() => changeFilter("direction", "incoming")}>Incoming Local Line Changes</button>}</div>
    {filters.direction === "incoming" && <p className="small">Approve individual local catalog repairs. Pricing drift and unsupported fixes are review only.</p>}
    <div className="sync-audit-totals">{(audit.overview || []).filter(row => row.direction === filters.direction && allowed.includes(row.platform)).map(row => <div key={row.platform}>
      <strong>{PLATFORM_NAMES[row.platform]}</strong><span>{countLabel(row.productCount, "product")} {filters.direction === "incoming" ? "with findings" : "compared"}{auditing ? " so far" : ""}</span>
      <span>{countLabel(row.changedProducts, "product")} with changes to approve · {countLabel(row.attentionProducts, "product")} need review</span>
      {row.syncedProducts > 0 && <span>{countLabel(row.syncedProducts, "product")} with matching values</span>}
    </div>)}</div>
    <div className="sync-filters">
      <input className="input" type="search" aria-label="Search product sync" placeholder="Search products or vendor" value={filters.search} onChange={event => changeFilter("search", event.target.value)} />
      <select className="input" aria-label="Platform" value={filters.platform} onChange={event => changeFilter("platform", event.target.value)}><option value="">All audited destinations</option>{allowed.map(platform => <option key={platform} value={platform}>{PLATFORM_NAMES[platform]}</option>)}</select>
      <select className="input" aria-label="Results vendor" value={filters.vendor} onChange={event => changeFilter("vendor", event.target.value)}><option value="">All audited vendors</option>{data.vendors.map(name => <option key={name}>{name}</option>)}</select>
      <select className="input" aria-label="Action status" value={filters.status} onChange={event => changeFilter("status", event.target.value)}>{["changed", "all", "synced", "blocked", "review", "held", "applied"].map(value => <option key={value} value={value}>{value === "all" ? "All results" : value === "changed" ? "Changes awaiting approval" : value === "synced" ? "Already matching" : value[0].toUpperCase() + value.slice(1)}</option>)}</select>
    </div>
    <div className="sync-result-count"><strong>{countLabel(data.productCount, "product")} in this filtered view</strong><span>{(data.platformCounts || []).map(row => `${PLATFORM_NAMES[row.platform]}: ${countLabel(row.productCount, "product")}, ${countLabel(row.updateCount, filters.direction === "incoming" ? "finding" : row.platform === "square" ? "package price result" : "product result")}`).join(" · ")}</span></div>
    <p className="small">{filters.direction === "outgoing" ? "Each checkbox selects one destination update. Local Line groups changes by product; Square lists each package price separately. A product can appear under both destinations, so update counts can exceed product counts." : "Each checkbox selects one supported repair. A product can have several findings."}</p>
    <div className="sync-selection"><span>{countLabel(selection.length, filters.direction === "incoming" ? "repair" : "update")} selected</span><button disabled={resultsStale || !!busy || !canSelect} onClick={selectFiltered}>Select all eligible {filters.direction === "incoming" ? "repairs" : "updates"} in this view</button><button disabled={!selection.length || !!busy} onClick={() => setSelection([])}>Clear selection</button>
      {filters.direction === "incoming" ? <button className="button" disabled={!selection.length || !!busy || resultsStale} onClick={() => openApproval("incoming")}>Review selected repairs</button> : <><button className="button" disabled={!selection.length || !!busy || resultsStale} onClick={() => openApproval("now")}>Apply Now</button>{has("pricing_admin") && <button className="button alt" disabled={!selection.length || !!busy || resultsStale} onClick={() => openApproval("schedule")}>Schedule Release</button>}</>}
    </div>
    <div className="sync-refresh-status" role="status">{resultsStale ? <><span className="sync-spinner" aria-hidden="true" />{resultsLoading || search !== filters.search ? "Loading results…" : "Results could not refresh. Use Refresh status to try again."}{!!groups.length && " Previous results remain visible."}</> : null}</div>
    <div className={`sync-results-list${resultsStale ? " refreshing" : ""}`} aria-busy={resultsStale}>{groups.map(group => <article className="sync-product" key={group.productId}><header><strong>{group.productName}</strong><span className="small">{group.vendorName} · #{group.productId}</span></header>{group.actions.map(action => <ActionRow key={action.id} action={action} selected={selection.includes(action.id)} eligible={eligible(action)} busy={!!busy || resultsStale} onToggle={() => setSelection(prev => prev.includes(action.id) ? prev.filter(id => id !== action.id) : [...prev, action.id])} />)}</article>)}</div>
    {!groups.length && !resultsStale && <p className="sync-empty">No products match these result filters.</p>}
    {data.productCount > 30 && <div className="sync-pagination"><button disabled={resultsStale || filters.page <= 1} onClick={() => setFilters(prev => ({ ...prev, page: prev.page - 1 }))}>Previous</button><span>Page {filters.page} of {Math.ceil(data.productCount / 30)}</span><button disabled={resultsStale || filters.page * 30 >= data.productCount} onClick={() => setFilters(prev => ({ ...prev, page: prev.page + 1 }))}>Next</button></div>}
    </>}
    </>}
    <details className="sync-fold" open={matchesOpen} onToggle={event => setMatchesOpen(event.currentTarget.open)}><summary>Product Matches</summary>
      {matchesOpen && <>{allowed.includes("localline") && <details><summary>Local Line links and create proposals ({localMatches.length})</summary><div className="sync-match-list">{localMatches.map(row => <div key={row.id}><strong>{row.name}</strong><span>{row.localLineProductId ? `Linked to Local Line #${row.localLineProductId}` : "Create proposal — requires an audit and approval"}</span></div>)}</div></details>}
        {allowed.includes("square") && <AdminSquareSection token={token} canPullSquare={has("square_pull")} canPushSquare={false} matchesOnly onMatchesChanged={() => { setSelection([]); setMessage("Square matches changed. Run a new audit before selecting these products."); }} />}</>}
    </details>
    <details className="sync-fold" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Scheduled Releases &amp; History</summary>
      <p className="small">Newest releases first. Times are Pacific. Held actions need a new audit; retries process unfinished actions only.</p>
      {historyOpen && history.map(release => {
        const actions = release.actions || [];
        const unfinished = actions.filter(action => !["completed", "cancelled"].includes(action.status));
        const canRun = release.legacy ? has("localline_push") : (!release.isScheduled || has("pricing_admin")) && unfinished.every(action => has(`${action.platform}_push`));
        return <div className="sync-release" key={`${release.legacy ? "legacy" : "shared"}-${release.id}`}><header><strong>{release.name}</strong><span className={`sync-status ${release.status}`}>{release.status}</span></header>
          <p className="small">{pacificDateTime(release.scheduledAt)}{release.legacy ? " · Legacy Local Line release" : ` · ${[...new Set(actions.map(action => PLATFORM_NAMES[action.platform]))].join(" + ")}`}</p>
          {release.legacy ? <p className="small">{release.itemCount} products · {release.remoteAppliedCount} completed · {release.failedCount} failed. Adding Square requires a new audit.</p> : <div className="sync-platform-results">{["localline", "square"].map(platform => { const subset = actions.filter(action => action.platform === platform); return subset.length ? <span key={platform}>{PLATFORM_NAMES[platform]}: {subset.filter(action => action.status === "completed").length}/{subset.length} completed · {subset.filter(action => action.status === "held").length} held · {subset.filter(action => action.status === "failed").length} failed</span> : null; })}</div>}
          <details><summary>Product results</summary>{release.legacy ? (release.items || []).map(item => <p key={item.id}>{item.productName}: {item.status} {item.errorMessage}</p>) : actions.map(action => <div key={action.id} className="sync-release-result"><strong>{action.productName}</strong> · {PLATFORM_NAMES[action.platform]} {action.packageName} · {action.status}<p className="small">{action.message}{action.checkpoint?.remoteId ? ` · Local Line #${action.checkpoint.remoteId}` : ""}</p></div>)}</details>
          <div className="admin-actions">{release.status === "scheduled" && <>{has("pricing_admin") && <button disabled={!!busy} onClick={() => releaseAction(release, "cancel")}>Cancel</button>}{canRun && <button disabled={!!busy} onClick={() => releaseAction(release, "run-now")}>Run now</button>}</>}
            {canRun && (release.legacy || unfinished.some(action => action.status !== "held")) && ["failed", "partial", "running"].includes(release.status) && <button disabled={!!busy} onClick={() => releaseAction(release, "retry")}>Retry unfinished</button>}
            {!release.legacy && canRun && ["failed", "partial", "held"].includes(release.status) && unfinished.length > 0 && <button disabled={!!busy} onClick={() => releaseAction(release, "review")}>Review again</button>}
          </div>
        </div>;
      })}
      {historyOpen && !history.length && <p>No releases yet.</p>}
    </details>
    {approval && <div className="modal-backdrop"><div className="modal sync-approval" role="dialog" aria-modal="true" aria-label="Approve product sync actions">
      <h3>{approval.mode === "incoming" ? "Approve local repairs" : approval.mode === "schedule" ? "Schedule approved changes" : "Apply approved changes now"}</h3>
      <p>{countLabel(new Set(approval.actions.map(action => action.productId)).size, "product")} · {countLabel(approval.actions.length, approval.mode === "incoming" ? "repair" : "update")} selected for {[...new Set(approval.actions.map(action => PLATFORM_NAMES[action.platform]))].join(" and ")}. Changed inputs or matches will be held for review.</p>
      {approval.mode !== "incoming" && <label>Release name<input className="input" value={releaseName} onChange={event => setReleaseName(event.target.value)} /></label>}
      {approval.mode === "schedule" && <><label>Release time — Pacific<input className="input" type="datetime-local" step="3600" value={releaseAt} onChange={event => { setReleaseAt(event.target.value); setFoldChoice(0); }} /></label>{candidates.length > 1 && <label>Daylight-saving time occurs twice<select className="input" value={foldChoice} onChange={event => setFoldChoice(Number(event.target.value))}>{candidates.map((value, index) => <option key={value} value={index}>{pacificDateTime(value)}</option>)}</select></label>}<p className="small">{candidates[foldChoice] ? pacificDateTime(candidates[foldChoice]) : "Choose a valid Pacific time at the top of an hour."}</p></>}
      <div className="sync-approval-actions">{approval.actions.map(action => <details key={action.id}><summary>{action.productName} · {PLATFORM_NAMES[action.platform]} · {action.packageName || action.kind}</summary><Comparison action={action} all /></details>)}</div>
      {error && <p role="alert">{error}</p>}
      {busy === "publish" && <div className="sync-submitting" role="status"><span className="sync-spinner" aria-hidden="true" />{approval.mode === "incoming" ? "Rechecking and applying the selected local repairs…" : approval.mode === "schedule" ? "Saving your scheduled release…" : "Saving your approval. Live publishing progress will appear shortly…"}</div>}
      <div className="admin-actions"><button className="button alt" disabled={!!busy} onClick={() => setApproval(null)}>Back to audit</button><button className="button" disabled={!!busy || (approval.mode === "schedule" && !candidates[foldChoice])} onClick={approve}>{busy === "publish" ? "Applying…" : approval.mode === "schedule" ? "Approve & schedule" : "Approve & apply"}</button></div>
    </div></div>}
  </section>;
}
