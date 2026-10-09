import React, { useEffect, useState } from "react";
import { PLATFORM_NAMES, comparisonRows, comparisonGroups, isReleaseActive, releaseProgress, elapsedText } from "./productSyncView.js";

const valueText = value => value == null ? "—" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const fieldLabel = value => value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^fields · /, "");
const emptyResults = () => ({ rows: [], total: 0, productCount: 0, platformCounts: [], vendors: [] });
export function ReleaseProgress({ release, error, onDismiss }) {
  const [now, setNow] = useState(Date.now());
  const active = isReleaseActive(release);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const progress = releaseProgress(release);
  const updated = Math.max(Date.parse(release.startedAt || release.createdAt) || now, ...(release.actions || []).map(action => Date.parse(action.updatedAt) || 0));
  return <div className="sync-publish-progress" aria-label={`Publication progress: ${release.name}`}>
    <header><strong>{active ? release.status === "queued" ? "Waiting to publish" : "Publishing approved changes" : release.status === "completed" ? "Publication complete" : "Publication needs review"} · {release.name}</strong>
      <span>{elapsedText(release.startedAt || release.createdAt, release.finishedAt || now)} elapsed</span>{!active && <button onClick={onDismiss}>Dismiss</button>}</header>
    <progress max={Math.max(progress.total, 1)} value={progress.processed} aria-label="Updates processed" />
    <p role="status">{progress.processed} of {progress.total} updates processed · {progress.completed} confirmed · {progress.failed} failed · {progress.held} held{progress.cancelled ? ` · ${progress.cancelled} cancelled` : ""}</p>
    <div className="sync-platform-results">{["localline", "square"].map(platform => {
      const actions = (release.actions || []).filter(action => action.platform === platform);
      return actions.length ? <span key={platform}>{PLATFORM_NAMES[platform]}: {actions.filter(action => action.status === "completed").length}/{actions.length} confirmed</span> : null;
    })}</div>
    <div className="sync-current-work">{progress.current.map(action => <p key={action.id}><strong>{action.productName} · {PLATFORM_NAMES[action.platform]}{action.packageName ? ` · ${action.packageName}` : ""}</strong> — {action.message}</p>)}
      {active && !progress.current.length && <p>{release.status === "queued" ? "Your approval is saved. Waiting for the publishing worker or another release to finish." : "Preparing the next update…"}</p>}
      {!active && progress.failed + progress.held > 0 && <p>Open Scheduled updates &amp; history below for details and retry or review options.</p>}
    </div>
    {active && <p className="small">Each update is checked before publishing and confirmed afterward. You can leave this page and return to follow progress.</p>}
    {active && now - updated > 60000 && <p className="small">This step is taking longer than a minute. The last saved status is shown above; checking continues.</p>}
    {error && <p className="small" role="status">Progress connection interrupted. Showing the last saved status and reconnecting… {error}</p>}
  </div>;
}
export function Comparison({ action, all = false }) {
  const groups = comparisonGroups(action, !all);
  return <div className="sync-comparison">{groups.map(group => <div key={group.title}><strong>{group.title}</strong><table><thead><tr><th>Field</th><th>{action.direction === "incoming" ? "Current local value" : `Current ${PLATFORM_NAMES[action.platform]} value`}</th><th>Proposed value</th></tr></thead>
    <tbody>{group.rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{valueText(row.current)}</td><td>{valueText(row.proposed)}</td></tr>)}</tbody></table></div>)}
    {!groups.length && <p className="small">Remote values match. {Object.keys(action.staged || {}).length ? "Staged local changes will apply at release." : "No changes."}</p>}
    {Object.keys(action.staged || {}).length > 0 && <p className="small">Staged locally: {Object.entries(action.staged).map(([key, value]) => `${fieldLabel(key)}: ${value}`).join(" · ")}</p>}
  </div>;
}
export function ActionRow({ action, selected, onToggle, eligible, busy }) {
  const differences = comparisonRows(action);
  return <div className="sync-action">
    <div className="sync-action-heading">
      <label><input type="checkbox" checked={selected} onChange={onToggle} disabled={busy || !eligible} aria-label={`Select ${PLATFORM_NAMES[action.platform]} ${action.productName} ${action.packageName || action.kind}`} />
        <strong>{PLATFORM_NAMES[action.platform]}</strong> {action.packageName || (action.kind === "create" ? "Create product" : action.direction === "incoming" ? "Local catalog repair" : "Product update")}
      </label>
      <span className={`sync-status ${action.status}`}>{action.released ? "In release" : action.status}</span>
    </div>
    {action.message && <p className="small">{action.message}</p>}
    {action.result?.message && <p className="small">{action.result.message}</p>}
    {action.display && <>
      <div className="sync-preview">{differences.slice(0, 3).map(row => <span key={row.key}><b>{fieldLabel(row.key)}:</b> {valueText(row.current)} → {valueText(row.proposed)}</span>)}</div>
      <details><summary>Review {differences.length} changed fields and all proposed values</summary><Comparison action={action} all /></details>
    </>}
  </div>;
}
