import React from "react";
import { squareSyncAttempted } from './pricingWarningDetails.js';

export function PricingSyncStatus({ row, onReview }) {
  const channels = row.sync?.channels || [{ platform: "localline", label: "LL", state: "attention", reason: "Waiting for channel comparison" },
    ...(row.input?.squareEnabled ? [{ platform: "square", label: "Sq", state: "attention", reason: "Waiting for channel comparison" }] : [])];
  const description = channels.map(channel => `${channel.platform === "square" ? "Square" : "Local Line"}: ${
    channel.state === 'matched' ? row.sync?.basis === 'imported' ? 'matches imported prices; live sync not verified' : 'prices match the latest channel check'
      : channel.platform === 'square' && !squareSyncAttempted(row) ? 'not synced yet' : channel.reason}`).join('. ');
  return <button type="button" className="pricing-sync-status" onClick={onReview} title={description}
    aria-label={`${row.name}: ${description}. Open product Sync`}>
    {channels.map(channel => <span className={`pricing-sync-badge${channel.state === 'matched' ? ' is-matched' : ''}`} aria-hidden="true" key={channel.platform}>
      {channel.label}{channel.state === 'matched' ? ' ✓' : ''}
    </span>)}
  </button>;
}
