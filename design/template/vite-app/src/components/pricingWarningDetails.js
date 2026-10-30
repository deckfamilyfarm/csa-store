export function pricingWarningDetails(revision, row = null) {
  const check = revision?.check;
  const details = [];
  if (check?.error && (!row || !/^Square\b/.test(check.error) || squareSyncAttempted(row))) details.push({ label: "Server check", message: check.error });
  for (const action of check?.actions || []) {
    if (row && action.platform === 'square' && !squareSyncAttempted(row)) continue;
    // A successful current destination comparison supersedes an older blocker.
    if (row?.sync?.channels?.some(channel => channel.platform === action.platform && channel.state === 'matched')) continue;
    const problem = ["blocked", "held", "review", "failed"].includes(action.status)
      || ["failed", "held"].includes(action.releaseStatus);
    const label = `${action.platform === "square" ? "Square" : "Local Line"}${action.packageName ? ` · ${action.packageName}` : ""}`;
    const messages = [...(action.warnings || [])];
    if (problem) messages.unshift(action.releaseMessage, action.result?.message, action.message);
    for (const message of new Set(messages.filter(value => typeof value === "string" && value.trim()))) details.push({ label, message });
  }
  // The newest audit may cover Local Line only. Keep the other destination's
  // current status visible instead of declaring that the product has no blockers.
  for (const channel of row?.sync?.channels || []) {
    if (channel.platform === 'square' && !squareSyncAttempted(row)) continue;
    const label = channel.platform === 'square' ? 'Square' : 'Local Line';
    if (channel.state === 'matched' || details.some(detail => detail.label === label || detail.label.startsWith(`${label} ·`))) continue;
    let message = channel.reason || 'Check this destination in Review & Publish.';
    if (channel.platform === 'square' && row.approvedSquareLinks === 0) {
      message = 'This product has no approved Square variation link. Review its Square mapping in Review & Publish before syncing Square.';
    } else if (message === 'Publication pending') {
      message = `${label} changes have not been published yet. Review them in Review & Publish.`;
    } else {
      message = `${message}. Review this destination in Review & Publish.`;
    }
    details.push({ label, message });
  }
  return details.filter((item, index) => details.findIndex(other => other.label === item.label && other.message === item.message) === index);
}

export const squareSyncAttempted = row => row.input?.squareEnabled === true &&
  row.publications?.some(p=>p.platform==='square' && p.attempted===true);

export function productPricingWarnings(row) {
  const warnings = [...(row.sourceEvidence?.warnings || [])];
  if (row.status === 'rejected') warnings.push('The latest pricing proposal was rejected.');
  for (const publication of row.publications || []) {
    if (publication.platform === 'square' && !squareSyncAttempted(row)) continue;
    if (['blocked','failed','partial'].includes(publication.status)) warnings.push(`${publication.platform === 'square' ? 'Square' : 'Local Line'} publication: ${publication.status}.`);
  }
  return warnings;
}

export function pricingChannelStatuses(row, review) {
  const details = pricingWarningDetails(review, row);
  return ['localline', ...(row.input?.squareEnabled === true ? ['square'] : [])].map(platform => {
    const label = platform === 'square' ? 'Square' : 'Local Line';
    const channel = row.sync?.channels?.find(item => item.platform === platform);
    const actions = (review?.check?.actions || []).filter(action => action.platform === platform);
    let message;
    if (actions.some(action => ['queued', 'running'].includes(action.publicationStatus))) message = 'Sync in progress.';
    else if (channel?.state === 'matched') message = row.publications?.some(p => p.platform === platform && p.status === 'verified')
      ? 'Sync succeeded.' : 'Prices match the latest stored check.';
    else if (platform === 'square' && !squareSyncAttempted(row)) message = 'Not synced yet.';
    else message = details.filter(detail => detail.label === label || detail.label.startsWith(`${label} ·`))
      .map(detail => `${detail.label === label ? '' : `${detail.label.slice(label.length + 3)}: `}${detail.message}`).join(' ')
      || `Status needs checking. ${platform === 'square' ? 'Open Review & Publish.' : 'Open Sync.'}`;
    return { platform, message };
  });
}
