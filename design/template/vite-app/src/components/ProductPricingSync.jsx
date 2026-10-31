import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { canSyncPlatforms, publicationRunning, publicationMessage, syncProductChannels, samePlatforms, releasePlatforms, channelNames } from "./productPricingSyncFlow.js";
import "./EnterpriseReviewSection.css";

export function ProductPricingSync({ productId, token, roles, dirty, onChanged, onRequestBusy }) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [request, setRequest] = useState(""), [release, setRelease] = useState(null);
  const [connectionError, setConnectionError] = useState(""), [lastContact, setLastContact] = useState(null);
  const [now, setNow] = useState(Date.now()), [loading, setLoading] = useState(true);
  const [job, setJob] = useState(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState(['localline']);
  const mounted = useRef(false), callbacks = useRef({ onChanged, onRequestBusy });
  callbacks.current = { onChanged, onRequestBusy };
  const storageKey = `product-localline-sync:${productId}`;
  const saveJob = value => {
    setJob(value);
    try { value ? localStorage.setItem(storageKey, JSON.stringify(value)) : localStorage.removeItem(storageKey); } catch { /* Server receipts remain available. */ }
  };
  const get = async path => { const result = await adminGet(path, token); if (mounted.current) setLastContact(Date.now()); return result; };
  const post = (path, body) => {
    if (!mounted.current) throw new Error("Reopen Sync to continue.");
    return adminPost(path, token, body);
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const result = await get(`enterprise-pricing/products/${productId}/sync`);
        if (cancelled) return;
        setData(result);
        let saved;
        try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
        setJob(saved);
        const releaseId = saved?.releaseId || (!saved && (result.latestPricingReleaseId || result.latestLocalLineReleaseId));
        if (releaseId) {
          // Retain this receipt even if the progress connection fails. A retry
          // must recover the existing update before starting another one.
          if (!saved) saveJob({ releaseId, platforms:result.latestPricingReleasePlatforms?.length ? result.latestPricingReleasePlatforms : ['localline'] });
          const receipt = await get(`product-sync/releases/${releaseId}/progress`);
          if (!cancelled) { setRelease(receipt); setSelectedPlatforms(releasePlatforms(receipt));
            if (['completed', 'cancelled'].includes(receipt.status)) saveJob(null);
            else saveJob({...saved, releaseId, platforms:releasePlatforms(receipt)});
          }
        }
      } catch (e) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; mounted.current = false; callbacks.current.onRequestBusy?.(false); };
  }, [productId, token]);
  const running = publicationRunning(release);
  useEffect(() => {
    if (!running) return;
    let cancelled = false, timer;
    const poll = async () => {
      try {
        const next = await get(`product-sync/releases/${release.id}/progress`);
        if (cancelled) return;
        setRelease(next); setConnectionError("");
        if (!publicationRunning(next)) {
          if (next.status === 'completed') saveJob(null);
          callbacks.current.onChanged?.();
          const updated = await get(`enterprise-pricing/products/${productId}/sync`);
          if (!cancelled) setData(updated);
          return;
        }
      } catch (e) { if (!cancelled) setConnectionError(e.message); }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [release?.id, running, productId, token]);
  useEffect(() => {
    if (!request && !running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [Boolean(request), running]);

  async function sync(platforms) {
    if (request || running || dirty || !canSyncPlatforms(roles, platforms)) return;
    setSelectedPlatforms(platforms);
    setError(""); setConnectionError(""); setRequest("Connecting to the server…");
    callbacks.current.onRequestBusy?.(true);
    try {
      // Refresh local state before approving; the server freezes and revalidates it.
      const current = await get(`enterprise-pricing/products/${productId}/sync`);
      setData(current);
      let next;
      if (release && ['failed','partial','held'].includes(release.status) && !samePlatforms(platforms,releasePlatforms(release)))
        throw new Error(`Resolve or retry the previous ${channelNames(releasePlatforms(release))} sync first.`);
      if (release && ['failed', 'partial', 'held'].includes(release.status)) {
        if (release.actions?.some(a => a.status === 'held')) {
          setRequest('Rechecking the issue against your saved prices…');
          const audit = await post(`product-sync/releases/${release.id}/review`, {});
          const reviewed = await get(`product-sync/audits/${audit.id}`);
          const retryPlatforms = reviewed.options.platforms;
          if (retryPlatforms.some(platform => !platforms.includes(platform))) throw new Error('The new review includes an unselected destination. Reopen Sync to review it.');
          const resumed = { auditId: audit.id, revisionId: current.revisionId, platforms:retryPlatforms };
          saveJob(resumed);
          next = await syncProductChannels({ platforms:retryPlatforms, productId, data: current, resume: resumed, get, post, saveJob, progress: setRequest });
        } else {
          setRequest(`Retrying the saved ${channelNames(platforms)} update…`);
          next = await post(`product-sync/releases/${release.id}/retry`, { background: true });
        }
      } else {
        setRelease(null);
        next = await syncProductChannels({ platforms, productId, data: current, resume: job, get, post, saveJob, progress: setRequest });
      }
      if (!mounted.current) return;
      setRelease(next);
      if (next.status === 'completed') { saveJob(null); callbacks.current.onChanged?.(); }
    } catch (e) { if (mounted.current) { setError(e.message); callbacks.current.onChanged?.(); } }
    finally { if (mounted.current) { setRequest(""); callbacks.current.onRequestBusy?.(false); } }
  }
  const active = !!request || running;
  return <div className="product-pricing-sync">
    <div className="admin-actions product-sync-actions">
      {[
        {label:'Sync Local Line',platforms:['localline']},
        ...(data?.input?.squareEnabled ? [{label:'Sync Square',platforms:['square']},{label:'Sync Both',platforms:['localline','square']}] : [])
      ].map(choice => <button key={choice.label} type="button" className="button" onClick={() => sync(choice.platforms)}
        disabled={loading || active || dirty || data?.localOnly || !data || !canSyncPlatforms(roles,choice.platforms)
          || Boolean(job && !samePlatforms(job.platforms || ['localline'],choice.platforms))}>
        {active && samePlatforms(selectedPlatforms,choice.platforms) ? 'Syncing…' : job && samePlatforms(job.platforms || ['localline'],choice.platforms) ? `Resume ${channelNames(choice.platforms)} sync` : choice.label}
      </button>)}
      {data?.sale?.discountBp > 0 && <span>{data.sale.discountBp / 100}% Local Line sale</span>}
    </div>
    {loading && <p role="status">Loading sync status…</p>}
    {dirty && <p>Save your changes before syncing.</p>}
    {!canSyncPlatforms(roles,['localline']) && !canSyncPlatforms(roles,['square']) && <p>A Pricing Publisher with the selected channel’s Push permission can sync this product.</p>}
    {data?.localOnly && <p>Local test mode: remote updates are disabled.</p>}
    {(request || release) && <div className="product-connection-progress">
      <strong role="status" aria-live="polite">{request || publicationMessage(release)}</strong>
      {active && <progress aria-label="Synchronizing channel prices" />}
      {request ? <p>Keep this window open until we confirm the server has received your update.</p>
        : running ? <p>You can close this window. The server will finish the update. Reopen Sync to see the result.</p>
        : <p>You can close this window.{release?.finishedAt && ` Last sync: ${new Date(release.finishedAt).toLocaleString()}.`}</p>}
      {lastContact && active && <p className="small">Last server response {Math.max(0, Math.floor((now - lastContact) / 1000))} seconds ago.</p>}
      {release?.status === 'completed' && !request && <p className="small">This confirms the saved sync above. If you have edited prices or sales since then, sync again.</p>}
    </div>}
    {error && <p role="alert">Sync could not finish: {error}</p>}
    {connectionError && <p role="alert">Connection interrupted; retrying the status check. The update may still be running. {connectionError}</p>}
  </div>;
}
