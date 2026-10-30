import React, { useEffect, useState } from "react";
import { elapsedText, releaseProgress } from "./productSyncView.js";

const platformName = platform => platform === "square" ? "Square" : "Local Line";
export function ProductConnectionProgress({ request, check, release, connectionError, lastContact }) {
  const [now, setNow] = useState(Date.now());
  const active = !!request || check?.status === "running" || ["queued", "running"].includes(release?.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!request && !check && !release) return null;
  const progress = release ? releaseProgress(release) : null;
  const started = request?.startedAt || release?.startedAt || release?.createdAt || check?.createdAt;
  const checking = !release && check?.status === "running";
  return <div className="product-connection-progress" aria-label="Server connection progress">
    <div role="status" aria-live="polite">
      <strong>{request?.label || (release ? release.status === "queued" ? "Server queued your update"
        : release.status === "running" ? "Updating and verifying channel prices"
        : release.status === "completed" ? "Channel update confirmed" : "Channel update needs review"
        : checking ? "Checking current channel prices" : check?.status === "completed" ? "Server price check complete" : "Server price check needs review")}</strong>
      <p>{request ? "Keep this window open until the server confirms it received your request."
        : active ? "It’s OK to close this window. The server continues the saved job. Reopen this product’s Sync section to follow progress."
        : "It’s OK to close this window. The result is saved on the server."}</p>
    </div>
    {started && <p className="small">{elapsedText(started, active ? now : release?.finishedAt || check?.finishedAt || now)} elapsed
      {lastContact ? ` · Last server response ${elapsedText(lastContact, now)} ago` : ""}</p>}
    {progress && <>
      <progress max={Math.max(progress.total, 1)} value={progress.processed} aria-label="Channel updates processed" />
      <p>{progress.completed} of {progress.total} updates confirmed{progress.failed ? ` · ${progress.failed} failed` : ""}{progress.held ? ` · ${progress.held} need review` : ""}</p>
      {release.status === "queued" && <p>Waiting for the server’s publishing worker or an earlier update to finish.</p>}
      <ul>{(release.actions || []).map(action => <li key={action.id}><strong>{platformName(action.platform)}{action.packageName ? ` · ${action.packageName}` : ""}:</strong>{" "}
        {action.message || ({ pending: "Waiting to start", working: "Processing update", completed: "Confirmed on the channel", failed: "Update failed", held: "Needs review", cancelled: "Cancelled" }[action.status] || action.status)}</li>)}</ul>
      {["partial", "held", "failed"].includes(release.status) && <p>Review the destination messages before retrying this saved publication.</p>}
    </>}
    {checking && <><progress aria-label="Checking channel prices" /><p>No prices are being changed.</p>
      {(check.overview || []).map(row => <p key={`${row.platform}-${row.direction}`}>{platformName(row.platform)}: compared {row.productCount} product(s).</p>)}</>}
    {check?.error && !release && <p role="alert">{check.error}</p>}
    {active && started && now - Date.parse(started) > 60000 && <p className="small">This is taking longer than a minute. The latest confirmed server status is shown above.</p>}
    {connectionError && <p role="alert">Progress connection interrupted. Showing the last known status and retrying. The server job may still be running. {connectionError}</p>}
  </div>;
}
