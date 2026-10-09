import React, { useEffect, useMemo, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { AdminSquareSection } from "./AdminSquareSection.jsx";
import { LocalLineProductMatches } from "./LocalLineProductMatches.jsx";
import { ActionRow, Comparison } from "./ProductSyncReview.jsx";
import { PLATFORM_NAMES, hasSyncRole, countLabel, auditScopeText, pacificDateTime, pacificInput, pacificCandidates, groupSyncActions, inSyncVendorScope } from "./productSyncView.js";

const emptyResults = () => ({ rows: [], total: 0, productCount: 0, vendors: [] });
export function ProductSyncDestination({ platform, token, roles, connection, handoff, incoming = false, refreshVersion, reviewRequest, onAuditCreated, onClearScope, onReleaseCreated, onRefresh }) {
  const has = role => hasSyncRole(roles, role);
  const label = PLATFORM_NAMES[platform];
  const [open, setOpen] = useState(true);
  const [vendorGroup, setVendorGroup] = useState("deck-enterprises");
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [localMatches, setLocalMatches] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [scope, setScope] = useState(handoff || null);
  const [audit, setAudit] = useState(null);
  const [previousAudit, setPreviousAudit] = useState(null);
  const [data, setData] = useState(emptyResults);
  const [filters, setFilters] = useState({ status: "changed", search: "", vendor: "", page: 1 });
  const [search, setSearch] = useState("");
  const [resultsLoading, setResultsLoading] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  const [selection, setSelection] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [approval, setApproval] = useState(null);
  const [releaseName, setReleaseName] = useState(`${label} product updates`);
  const [releaseAt, setReleaseAt] = useState(() => pacificInput(Math.ceil((Date.now() + 1000) / 3600000) * 3600000));
  const [foldChoice, setFoldChoice] = useState(0);
  const resultsRef = useRef(null);
  const candidates = pacificCandidates(releaseAt);
  const auditing = audit?.status === "running";
  const direction = incoming ? "incoming" : "outgoing";
  const scopedIds = scope?.productIds?.length ? scope.productIds : null;
  const handoffAuditId = handoff?.auditIds?.[platform] || handoff?.auditId;
  const groups = groupSyncActions(data.rows);
  const newLocalLineProducts = groupSyncActions((approval?.actions || []).filter(action => action.direction === "outgoing" && action.platform === "localline" && action.kind === "create"));
  const eligible = action => action.platform === platform && action.direction === direction && action.status === "changed" && !action.released && has(incoming ? "localline_pull" : `${platform}_push`);
  useEffect(() => { setScope(handoff || null); }, [handoff]);
  useEffect(() => { const timer = setTimeout(() => setSearch(filters.search), 250); return () => clearTimeout(timer); }, [filters.search]);
  const query = useMemo(() => new URLSearchParams({ ...filters, search, platform, direction }).toString(), [filters, search, platform, direction]);
  const resultsKey = `${audit?.id}:${query}:${reload}:${refreshVersion}`;
  const resultsStale = auditing || resultsLoading || loadedKey !== resultsKey || filters.search !== search;
  useEffect(() => {
    let live = true;
    const id = reviewRequest?.id || handoffAuditId;
    adminGet(id ? `product-sync/audits/${id}` : `product-sync/audits/latest?platform=${platform}${incoming ? "&incoming=true" : ""}`, token).then(result => {
      if (!live || (result?.options?.platforms && !result.options.platforms.includes(platform))) return;
      setPreviousAudit(result);
      if (id || result?.status === "running") { setAudit(result); setSelection([]); setOpen(true); }
    }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [token, platform, incoming, handoffAuditId, reviewRequest?.id, reviewRequest?.nonce]);
  useEffect(() => {
    if (platform !== "localline" || incoming) return;
    let live = true;
    setLoadingProducts(true);
    adminGet("product-sync/matches/localline", token).then(result => live && setLocalMatches(result.rows || []))
      .catch(err => live && setError(err.message)).finally(() => live && setLoadingProducts(false));
    return () => { live = false; };
  }, [token, platform, incoming, reload, refreshVersion]);
  useEffect(() => {
    if (!audit?.id || auditing) return;
    let live = true;
    setResultsLoading(true);
    adminGet(`product-sync/audits/${audit.id}/actions?${query}`, token).then(result => { if (live) { setData(result); setLoadedKey(resultsKey); } })
      .catch(err => live && setError(err.message)).finally(() => live && setResultsLoading(false));
    return () => { live = false; };
  }, [audit?.id, audit?.status, query, token, reload, refreshVersion]);
  useEffect(() => {
    if (!auditing) return;
    let live = true, timer;
    async function poll() {
      try {
        const next = await adminGet(`product-sync/audits/${audit.id}`, token);
        if (!live) return;
        setAudit(next);
        if (next.status !== "running") { setPreviousAudit(next); setReload(value => value + 1); onRefresh(); return; }
      } catch (err) { if (live) setError(err.message); }
      if (live) timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [audit?.id, auditing, token]);
  async function task(key, fn) {
    setBusy(key); setError(""); setMessage("");
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  function resetResults() { if (audit) setPreviousAudit(audit); setAudit(null); setSelection([]); setData(emptyResults()); }
  function changeVendor(value) { setVendorGroup(value); setSelectedProducts([]); resetResults(); }
  function changeFilter(key, value) { setFilters(prev => ({ ...prev, [key]: value, page: 1 })); setSelection([]); }
  async function runAudit(ids = null) {
    await task("audit", async () => {
      // null is an explicit full-scope check; an empty selection must never become all products.
      let productIds = ids === null ? scopedIds || [] : ids;
      if (ids !== null && !productIds.length) return;
      if (platform === "localline" && !incoming) productIds = productIds.filter(id => localMatches.some(row => row.id === id && inSyncVendorScope(row, vendorGroup)));
      if ((ids !== null || scopedIds) && !productIds.length) throw new Error("None of the selected products belong to the selected vendors.");
      const included = new Set(productIds);
      const result = await adminPost("product-sync/audits", token, { platforms: [platform], vendorGroup, productIds,
        productScope: productIds.length ? "selected" : "all", incoming,
        staged: (scope?.staged || []).filter(row => included.has(row.productId)) });
      setAudit(await adminGet(`product-sync/audits/${result.id}`, token));
      setSelection([]); setData(emptyResults()); setFilters({ status: "changed", search: "", vendor: "", page: 1 });
      onAuditCreated?.(result.id, platform);
    });
  }
  async function loadSaved(id, productId = null) {
    await task("saved", async () => {
      setAudit(await adminGet(`product-sync/audits/${id}`, token)); setSelection([]);
      setFilters({ status: "all", search: productId ? String(productId) : "", vendor: "", page: 1 });
      setTimeout(() => resultsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
    });
  }
  async function selectFiltered() {
    await task("select", async () => { const result = await adminGet(`product-sync/audits/${audit.id}/action-ids?${query}`, token); setSelection(result.ids || []); });
  }
  async function openApproval(mode) {
    await task("review", async () => {
      const result = await adminPost(`product-sync/audits/${audit.id}/selection`, token, { actionIds: selection });
      if (!result.actions.every(eligible)) throw new Error("These updates changed or belong to another destination. Check them again.");
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
        if (approval.mode === "schedule" && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) throw new Error("Choose a future hourly Pacific time.");
        const result = await adminPost("product-sync/releases", token, { auditId: audit.id, actionIds: selection, name: releaseName, scheduledAt, background: !scheduledAt });
        onReleaseCreated(result, scope?.entries || []);
        const ids = new Set((result.actions || []).map(action => action.productId));
        setScope(prev => prev ? { ...prev, staged: (prev.staged || []).filter(row => !ids.has(row.productId)), entries: (prev.entries || []).filter(entry => !ids.has(entry.meta.productId)) } : null);
        if (scheduledAt) setMessage(`Scheduled “${result.name}” for ${pacificDateTime(scheduledAt)}. See history below.`);
      }
      setApproval(null); setSelection([]); setReload(value => value + 1); onRefresh();
      setAudit(await adminGet(`product-sync/audits/${audit.id}`, token));
    });
  }
  const checkBusy = !!busy || auditing || loadingProducts;
  const allLabel = incoming ? "Check incoming Local Line changes" : scopedIds ? `Check ${scopedIds.length} products from Products` : platform === "square" ? "Check Square prices" : vendorGroup === "all" ? "Check all vendors’ products" : "Check all Deck Enterprises products";
  return <details className="sync-destination" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{incoming ? "Incoming Local Line repairs" : platform === "localline" ? "Local Line — Products & updates" : "Square — Matches & prices"}</summary>
    <div className="sync-destination-body">
      <p>{incoming ? "Review supported changes from Local Line before changing local products. Formula price differences remain review only." : platform === "localline" ? "See your product links, check Local Line for differences, then review what to publish." : "Connect local packages to Square items and update Square from your local retail prices."}</p>
      <p className="small">{connection?.enabled ? "Connected" : "Not configured"} · Last comparison refresh: {pacificDateTime(connection?.lastRefresh)} · Last publication: {pacificDateTime(connection?.lastPush)} · {connection?.pending || 0} approved updates waiting · {connection?.failed || 0} need attention</p>
      {error && <div className="form-message error" role="alert">{error}</div>}{message && <div className="form-message success" role="status">{message}</div>}
      <div className="sync-audit-controls">
        <label>Vendors<select className="input" aria-label={`${label} vendors`} value={vendorGroup} disabled={checkBusy} onChange={event => changeVendor(event.target.value)}><option value="deck-enterprises">Deck Enterprises</option><option value="all">All vendors</option></select></label>
        <button className="button" disabled={checkBusy || !connection?.enabled || (incoming && !has("localline_pull"))} onClick={() => runAudit()}>{auditing ? "Checking…" : allLabel}</button>
        {!incoming && <button className="button alt" disabled={checkBusy || !connection?.enabled || !selectedProducts.length} onClick={() => runAudit(selectedProducts)}>Check selected products ({selectedProducts.length})</button>}
      </div>
      <p className="small">{vendorGroup === "deck-enterprises" ? "Deck Enterprises: Deck Family Farm, Hyland, and Creamy Cow. " : "All vendors. "}Checking reads current data; it does not publish. {scopedIds ? "Limited to the selection from Products." : "The full check includes all products in this vendor scope, regardless of search or status filters."}</p>
      {scopedIds && <div className="sync-scope"><span>{scopedIds.length} products from Products · {scope?.staged?.length || 0} staged drafts</span><button disabled={checkBusy} onClick={() => { setScope(null); setSelectedProducts([]); resetResults(); onClearScope?.(); }}>Clear selection from Products</button></div>}
      {platform === "localline" && !incoming && <LocalLineProductMatches rows={localMatches} vendorGroup={vendorGroup} scopeIds={scopedIds} selected={selectedProducts} onSelect={setSelectedProducts} onCheck={runAudit} onReview={row => loadSaved(row.latestComparison.auditId, row.id)} busy={!!busy || auditing} loading={loadingProducts} />}
      {platform === "square" && <div className="sync-square-matches"><AdminSquareSection token={token} canPullSquare={has("square_pull")} canPushSquare={has("square_push")} matchesOnly embedded vendorGroup={vendorGroup} scopeProductIds={scopedIds} selectedProductIds={selectedProducts} onSelectedProductsChange={setSelectedProducts} refreshVersion={`${refreshVersion}:${reload}`} externalBusy={!!busy || auditing} onReleaseStarted={release => onReleaseCreated(release, [])} onMatchesChanged={() => { resetResults(); setReload(value => value + 1); onRefresh(); }} /></div>}
      {!audit && previousAudit && <div className="sync-previous"><span className="small">Last saved comparison: {auditScopeText(previousAudit)} · {pacificDateTime(previousAudit.createdAt)}</span><button disabled={checkBusy} onClick={() => loadSaved(previousAudit.id)}>View saved results</button></div>}
      {audit && <div className="sync-destination-review" ref={resultsRef}>
        <h4>{incoming ? "Review incoming repairs" : `Review ${label} updates`}</h4><p className="small">{auditScopeText(audit)} · {pacificDateTime(audit.createdAt)} · {audit.status}{audit.error ? ` · ${audit.error}` : ""}</p>
        {auditing ? <div className="sync-audit-loading" role="status"><strong><span className="sync-spinner" />Checking {label} products…</strong><p>Nothing is being published. You can leave this page and return.</p><p>{(audit.overview || []).filter(row => row.platform === platform && row.direction === direction).reduce((count, row) => count + row.productCount, 0)} products checked</p></div> : <>
          <div className="sync-filters"><input className="input" type="search" aria-label={`Search ${label} review`} placeholder="Search reviewed products" value={filters.search} onChange={event => changeFilter("search", event.target.value)} /><select className="input" aria-label={`${label} review status`} value={filters.status} onChange={event => changeFilter("status", event.target.value)}>{["changed", "all", "synced", "blocked", "review", "held", "applied"].map(value => <option key={value} value={value}>{value === "changed" ? "Updates awaiting approval" : value === "synced" ? "Matching at time of check" : value === "all" ? "All results" : value}</option>)}</select></div>
          <div className="sync-selection"><span>{selection.length} {incoming ? "repairs" : "updates"} selected · {data.productCount || 0} products in this review</span><button disabled={resultsStale || !!busy || !has(incoming ? "localline_pull" : `${platform}_push`)} onClick={selectFiltered}>Select all eligible updates in this view</button><button disabled={!selection.length || !!busy} onClick={() => setSelection([])}>Clear updates</button>
            <button className="button" disabled={!selection.length || !!busy || resultsStale} onClick={() => openApproval(incoming ? "incoming" : "now")}>{incoming ? "Review selected repairs" : platform === "square" ? "Publish selected prices to Square" : "Publish selected to Local Line"}</button>
            {!incoming && has("pricing_admin") && <button className="button alt" disabled={!selection.length || !!busy || resultsStale} onClick={() => openApproval("schedule")}>Schedule updates</button>}
          </div>
          {resultsStale && <p role="status">{resultsLoading || filters.search !== search ? "Loading comparison results…" : "Results could not refresh. Refresh the page to try again."}</p>}
          <div className={`sync-results-list${resultsStale ? " refreshing" : ""}`} aria-busy={resultsStale}>{groups.map(group => <article className="sync-product" key={group.productId}><header><strong>{group.productName}</strong><span className="small">{group.vendorName} · Local #{group.productId}</span></header>{group.actions.map(action => <ActionRow key={action.id} action={action} selected={selection.includes(action.id)} eligible={eligible(action)} busy={!!busy || resultsStale} onToggle={() => setSelection(prev => prev.includes(action.id) ? prev.filter(id => id !== action.id) : [...prev, action.id])} />)}</article>)}</div>
          {!groups.length && !resultsStale && <p className="sync-empty">No products match these review filters.</p>}
          {data.productCount > 30 && <div className="sync-pagination"><button disabled={resultsStale || filters.page <= 1} onClick={() => setFilters(prev => ({ ...prev, page: prev.page - 1 }))}>Previous results</button><span>Page {filters.page} of {Math.ceil(data.productCount / 30)}</span><button disabled={resultsStale || filters.page * 30 >= data.productCount} onClick={() => setFilters(prev => ({ ...prev, page: prev.page + 1 }))}>Next results</button></div>}
        </>}
      </div>}
      {approval && <div className="modal-backdrop"><div className="modal sync-approval" role="dialog" aria-modal="true" aria-label="Approve product sync actions" aria-describedby={newLocalLineProducts.length ? "new-localline-setup-notice" : undefined}>
      <h3>{approval.mode === "incoming" ? "Approve local repairs" : approval.mode === "schedule" ? "Schedule approved changes" : "Publish approved updates"}</h3>
      <p>{countLabel(new Set(approval.actions.map(action => action.productId)).size, "product")} · {countLabel(approval.actions.length, approval.mode === "incoming" ? "repair" : "update")} selected for {[...new Set(approval.actions.map(action => PLATFORM_NAMES[action.platform]))].join(" and ")}. Changed inputs or matches will be held for review.</p>
      {newLocalLineProducts.length > 0 && <div className="sync-new-product-notice" id="new-localline-setup-notice" role="note">
        <strong>New Local Line items need manual setup</strong>
        <p>{approval.mode === "schedule" ? "After the scheduled release runs and creates these items in Local Line" : "After these items are created in Local Line"}, open each item in Local Line and:</p>
        <ul><li>Set its category manually.</li><li>Apply the <strong>Frozen</strong> or <strong>Dairy</strong> tags, as appropriate.</li></ul>
        <p>Categories and these tags are not applied automatically when creating new items.</p>
        <p className="small"><strong>New items:</strong> {newLocalLineProducts.map(product => product.productName || `Product #${product.productId}`).join(", ")}</p>
      </div>}
      {approval.mode !== "incoming" && <label>Release name<input className="input" value={releaseName} onChange={event => setReleaseName(event.target.value)} /></label>}
      {approval.mode === "schedule" && <><label>Release time — Pacific<input className="input" type="datetime-local" step="3600" value={releaseAt} onChange={event => { setReleaseAt(event.target.value); setFoldChoice(0); }} /></label>{candidates.length > 1 && <label>Daylight-saving time occurs twice<select className="input" value={foldChoice} onChange={event => setFoldChoice(Number(event.target.value))}>{candidates.map((value, index) => <option key={value} value={index}>{pacificDateTime(value)}</option>)}</select></label>}<p className="small">{candidates[foldChoice] ? pacificDateTime(candidates[foldChoice]) : "Choose a valid Pacific time at the top of an hour."}</p></>}
      <div className="sync-approval-actions">{approval.actions.map(action => <details key={action.id}><summary>{action.productName} · {PLATFORM_NAMES[action.platform]} · {action.packageName || action.kind}</summary><Comparison action={action} all /></details>)}</div>
      {error && <p role="alert">{error}</p>}
      {busy === "publish" && <div className="sync-submitting" role="status"><span className="sync-spinner" aria-hidden="true" />{approval.mode === "incoming" ? "Rechecking and applying the selected local repairs…" : approval.mode === "schedule" ? "Saving your scheduled release…" : "Saving your approval. Live publishing progress will appear shortly…"}</div>}
      <div className="admin-actions"><button className="button alt" disabled={!!busy} onClick={() => setApproval(null)}>Back to review</button><button className="button" disabled={!!busy || (approval.mode === "schedule" && !candidates[foldChoice])} onClick={approve}>{busy === "publish" ? "Applying…" : approval.mode === "schedule" ? "Approve & schedule" : incoming ? "Approve & apply repairs" : `Approve & publish to ${label}`}</button></div>
    </div></div>}
    </div>
  </details>;
}
