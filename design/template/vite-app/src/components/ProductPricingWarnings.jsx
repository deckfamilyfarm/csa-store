import React, { useEffect, useState } from "react";
import { adminGet } from "../adminApi.js";
import { pricingWarningDetails, pricingChannelStatuses } from "./pricingWarningDetails.js";

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
  const statuses = pricingChannelStatuses(row, review);
  const localLineMatched = row.sync?.channels?.some(channel => channel.platform === 'localline' && channel.state === 'matched');
  return <>
    {statuses.map(status => <p key={status.platform}><strong>{status.platform === 'square' ? 'Square Status:' : 'Local Line Status:'}</strong>{' '}{status.message}</p>)}
    {!!row.sourceEvidence?.warnings?.length && <ul>{row.sourceEvidence.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {loading ? <p role="status">Loading the saved server-check details…</p> : error ?
      <p role="alert">Could not load the warning details: {error} <button className="button alt" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
      : details.filter(detail => detail.label === 'Server check').map((detail, index) => <p role="alert" key={index}>{detail.message}</p>)}
    {review?.status === "rejected" && <p>The pricing proposal was rejected. Open Sync to review the saved inputs.</p>}
    {!localLineMatched && <button className="button alt" type="button" onClick={onOpenSync}>Open this product’s Sync</button>}
  </>;
}
