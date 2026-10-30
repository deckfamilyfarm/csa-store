export function pricingWarningDetails(revision) {
  const check = revision?.check;
  const details = [];
  if (check?.error) details.push({ label: "Server check", message: check.error });
  for (const action of check?.actions || []) {
    const problem = ["blocked", "held", "review", "failed"].includes(action.status)
      || ["failed", "held"].includes(action.releaseStatus);
    const label = `${action.platform === "square" ? "Square" : "Local Line"}${action.packageName ? ` · ${action.packageName}` : ""}`;
    const messages = [...(action.warnings || [])];
    if (problem) messages.unshift(action.releaseMessage, action.result?.message, action.message);
    for (const message of new Set(messages.filter(value => typeof value === "string" && value.trim()))) details.push({ label, message });
  }
  return details.filter((item, index) => details.findIndex(other => other.label === item.label && other.message === item.message) === index);
}
