import React, { useEffect, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { ProductSyncDestination } from "./ProductSyncDestination.jsx";
import { ReleaseProgress } from "./ProductSyncReview.jsx";
import { PLATFORM_NAMES, hasSyncRole, isReleaseActive, pacificDateTime } from "./productSyncView.js";
import "./AdminProductSyncSection.css";

export function AdminProductSyncSection({ token, roles = [], handoff = null, onAuditCreated, onClearScope, onReleaseCreated }) {
  const has = role => hasSyncRole(roles, role);
  const allowed = ["localline", "square"].filter(platform => has(`${platform}_pull`) || has(`${platform}_push`) || has("pricing_admin"));
  const [status, setStatus] = useState([]);
  const [trackedReleases, setTrackedReleases] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(Boolean(handoff?.history));
  const [incoming, setIncoming] = useState(Boolean(handoff?.incoming));
  const [reviewRequests, setReviewRequests] = useState({});
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [progressError, setProgressError] = useState("");
  const activeIds = trackedReleases.filter(isReleaseActive).map(release => release.id).join(",");
  const refresh = () => setReload(value => value + 1);
  useEffect(() => { setIncoming(Boolean(handoff?.incoming)); if (handoff?.history) setHistoryOpen(true); }, [handoff?.incoming, handoff?.history]);
  useEffect(() => {
    let live = true;
    adminGet("product-sync/status", token).then(result => live && setStatus(result.platforms || [])).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [token, reload]);
  useEffect(() => {
    let live = true;
    adminGet("product-sync/releases/active", token).then(result => live && setTrackedReleases(prev => [...prev, ...(result.releases || []).filter(release => !prev.some(row => row.id === release.id))])).catch(err => live && setProgressError(err.message));
    return () => { live = false; };
  }, [token]);
  useEffect(() => {
    if (!historyOpen) return;
    let live = true;
    adminGet("product-sync/releases", token).then(result => {
      if (live) setHistory([...(result.releases || []), ...(result.legacy || []).map(row => ({ ...row, legacy: true }))].sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt) || b.id - a.id));
    }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [token, historyOpen, reload]);
  useEffect(() => {
    if (!activeIds) return;
    let live = true, timer;
    const ids = activeIds.split(",");
    async function poll() {
      const responses = await Promise.allSettled(ids.map(id => adminGet(`product-sync/releases/${id}/progress`, token)));
      if (!live) return;
      const updates = responses.filter(result => result.status === "fulfilled").map(result => result.value);
      setProgressError(responses.find(result => result.status === "rejected")?.reason?.message || "");
      if (updates.some(release => !isReleaseActive(release))) refresh();
      setTrackedReleases(prev => prev.map(release => updates.find(row => row.id === release.id) || release));
      if (live) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [token, activeIds]);
  function trackRelease(release, entries = []) {
    onReleaseCreated?.(release, entries);
    if (release.isScheduled || release.scheduled) setHistoryOpen(true);
    else setTrackedReleases(prev => [release, ...prev.filter(row => row.id !== release.id)]);
    refresh();
  }
  async function releaseAction(release, action) {
    setBusy(`release-${release.id}`); setError("");
    try {
      const path = release.legacy ? `pricelist/scheduled-batches/${release.id}/${action}` : `product-sync/releases/${release.id}/${action}`;
      const background = !release.legacy && ["run-now", "retry"].includes(action);
      const result = await adminPost(path, token, { background });
      if (background) setTrackedReleases(prev => [result, ...prev.filter(row => row.id !== result.id)]);
      if (action === "review") {
        const audit = await adminGet(`product-sync/audits/${result.id}`, token);
        setReviewRequests(prev => ({ ...prev, ...Object.fromEntries((audit.options?.platforms || []).map(platform => [platform, { id: audit.id, nonce: Date.now() }])) }));
        setIncoming(false);
      }
      refresh();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  return <section className="admin-section product-sync">
    <div className="admin-section-header"><div><h3>Product Sync</h3><p>Manage Local Line products and Square prices in their own sections.</p></div><button className="button alt" disabled={!!busy} onClick={refresh}>Refresh status</button></div>
    {error && <div className="form-message error" role="alert">{error}</div>}
    {trackedReleases.map(release => <ReleaseProgress key={release.id} release={release} error={isReleaseActive(release) ? progressError : ""} onDismiss={() => setTrackedReleases(prev => prev.filter(row => row.id !== release.id))} />)}
    {incoming && <div className="sync-scope"><p>Incoming repairs are a separate Local Line review.</p><button onClick={() => { setIncoming(false); onClearScope?.(); }}>Back to products &amp; prices</button></div>}
    {(incoming ? allowed.filter(platform => platform === "localline" && has("localline_pull")) : allowed).map(platform => <ProductSyncDestination key={`${platform}:${incoming}`} platform={platform} token={token} roles={roles} connection={status.find(row => row.platform === platform)} handoff={handoff} incoming={incoming} refreshVersion={reload} reviewRequest={reviewRequests[platform]} onAuditCreated={onAuditCreated} onClearScope={onClearScope} onReleaseCreated={trackRelease} onRefresh={refresh} />)}
    <details className="sync-fold" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Scheduled updates &amp; history</summary>
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
  </section>;
}
