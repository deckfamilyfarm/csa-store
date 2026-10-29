import React, { useEffect, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { useViewportRows } from "./useViewportRows.js";
import "./EnterpriseReviewSection.css";
import { LocalPricingSyncReview } from "./LocalPricingSyncReview.jsx";

const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;

export function EnterpriseReviewSection({ token, roles = [] }) {
  const [revisions, setRevisions] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(null);
  const [checks, setChecks] = useState({});
  const [release, setRelease] = useState(null);
  const [localOnly, setLocalOnly] = useState(null);
  const reviewScrollRef = useViewportRows(16, localOnly === false);
  const canApprove = roles.some(role => ["admin", "pricing_admin", "pricing_publisher"].includes(role));
  const hasGrant = role => roles.includes("admin") || roles.includes(role);
  useEffect(() => {
    let cancelled = false;
    adminGet("enterprise-pricing/review", token).then(rows => { if (!cancelled) setRevisions(rows); })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    adminGet("enterprise-promotions", token).then(rows => { if (!cancelled) setPromotions(rows); })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    adminGet("enterprise-pricing/summary", token).then(value => { if (!cancelled) setLocalOnly(value.localOnly === true); })
      .catch(error => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [token, busy]);
  async function approve(revision) {
    setBusy(revision.id);
    try {
      const result = await adminPost(`enterprise-pricing/revisions/${revision.id}/approve`, token, {});
      setMessage(result.destinations.length ? `${revision.productName}: approved for ${result.destinations.join(" and ")}; publication pending.` : `${revision.productName}: approved locally.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  async function reject(revision) {
    const reason = window.prompt(`Why reject ${revision.productName}?`);
    if (!reason?.trim()) return;
    setBusy(revision.id);
    try { await adminPost(`enterprise-pricing/revisions/${revision.id}/reject`, token, { reason }); setMessage(`${revision.productName}: proposal rejected.`); }
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
    setBusy(revision.id);
    try {
      const platforms = revision.input.squareEnabled ? ["localline", "square"] : ["localline"];
      const audit = await adminPost("product-sync/audits", token, {
        platforms, productIds: [revision.productId], productScope: "selected", vendorGroup: "all",
        enterpriseRevisionId: revision.id, incoming: false
      });
      setChecks(previous => ({ ...previous, [revision.id]: { auditId: audit.id, status: audit.status, actions: [] } }));
      setMessage("Checking current Square and Local Line values. No prices are being published.");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  }
  useEffect(() => {
    const running = Object.entries(checks).filter(([, check]) => check.status === "running");
    if (!running.length) return undefined;
    const timer = setInterval(async () => {
      for (const [revisionId, check] of running) {
        try {
          const audit = await adminGet(`product-sync/audits/${check.auditId}`, token);
          if (audit?.status === "running") continue;
          const result = await adminGet(`product-sync/audits/${check.auditId}/actions?direction=outgoing&pageSize=100`, token);
          setChecks(previous => ({ ...previous, [revisionId]: { ...check, status: audit.status, actions: result.rows || [], error: audit.error } }));
          setBusy(null);
        } catch (error) { setMessage(error.message); }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [checks, token]);
  useEffect(() => {
    if (!release || ["completed", "partial", "held", "failed", "cancelled"].includes(release.status)) return undefined;
    const timer = setInterval(async () => {
      try {
        const result = await adminGet(`product-sync/releases/${release.id}/progress`, token);
        setRelease(result);
        if (["completed", "partial", "held", "failed"].includes(result.status)) {
          setMessage(`Publication ${result.status}. Review each destination below before retrying.`);
          setBusy(null);
        }
      } catch (error) { setMessage(error.message); }
    }, 2000);
    return () => clearInterval(timer);
  }, [release, token]);
  async function publish(revision, check) {
    const changed = check.actions.filter(action => action.status === "changed");
    if (!changed.length) { setMessage("No remote prices need publication. Check whether this revision is fully verified."); return; }
    setBusy(revision.id);
    try {
      const result = await adminPost("product-sync/releases", token, {
        auditId: check.auditId, actionIds: check.actions.filter(action => ["changed", "synced"].includes(action.status)).map(action => action.id),
        name: `Enterprise pricing · ${revision.productName} · revision ${revision.id}`, background: true
      });
      setRelease(result);
      setMessage("Publishing frozen, approved prices and verifying both destinations.");
    } catch (error) { setMessage(error.message); setBusy(null); }
  }
  async function retryPublication(revision, releaseId) {
    setBusy(revision.id);
    try {
      const result = await adminPost(`product-sync/releases/${releaseId}/retry`, token, { background: true });
      setRelease(result);
      setMessage(`Retrying publication ${releaseId} using its saved approval and request receipts.`);
    } catch (error) { setMessage(error.message); setBusy(null); }
  }
  const showActionPrice = action => {
    if (action.platform === "square") return `${action.display?.current?.price ?? "—"} → ${action.display?.proposed?.price ?? "—"} per ${action.display?.proposed?.sellingUnit || "unit"}`;
    const packages = action.payload?.packages || [];
    return packages.length ? packages.map(pkg => `${pkg.name || pkg.id}: ${money((pkg.price_list_entries?.[0]?.adjustment_value || 0) * 100)}`).join(" · ") : "Review package prices";
  };
  return <section className="card enterprise-review-page">
    <div className="admin-section-heading"><div><h2>Review &amp; Publish</h2>{!localOnly && <p>Review saved price changes before synchronizing Square and Local Line.</p>}</div></div>
    {message && <p role="status">{message}</p>}
    {localOnly && <LocalPricingSyncReview revisions={revisions} />}
    <div ref={reviewScrollRef} className={localOnly === false ? "review-publications-scroll" : undefined}>
    {!localOnly && !revisions.length && <p>No pricing changes are waiting for review.</p>}
    {!localOnly && revisions.map(revision => <div className="card" key={revision.id} style={{ marginBottom: 16 }}>
      <h3>{revision.productName} <small>#{revision.id} · {revision.status}</small></h3>
      <p className="small">{revision.vendorName} · Edited by user {revision.editorId} · Settings version {revision.settingsVersionId}</p>
      {revision.publications?.length > 0 && <p className="small">{revision.publications.map(item => `${item.platform}: ${item.status}${item.releaseId ? ` (release ${item.releaseId})` : ""}`).join(" · ")}</p>}
      {["approved", "partial"].includes(revision.status) && canApprove && [...new Set((revision.publications || []).filter(item => item.releaseId && ["partial", "failed", "publishing"].includes(item.status)).map(item => item.releaseId))].map(id => <button className="button alt" type="button" key={id} disabled={busy === revision.id} onClick={() => retryPublication(revision, id)}>Retry publication {id}</button>)}
      <div className="table-wrap"><table className="admin-table"><thead><tr><th>Destination</th><th>Proposed regular</th><th>Proposed sale</th><th>Unit / package</th></tr></thead><tbody>
        {revision.input.squareEnabled && <tr><td>Square</td><td>{money(revision.output.squareUnitCents)}</td><td>Separate automatic discount</td><td>per {revision.input.pricingUnit}</td></tr>}
        {revision.output.packages.map(pkg => <tr key={pkg.packageId}><td>Local Line · package {pkg.packageId}</td><td>{money(pkg.localLineRegularCents)}</td><td>{money(pkg.localLineSaleCents)}</td><td>{pkg.quantity ? `${pkg.quantity} each` : `${(pkg.averageWeightMilliPounds / 1000).toFixed(3)} lb (${pkg.weightSource})`}</td></tr>)}
        {revision.output.wholesale?.map(row => <tr key={`wholesale-${row.sellingEnterpriseId}`}><td>Wholesale · enterprise {row.sellingEnterpriseId}</td><td>{money(row.priceCents)}</td><td>—</td><td>per {revision.input.pricingUnit}</td></tr>)}
      </tbody></table></div>
      {revision.input.overrideNote && <p className="small">Override note: {revision.input.overrideNote}</p>}
      {revision.status === "pending" && canApprove && localOnly === false && <div className="admin-actions"><button className="button" type="button" disabled={busy === revision.id} onClick={() => approve(revision)}>Approve revision</button><button className="button alt" type="button" disabled={busy === revision.id} onClick={() => reject(revision)}>Reject</button></div>}
      {!localOnly && ["approved", "partial"].includes(revision.status) && <>
        <button className="button alt" type="button" disabled={busy === revision.id} onClick={() => checkDestinations(revision)}>Check destinations</button>
        {checks[revision.id] && <div><p className="small">Audit {checks[revision.id].auditId}: {checks[revision.id].status}{checks[revision.id].error ? ` · ${checks[revision.id].error}` : ""}</p>
          {checks[revision.id].actions.map(action => <p className="small" key={action.id}><strong>{action.platform === "square" ? "Square" : "Local Line"}</strong> · {action.packageName || "Product"} · {action.status}: {showActionPrice(action)} {action.message}</p>)}
          {checks[revision.id].actions.length > 0 && checks[revision.id].actions.every(action => ["changed", "synced"].includes(action.status)) &&
            <button className="button" type="button" disabled={busy === revision.id || release?.status === "queued" || release?.status === "running"} onClick={() => publish(revision, checks[revision.id])}>Publish approved values</button>}
        </div>}
      </>}
    </div>)}
    <details className="review-sales"><summary>Sales ({promotions.length})</summary>
    {!promotions.length && <p>No sale proposals yet.</p>}
    {promotions.map(promotion => <div className="card" key={promotion.id} style={{ marginBottom: 16 }}>
      <h4>{promotion.input.name || `Sale ${promotion.id}`} <small>#{promotion.id} · {promotion.status}</small></h4>
      <p className="small">{(promotion.input.discountBp / 100).toFixed(2)}% off · {new Date(promotion.input.startAt).toLocaleString()} to {new Date(promotion.input.endAt).toLocaleString()} · {promotion.input.channels.join(" and ")} · edited by user {promotion.editorId}</p>
      {promotion.output.localLinePrices.map(row => <p className="small" key={row.packageId}>Package {row.packageId}: {money(row.regularCents)} → {money(row.saleCents)} across all four baskets</p>)}
      <p className="small">Square: {promotion.squareStatus || "awaiting approval"} · Local Line: {promotion.localLineStatus || "awaiting approval"}{promotion.error ? ` · ${promotion.error}` : ""}</p>
      {promotion.status === "pending" && canApprove && <button className="button" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => approvePromotion(promotion)}>Approve sale</button>}
      {["approved", "scheduled", "active", "partial"].includes(promotion.status) && canApprove && (!promotion.input.channels.includes("localline") || hasGrant("localline_push")) && (!promotion.input.channels.includes("square") || hasGrant("square_push")) && <button className="button alt" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => publishPromotion(promotion)}>Publish / verify sale</button>}
      {["pending", "approved", "scheduled", "active", "partial", "cancelling"].includes(promotion.status) && canApprove && (!promotion.input.channels.includes("localline") || hasGrant("localline_push")) && (!promotion.input.channels.includes("square") || hasGrant("square_push")) && <button className="button alt" type="button" disabled={busy === `sale-${promotion.id}`} onClick={() => cancelPromotion(promotion)}>Cancel sale</button>}
    </div>)}
    </details>
    {release && <div className="card"><h3>Publication {release.id}: {release.status}</h3>{(release.actions || []).map(action => <p key={action.id} className="small">{action.platform}: {action.status} · {action.message}</p>)}</div>}
    </div>
  </section>;
}
