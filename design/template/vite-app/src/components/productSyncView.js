export const PLATFORM_NAMES = { localline: "Local Line", square: "Square" };
export const hasSyncRole = (roles, role) => roles.includes("admin") || roles.includes(role);
export function pacificDateTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}
export function pacificInput(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
// Pacific has two possible UTC offsets. Validate by formatting back, including DST gaps/folds.
export function pacificCandidates(input) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(input)) return [];
  const base = Date.parse(`${input}:00Z`);
  if (!Number.isFinite(base)) return [];
  return [7, 8].map(hours => new Date(base + hours * 3600000).toISOString()).filter(value => pacificInput(value) === input);
}
export function groupSyncActions(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.productId)) groups.set(row.productId, { productId: row.productId, productName: row.productName, vendorName: row.vendorName, actions: [] });
    groups.get(row.productId).actions.push(row);
  }
  return [...groups.values()];
}
export function flattenValues(value, prefix = "", result = {}) {
  if (value == null || typeof value !== "object") { result[prefix || "Value"] = value; return result; }
  if (Array.isArray(value) && !value.length) result[prefix] = "None";
  for (const [key, item] of Object.entries(value)) {
    const label = Array.isArray(value) ? (item?.name || `#${Number(key) + 1}`) : key;
    flattenValues(item, prefix ? `${prefix} · ${label}` : label, result);
  }
  return result;
}
export function comparisonRows(action, changedOnly = true) {
  const current = flattenValues(action.display?.current ?? null);
  const proposed = flattenValues(action.display?.proposed ?? null);
  return [...new Set([...Object.keys(current), ...Object.keys(proposed)])].filter(key => !changedOnly || JSON.stringify(current[key]) !== JSON.stringify(proposed[key]))
    .map(key => ({ key, current: current[key], proposed: proposed[key] }));
}
export function acknowledgeSyncDrafts(drafts, entries, productIds) {
  const next = { ...drafts };
  for (const entry of entries || []) {
    const id = entry.meta.productId;
    if (productIds.includes(id) && JSON.stringify(next[id]) === JSON.stringify(entry)) delete next[id];
  }
  return next;
}
