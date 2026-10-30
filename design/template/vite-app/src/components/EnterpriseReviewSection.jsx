import { ProductConnectionProgress } from "./ProductConnectionProgress.jsx";
import { publishReviewedRevision } from "./enterpriseReviewTable.js";
import { EnterpriseReviewTable } from "./EnterpriseReviewTable.jsx";
import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { useViewportRows } from "./useViewportRows.js";
import "./EnterpriseReviewSection.css";
import { LocalPricingSyncReview } from "./LocalPricingSyncReview.jsx";
import { Comparison } from "./ProductSyncReview.jsx";
import { EnterpriseBundles } from './EnterpriseBundles.jsx';

const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;

export function EnterpriseReviewSection(props) {
  return props.embedded ? <EnterpriseReviewLegacy {...props} />
    : <EnterpriseReviewTable {...props} roles={props.roles || []} salesContent={<EnterpriseReviewLegacy {...props} salesOnly />} />;
}

function EnterpriseReviewLegacy({ token, roles = [], productId = null, embedded = false, onChecked, onPublished, onRequestBusy, salesOnly = false }) {
  const [revisions, setRevisions] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(null);
  const [checks, setChecks] = useState({});
  const [release, setRelease] = useState(null);
  const [request, setRequest] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [lastContact, setLastContact] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onChecked, onPublished });
  callbacks.current = { onChecked, onPublished };
  const submitting = useRef(false);
  const beginRequest = (revision, label) => {
    if (submitting.current) return false;
    submitting.current = true; setBusy(revision.id); setMessage(""); setConnectionError("");
    setRequest({ label, startedAt: new Date().toISOString() }); return true;
  };
  const endRequest = () => { submitting.current = false; setRequest(null); setBusy(null); };
  useEffect(() => { onRequestBusy?.(!!request); }, [!!request, onRequestBusy]);
  useEffect(() => {
    if (!request) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [!!request]);
  const [localOnly, setLocalOnly] = useState(null);
  const reviewScrollRef = useViewportRows(16, localOnly === false && !embedded);
  const canApprove = roles.some(role => ["admin", "pricing_admin", "pricing_publisher"].includes(role));
  const hasGrant = role => roles.includes("admin") || roles.includes(role);
  useEffect(() => {
    let cancelled = false;
    if (!salesOnly) adminGet(`enterprise-pricing/review${productId ? `?productId=${productId}` : ""}`, token).then(rows => { if (!cancelled) { setRevisions(rows); setChecks(previous => ({ ...previous, ...Object.fromEntries(rows.filter(row => row.check).map(row => [row.id, row.check])) })); } })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    if (!embedded) adminGet("enterprise-promotions", token).then(rows => { if (!cancelled) setPromotions(rows); })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    adminGet("enterprise-pricing/summary", token).then(value => { if (!cancelled) setLocalOnly(value.localOnly === true); })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [token, busy, productId, embedded, salesOnly, refresh]);
  async function approve(revision) {
    if (!beginRequest(revision, "Saving channel approval on the server…")) return;
    try {
      const result = await adminPost(`enterprise-pricing/revisions/${revision.id}/approve`, token, {});
      setMessage(result.destinations.length ? `${revision.productName}: approved for ${result.destinations.join(" and ")}; publication pending.` : `${revision.productName}: approved locally.`);
    } catch (error) { setMessage(error.message); }
    finally { endRequest(); }
  }
  async function reject(revision) {
    const reason = window.prompt(`Why reject ${revision.productName}?`);
    if (!reason?.trim()) return;
    setBusy(revision.id);
    try { await adminPost(`enterprise-pricing/revisions/${revision.id}/reject`, token, { reason }); setMessage(`${revision.productName}: channel synchronization declined; saved local prices are unchanged.`); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function approvePromotion(promotion) {
    setBusy(`sale-${promotion.id}`);
    try {
      await adminPost(`enterprise-promotions/${promotion.id}/approve`, token, {});
      setMessage(`Sale ${promotion.id} approved. Publication remains pending.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function publishPromotion(promotion) {
    setBusy(`sale-${promotion.id}`);
    try {
      const result = await adminPost(`enterprise-promotions/${promotion.id}/publish`, token, {});
      setMessage(`Sale ${promotion.id}: ${result.status}. Square: ${result.squareStatus}; Local Line: ${result.localLineStatus}.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function cancelPromotion(promotion) {
    setBusy(`sale-${promotion.id}`);
    try {
      const result = await adminPost(`enterprise-promotions/${promotion.id}/cancel`, token, {});
      setMessage(`Sale ${promotion.id}: ${result.status}.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function checkDestinations(revision) {
    if (!beginRequest(revision, "Connecting to the server to start a price check…")) return;
    setRelease(null);
    try {
      const platforms = revision.input.squareEnabled ? ["localline", "square"] : ["localline"];
      const audit = await adminPost("product-sync/audits", token, {
        platforms, productIds: [revision.productId], productScope: "selected", vendorGroup: "all",
        enterpriseRevisionId: revision.id, incoming: false
      });
      // Even a fast completed check still needs its detailed results loaded.
      setChecks(previous => ({ ...previous, [revision.id]: { ...audit, auditId: audit.id, status: "running", actions: [] } }));
      setLastContact(Date.now());
    } catch (error) { setMessage(error.message); }
    finally { endRequest(); }
  }
  useEffect(() => {
    const running = Object.entries(checks).filter(([, check]) => check.status === "running");
    if (!running.length) return;
    let cancelled = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        for (const [revisionId, check] of running) {
          const audit = await adminGet(`product-sync/audits/${check.auditId}`, token);
          if (!audit) throw new Error("The server could not find this check. Reopen Sync to recover its status.");
          let actions = check.actions;
          if (audit.status !== "running") actions = (await adminGet(`product-sync/audits/${check.auditId}/actions?direction=outgoing&pageSize=100`, token)).rows || [];
          if (cancelled) return;
          setLastContact(Date.now()); setConnectionError("");
          setChecks(previous => ({ ...previous, [revisionId]: { ...check, ...audit, actions } }));
          if (audit.status !== "running") callbacks.current.onChecked?.(actions);
        }
      } catch (error) { if (!cancelled) setConnectionError(error.message); }
      finally { polling = false; }
    };
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [checks, token]);
  // Restore saved publications after reopening the product, including work that
  // outlived the browser. Never submit a replacement job just to get progress.
  useEffect(() => {
    if (request || release) return;
    const actions = Object.values(checks).flatMap(check => check.actions || []);
    const saved = actions.filter(action => action.releaseId).sort((a, b) => Number(b.releaseId) - Number(a.releaseId))[0];
    if (!saved) return;
    setRelease({ id: saved.releaseId, status: saved.publicationStatus || "queued",
      actions: actions.filter(action => action.releaseId === saved.releaseId).map(action => ({ ...action, status: action.releaseStatus, message: action.releaseMessage })), restoring: true });
  }, [checks, request, release]);
  useEffect(() => {
    if (!release || (!release.restoring && !["queued", "running"].includes(release.status))) return;
    let cancelled = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await adminGet(`product-sync/releases/${release.id}/progress`, token);
        if (cancelled) return;
        setRelease(result); setLastContact(Date.now()); setConnectionError("");
        if (!["queued", "running"].includes(result.status)) {
          setRefresh(value => value + 1);
          callbacks.current.onPublished?.();
        }
      } catch (error) { if (!cancelled) setConnectionError(error.message); }
      finally { polling = false; }
    };
    if (release.restoring) poll();
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [release, token]);
  async function publish(revision, check) {
    if (embedded && !window.confirm(`Publish the reviewed prices and any listed catalog changes for ${revision.productName} to ${revision.input.squareEnabled ? "Local Line and Square" : "Local Line"}?`)) return;
    if (!beginRequest(revision, "Sending the approved update to the server…")) return;
    try {
      const result = await publishReviewedRevision({ ...revision, check }, {
        get: path => adminGet(path, token), post: (path, body) => adminPost(path, token, body)
      });
      setRelease({ ...result, restoring: true }); setLastContact(Date.now());
    } catch (error) { setMessage(`Could not confirm submission: ${error.message}. Reopen Sync to recover any saved publication before retrying.`); setRefresh(value => value + 1); }
    finally { endRequest(); }
  }
  async function retryPublication(revision, releaseId) {
    if (!beginRequest(revision, "Asking the server to resume the saved publication…")) return;
    try {
      const result = await adminPost(`product-sync/releases/${releaseId}/retry`, token, { background: true });
      setRelease({ ...result, restoring: true }); setLastContact(Date.now());
    } catch (error) { setMessage(error.message); setRefresh(value => value + 1); }
    finally { endRequest(); }
  }
  const checking = Object.values(checks).find(check => check.status === "running");
  const savedPublishing = Object.values(checks).some(check => check.actions?.some(action => ["queued", "running"].includes(action.publicationStatus)));
  const workActive = !!request || !!checking || ["queued", "running"].includes(release?.status) || savedPublishing;
  const showActionPrice = action => {
    if (action.platform === "square") return `${action.display?.current?.price ?? "—"} → ${action.display?.proposed?.price ?? "—"} per ${action.display?.proposed?.sellingUnit || "unit"}`;
    const packages = action.payload?.packages || [];
    return packages.length ? packages.map(pkg => `${pkg.name || pkg.id}: ${money((pkg.price_list_entries?.[0]?.adjustment_value || 0) * 100)}`).join(" · ") : "Review package prices";
  };
  return <section className={embedded ? "product-sync-actions" : "card enterprise-review-page"}>
    {!embedded && !salesOnly && <div className="admin-section-heading"><div><h2>Review &amp; Publish</h2>{!localOnly && <p>Review saved price changes before synchronizing Square and Local Line.</p>}</div></div>}
    {message && <p role="status">{message}</p>}
    <ProductConnectionProgress request={request} check={checking || Object.values(checks).at(-1)} release={release}
      connectionError={connectionError} lastContact={lastContact} />
    {!embedded && !salesOnly && <details className="review-bundles"><summary>Bundles · Local Line</summary><EnterpriseBundles token={token} roles={roles} review /></details>}
    {localOnly && !salesOnly && <LocalPricingSyncReview revisions={revisions} />}
    <div ref={reviewScrollRef} className={localOnly === false && !embedded ? "review-publications-scroll" : undefined}>
    {!salesOnly && !localOnly && !revisions.length && <p>No pricing changes are waiting for review.</p>}
    {!localOnly && revisions.map(revision => <div className="card" key={revision.id} style={{ marginBottom: 16 }}>
      {!embedded && <h3>{revision.productName} <small>#{revision.id} · {revision.status}</small></h3>}
      <p className="small">{revision.vendorName} · Edited by user {revision.editorId} · Settings version {revision.settingsVersionId}</p>
      {revision.publications?.length > 0 && <p className="small">{revision.publications.map(item => `${item.platform}: ${item.status}${item.releaseId ? ` (release ${item.releaseId})` : ""}`).join(" · ")}</p>}
      {["approved", "partial", "active"].includes(revision.status) && canApprove && [...new Set((revision.publications || []).filter(item => item.releaseId && ["partial", "failed", "held"].includes(item.status)).map(item => item.releaseId))].map(id => <button className="button alt" type="button" key={id} disabled={!!busy || workActive} onClick={() => retryPublication(revision, id)}>Retry publication {id}</button>)}
      {!embedded && <div className="table-wrap"><table className="admin-table"><thead><tr><th>Destination</th><th>Proposed regular</th><th>Proposed sale</th><th>Unit / package</th></tr></thead><tbody>
        {revision.input.squareEnabled && <tr><td>Square</td><td>{money(revision.output.squareUnitCents)}</td><td>Separate automatic discount</td><td>per {revision.input.pricingUnit}</td></tr>}
        {revision.output.packages.map(pkg => <tr key={pkg.packageId}><td>Local Line · package {pkg.packageId}</td><td>{money(pkg.localLineRegularCents)}</td><td>{money(pkg.localLineSaleCents)}</td><td>{pkg.quantity ? `${pkg.quantity} each` : `${(pkg.averageWeightMilliPounds / 1000).toFixed(3)} lb (${pkg.weightSource})`}</td></tr>)}
        {revision.output.wholesale?.map(row => <tr key={`wholesale-${row.sellingEnterpriseId}`}><td>Wholesale · enterprise {row.sellingEnterpriseId}</td><td>{money(row.priceCents)}</td><td>—</td><td>per {revision.input.pricingUnit}</td></tr>)}
      </tbody></table></div>}
      {revision.input.overrideNote && <p className="small">Override note: {revision.input.overrideNote}</p>}
      {["pending", "local-preview"].includes(revision.status) && canApprove && localOnly === false && <div className="admin-actions"><button className="button" type="button" disabled={busy === revision.id} onClick={() => approve(revision)}>Approve channel sync</button><button className="button alt" type="button" disabled={busy === revision.id} onClick={() => reject(revision)}>Reject</button></div>}
      {embedded && ["pending", "local-preview"].includes(revision.status) && <p className="small">A pricing publisher must approve the saved inputs before checking and updating channel prices.</p>}
      {!localOnly && ["approved", "partial", "active"].includes(revision.status) && canApprove && <>
        {!workActive && <button className="button alt" type="button" disabled={!!busy} onClick={() => checkDestinations(revision)}>{embedded ? "Check server prices" : "Check destinations"}</button>}
        {checks[revision.id] && <div><p className="small">Audit {checks[revision.id].auditId}: {checks[revision.id].status}{checks[revision.id].error ? ` · ${checks[revision.id].error}` : ""}</p>
          {!embedded && checks[revision.id].actions.map(action => <p className="small" key={action.id}><strong>{action.platform === "square" ? "Square" : "Local Line"}</strong> · {action.packageName || "Product"} · {action.status}: {showActionPrice(action)} {action.message}</p>)}
          {embedded && checks[revision.id].actions.map(action => <details key={action.id} open><summary>{action.platform === "square" ? "Square" : "Local Line"}: changes to publish</summary><Comparison action={action} /></details>)}
          {checks[revision.id].actions.some(action => action.status === "changed") && checks[revision.id].actions.every(action => !action.released && ["changed", "synced"].includes(action.status)) &&
            <button className="button" type="button" disabled={!!busy || workActive || !hasGrant("localline_push") || (revision.input.squareEnabled && !hasGrant("square_push"))} onClick={() => publish(revision, checks[revision.id])}>{embedded ? `Update ${revision.input.squareEnabled ? "LL & Square" : "Local Line"} prices` : "Publish approved values"}</button>}
        </div>}
      </>}
    </div>)}
    {!embedded && <details className="review-sales" open={salesOnly || undefined}><summary>Sales ({promotions.length})</summary>
    {!promotions.length && <p>No sale proposals yet.</p>}
    {promotions.map(promotion => <div className="card" key={promotion.id} style={{ marginBottom: 16 }}>
      <h4>{promotion.input.name || `Sale ${promotion.id}`} <small>#{promotion.id} · {promotion.status}</small></h4>
      <p className="small">{promotion.input.endSale ? "Restore regular prices" : `${(promotion.input.discountBp / 100).toFixed(2)}% off`} · {new Date(promotion.input.startAt).toLocaleString()} · {promotion.input.endAt ? `Ends ${new Date(promotion.input.endAt).toLocaleString()}` : "Until turned off"} · {promotion.input.channels.join(" and ")} · edited by user {promotion.editorId}</p>
      {promotion.output.localLinePrices.map(row => <p className="small" key={row.packageId}>Package {row.packageId}: {money(row.regularCents)} → {money(row.saleCents)} across all three active baskets</p>)}
      <p className="small">Square: {promotion.squareStatus || "awaiting approval"} · Local Line: {promotion.localLineStatus || "awaiting approval"}{promotion.error ? ` · ${promotion.error}` : ""}</p>
      {promotion.status === "pending" && canApprove && <button className="button" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => approvePromotion(promotion)}>Approve sale</button>}
      {["approved", "scheduled", "active", "partial"].includes(promotion.status) && canApprove && (!promotion.input.channels.includes("localline") || hasGrant("localline_push")) && (!promotion.input.channels.includes("square") || hasGrant("square_push")) && <button className="button alt" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => publishPromotion(promotion)}>Publish / verify sale</button>}
      {!promotion.input.localProductId && ["pending", "approved", "scheduled", "active", "partial", "cancelling"].includes(promotion.status) && canApprove && (!promotion.input.channels.includes("localline") || hasGrant("localline_push")) && (!promotion.input.channels.includes("square") || hasGrant("square_push")) && <button className="button alt" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => cancelPromotion(promotion)}>{promotion.status === "pending" ? "Discard proposal" : promotion.status === "cancelling" ? "Retry turning off sale" : "Turn off sale"}</button>}
    </div>)}
    </details>}
    </div>
  </section>;
}
