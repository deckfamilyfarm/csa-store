import React from "react";

export function PricingSyncStatus({ row, onReview }) {
  const channels = row.sync?.channels || [{ platform: "localline", label: "LL", state: "attention", reason: "Waiting for channel comparison" },
    ...(row.input?.squareEnabled ? [{ platform: "square", label: "Sq", state: "attention", reason: "Waiting for channel comparison" }] : [])];
  const pending = channels.filter(channel => channel.state !== "matched");
  const matching = row.sync?.basis === "imported" ? "Prices match imported channel data; live synchronization has not been verified" : "Prices match the latest stored channel check";
  const description = pending.length ? pending.map(channel => `${channel.platform === "square" ? "Square" : "Local Line"}: ${channel.reason}`).join(". ") : matching;
  return <button type="button" className="pricing-sync-status" onClick={onReview} title={description}
    aria-label={`${row.name}: ${description}. Open product Sync`}>
    {pending.length ? pending.map(channel => <span className="pricing-sync-badge" aria-hidden="true" key={channel.platform}>{channel.label}</span>)
      : <span className="pricing-sync-check" aria-hidden="true">✓</span>}
  </button>;
}
