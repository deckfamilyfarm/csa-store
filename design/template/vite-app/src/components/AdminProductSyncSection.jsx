import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { AdminSquareSection } from "./AdminSquareSection.jsx";
import { PLATFORM_NAMES, hasSyncRole, pacificDateTime, pacificInput, pacificCandidates, groupSyncActions, comparisonRows } from "./productSyncView.js";
import "./AdminProductSyncSection.css";

const valueText = value => value == null ? "—" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const fieldLabel = value => value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^fields · /, "");
function Comparison({ action, all = false }) {
  const rows = comparisonRows(action, !all);
  return <div className="sync-comparison"><table><thead><tr><th>Field</th><th>Current</th><th>Approved value</th></tr></thead>
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
  const [includeAllProducts, setIncludeAllProducts] = useState(false);
  const [scope, setScope] = useState(handoff || null);
  const [audit, setAudit] = useState(null);
  const [status, setStatus] = useState([]);
  const [data, setData] = useState({ rows: [], total: 0, productCount: 0, vendors: [] });
  const [filters, setFilters] = useState({ direction: handoff?.incoming ? "incoming" : "outgoing", status: "changed", platform: "", vendor: "", search: "", page: 1 });
  const [selection, setSelection] = useState([]);
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
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== "")).toString(), [filters]);
  const auditing = audit?.status === "running";
  const groups = groupSyncActions(data.rows);
  const eligible = action => action.status === "changed" && !action.released && (action.direction === "incoming" ? has("localline_pull") : has(`${action.platform}_push`));

  async function loadStatus() { const result = await adminGet("product-sync/status", token); setStatus(result.platforms || []); }
  async function loadHistory() {
    const result = await adminGet("product-sync/releases", token);
    setHistory([...(result.releases || []), ...(result.legacy || []).map(item => ({ ...item, legacy: true }))].sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt) || b.id - a.id));
  }
  useEffect(() => {
    let live = true;
    adminGet("product-sync/audits/latest", token).then(result => { if (live && !handoff) setAudit(result); }).catch(err => live && setError(err.message));
    loadStatus().catch(err => live && setError(err.message));
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
    if (!audit?.id) return;
    let live = true;
    adminGet(`product-sync/audits/${audit.id}/actions?${query}`, token).then(result => { if (live) setData(result); }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [audit?.id, audit?.status, query, token, reload]);
  useEffect(() => {
    if (!auditing) return;
    const timer = setInterval(async () => {
      try {
        const next = await adminGet(`product-sync/audits/${audit.id}`, token);
        setAudit(next); setReload(value => value + 1);
        if (next.status !== "running") await loadStatus();
      } catch (err) { setError(err.message); }
    }, 2500);
    return () => clearInterval(timer);
  }, [audit?.id, auditing, token]);
  useEffect(() => { if (historyOpen) loadHistory().catch(err => setError(err.message)); }, [historyOpen, token, reload]);
  useEffect(() => {
    if (matchesOpen && allowed.includes("localline")) adminGet("product-sync/matches/localline", token).then(result => setLocalMatches(result.rows || [])).catch(err => setError(err.message));
  }, [matchesOpen, reload, token]);
  function changeFilter(key, value) { setFilters(prev => ({ ...prev, [key]: value, page: 1 })); setSelection([]); }
  async function task(key, fn) {
    setBusy(key); setError(""); setMessage("");
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function runAudit() {
    await task("audit", async () => {
      const result = await adminPost("product-sync/audits", token, { platforms, includeAllProducts, productIds: scope?.productIds || [], staged: scope?.staged || [], incoming: has("localline_pull") && platforms.includes("localline") });
      setAudit(await adminGet(`product-sync/audits/${result.id}`, token));
      setSelection([]); setData({ rows: [], total: 0, productCount: 0, vendors: [] }); setFilters(prev => ({ ...prev, page: 1 }));
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
        const result = await adminPost("product-sync/releases", token, { auditId: audit.id, actionIds: selection, name: releaseName, scheduledAt });
        onReleaseCreated?.(result, scope?.entries || []);
        const releasedProducts = new Set((result.actions || []).map(action => action.productId));
        setScope(prev => prev ? { ...prev, staged: (prev.staged || []).filter(row => !releasedProducts.has(row.productId)), entries: (prev.entries || []).filter(entry => !releasedProducts.has(entry.meta.productId)) } : null);
        setMessage(`Release “${result.name}”: ${result.status}.`); setHistoryOpen(true);
      }
      setApproval(null); setSelection([]); setReload(value => value + 1); await loadStatus();
    });
  }
  async function releaseAction(release, action) {
    await task(`release-${release.id}`, async () => {
      const path = release.legacy ? `pricelist/scheduled-batches/${release.id}/${action}` : `product-sync/releases/${release.id}/${action}`;
      const result = await adminPost(path, token, {});
      if (action === "review") { setAudit(await adminGet(`product-sync/audits/${result.id}`, token)); setSelection([]); setFilters(prev => ({ ...prev, direction: "outgoing", status: "changed", page: 1 })); }
      setReload(value => value + 1); await loadStatus();
    });
  }
  const canSelect = filters.direction === "incoming" ? has("localline_pull") : platforms.some(platform => has(`${platform}_push`));
  return <section className="admin-section product-sync">
    <div className="admin-section-header"><div><h3>Product Sync</h3><p className="small">Audit → select changes → apply now or schedule a release.</p></div><button className="button alt" disabled={!!busy} onClick={() => task("refresh", async () => { await loadStatus(); setReload(value => value + 1); })}>Refresh status</button></div>
    <div className="sync-platforms">{status.filter(item => allowed.includes(item.platform)).map(item => <div className="sync-platform" key={item.platform}>
      <strong>{item.label}</strong><span className="small">{item.enabled ? "Connected" : "Not configured"}</span>
      <dl><dt>Last refresh</dt><dd>{pacificDateTime(item.lastRefresh)}</dd><dt>Last successful push</dt><dd>{pacificDateTime(item.lastPush)}</dd><dt>Release actions</dt><dd>{item.pending} pending · {item.failed} need attention</dd></dl>
    </div>)}</div>
    {error && <div className="form-message error" role="alert">{error}</div>}{message && <div className="form-message success" role="status">{message}</div>}
    <div className="sync-audit-controls">
      <fieldset disabled={!!busy || auditing}><legend>Audit destinations</legend>{allowed.map(platform => <label key={platform}><input type="checkbox" checked={platforms.includes(platform)} onChange={() => setPlatforms(prev => prev.includes(platform) ? prev.filter(value => value !== platform) : [...prev, platform])} />{PLATFORM_NAMES[platform]}</label>)}</fieldset>
      {platforms.includes("square") && <label><input type="checkbox" checked={includeAllProducts} disabled={!!busy || auditing} onChange={event => setIncludeAllProducts(event.target.checked)} />Square: include all vendors <span className="small">(default: Deck Family Farm)</span></label>}
      <button className="button" disabled={!!busy || auditing || !platforms.length} onClick={runAudit}>{auditing ? "Auditing…" : "Run audit"}</button>
    </div>
    {scope?.productIds?.length > 0 && <div className="sync-scope"><span>{scope.productIds.length} products from Products · {scope.staged?.length || 0} staged drafts. Drafts apply only when their release runs.</span><button className="button alt" disabled={!!busy || auditing} onClick={() => { onClearScope?.(); setScope(null); setAudit(null); setSelection([]); setData({ rows: [], total: 0, productCount: 0, vendors: [] }); }}>Clear scope</button></div>}
    <p className="small">Auditing refreshes remote data. Changes require approval. Square publishes prices only; local formula pricing remains authoritative.</p>
    {audit && <p className="small" role="status">Audit #{audit.id} · {pacificDateTime(audit.createdAt)} · {audit.status}{audit.error ? ` · ${audit.error}` : ""} · {audit.summary.map(row => `${PLATFORM_NAMES[row.platform]} ${row.direction}: ${row.count} ${row.status}`).join(" · ")}</p>}
    <div className="sync-tabs" role="tablist" aria-label="Sync direction"><button role="tab" aria-selected={filters.direction === "outgoing"} onClick={() => changeFilter("direction", "outgoing")}>Outgoing Changes</button>{has("localline_pull") && <button role="tab" aria-selected={filters.direction === "incoming"} onClick={() => changeFilter("direction", "incoming")}>Incoming Local Line Changes</button>}</div>
    {filters.direction === "incoming" && <p className="small">Approve individual local catalog repairs. Pricing drift and unsupported fixes are review only.</p>}
    <div className="sync-filters">
      <input className="input" type="search" aria-label="Search product sync" placeholder="Search products or vendor" value={filters.search} onChange={event => changeFilter("search", event.target.value)} />
      <select className="input" aria-label="Platform" value={filters.platform} onChange={event => changeFilter("platform", event.target.value)}><option value="">Both platforms</option>{allowed.map(platform => <option key={platform} value={platform}>{PLATFORM_NAMES[platform]}</option>)}</select>
      <select className="input" aria-label="Vendor" value={filters.vendor} onChange={event => changeFilter("vendor", event.target.value)}><option value="">All vendors</option>{data.vendors.map(name => <option key={name}>{name}</option>)}</select>
      <select className="input" aria-label="Action status" value={filters.status} onChange={event => changeFilter("status", event.target.value)}>{["changed", "all", "synced", "blocked", "review", "held", "applied"].map(value => <option key={value} value={value}>{value === "all" ? "All statuses" : value[0].toUpperCase() + value.slice(1)}</option>)}</select>
    </div>
    <div className="sync-selection"><span>{selection.length} actions selected · {data.total} matching actions</span><button disabled={!audit || auditing || !!busy || !canSelect} onClick={selectFiltered}>Select eligible filtered actions</button><button disabled={!selection.length || !!busy} onClick={() => setSelection([])}>Clear selection</button>
      {filters.direction === "incoming" ? <button className="button" disabled={!selection.length || !!busy || auditing} onClick={() => openApproval("incoming")}>Review selected repairs</button> : <><button className="button" disabled={!selection.length || !!busy || auditing} onClick={() => openApproval("now")}>Apply Now</button>{has("pricing_admin") && <button className="button alt" disabled={!selection.length || !!busy || auditing} onClick={() => openApproval("schedule")}>Schedule Release</button>}</>}
    </div>
    <div aria-busy={auditing}>{groups.map(group => <article className="sync-product" key={group.productId}><header><strong>{group.productName}</strong><span className="small">{group.vendorName} · #{group.productId}</span></header>{group.actions.map(action => <ActionRow key={action.id} action={action} selected={selection.includes(action.id)} eligible={eligible(action)} busy={!!busy || auditing} onToggle={() => setSelection(prev => prev.includes(action.id) ? prev.filter(id => id !== action.id) : [...prev, action.id])} />)}</article>)}</div>
    {!groups.length && <p className="sync-empty">{auditing ? "The audit is running. Results will appear here." : audit ? "No actions match these filters." : "Run an audit to compare CSA Store with your selected platforms."}</p>}
    {data.productCount > 30 && <div className="sync-pagination"><button disabled={filters.page <= 1} onClick={() => setFilters(prev => ({ ...prev, page: prev.page - 1 }))}>Previous</button><span>Page {filters.page} of {Math.ceil(data.productCount / 30)}</span><button disabled={filters.page * 30 >= data.productCount} onClick={() => setFilters(prev => ({ ...prev, page: prev.page + 1 }))}>Next</button></div>}
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
      <p>{approval.actions.length} selected actions for {[...new Set(approval.actions.map(action => PLATFORM_NAMES[action.platform]))].join(" and ")}. Changed inputs or matches will be held for review.</p>
      {approval.mode !== "incoming" && <label>Release name<input className="input" value={releaseName} onChange={event => setReleaseName(event.target.value)} /></label>}
      {approval.mode === "schedule" && <><label>Release time — Pacific<input className="input" type="datetime-local" step="3600" value={releaseAt} onChange={event => { setReleaseAt(event.target.value); setFoldChoice(0); }} /></label>{candidates.length > 1 && <label>Daylight-saving time occurs twice<select className="input" value={foldChoice} onChange={event => setFoldChoice(Number(event.target.value))}>{candidates.map((value, index) => <option key={value} value={index}>{pacificDateTime(value)}</option>)}</select></label>}<p className="small">{candidates[foldChoice] ? pacificDateTime(candidates[foldChoice]) : "Choose a valid Pacific time at the top of an hour."}</p></>}
      <div className="sync-approval-actions">{approval.actions.map(action => <details key={action.id}><summary>{action.productName} · {PLATFORM_NAMES[action.platform]} · {action.packageName || action.kind}</summary><Comparison action={action} all /></details>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="admin-actions"><button className="button alt" disabled={!!busy} onClick={() => setApproval(null)}>Back to audit</button><button className="button" disabled={!!busy || (approval.mode === "schedule" && !candidates[foldChoice])} onClick={approve}>{busy === "publish" ? "Applying…" : approval.mode === "schedule" ? "Approve & schedule" : "Approve & apply"}</button></div>
    </div></div>}
  </section>;
}
