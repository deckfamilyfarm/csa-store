import React, { useEffect, useState } from "react";
import { adminGet } from "../adminApi.js";
import { pricingWarningDetails } from "./pricingWarningDetails.js";

export function ProductPricingWarnings({ row, token, onOpenSync }) {
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    adminGet(`enterprise-pricing/review?productId=${row.id}`, token).then(rows => {
      if (!cancelled) setReview(rows.find(item => Number(item.productId) === Number(row.id)) || null);
    }).catch(error => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.id, token, retry]);
  const details = pricingWarningDetails(review, row);
  const localLineMatched = row.sync?.channels?.some(channel => channel.platform === 'localline' && channel.state === 'matched');
  return <>
    {localLineMatched && <p>{row.publications?.some(p => p.platform === 'localline' && p.status === 'verified')
      ? 'Local Line sync succeeded.' : 'Local Line prices match the latest stored check.'}</p>}
    {!!row.sourceEvidence?.warnings?.length && <ul>{row.sourceEvidence.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {loading ? <p role="status">Loading the saved server-check details…</p> : error ?
      <p role="alert">Could not load the warning details: {error} <button className="button alt" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
      : details.length ? <ul>{details.map((detail, index) => <li key={index}><strong>{detail.label}:</strong> {detail.message}</li>)}</ul>
      : <p>{review?.check?.status === "running" ? "The server is still checking this product. Open Sync to follow progress."
        : review?.check?.actions?.some(action => ["queued", "running"].includes(action.publicationStatus)) ? "An update is running on the server. Open Sync to follow progress."
        : review?.check?.status === "completed" && review.check.actions?.length ? "No unresolved issues were found in this check."
        : "No detailed reason was saved with this status. Open Sync and check server prices to get the current explanation."}</p>}
    {review?.status === "rejected" && <p>The pricing proposal was rejected. Open Sync to review the saved inputs.</p>}
    {!localLineMatched && <button className="button alt" type="button" onClick={onOpenSync}>Open this product’s Sync</button>}
  </>;
}
