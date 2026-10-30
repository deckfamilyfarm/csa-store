export function pricingWarningDetails(revision, row = null) {
  const check = revision?.check;
  const details = [];
  if (check?.error) details.push({ label: "Server check", message: check.error });
  for (const action of check?.actions || []) {
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
