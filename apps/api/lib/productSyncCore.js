import crypto from "node:crypto";

export const STAGED_FIELDS = ["visible", "trackInventory", "inventory", "onSale", "saleDiscount"];
export const SYNC_ROLES = ["localline_pull", "localline_push", "square_pull", "square_push", "pricing_admin"];
export const hasGrant = (roles, grant) => roles.includes("admin") || roles.includes(grant);
export const canonical = value => JSON.stringify(stable(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value ?? null;
}
export const same = (a, b) => canonical(a) === canonical(b);
export const fingerprint = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function normalizeIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000) fail("Select between 1 and 10,000 actions.");
  const result = [...new Set(ids.map(Number))];
  if (result.some(id => !Number.isSafeInteger(id) || id <= 0)) fail("Invalid action or product id.");
  return result;
}
export function normalizeStaged(rows = []) {
  if (!Array.isArray(rows)) fail("Staged changes must be a list.");
  const result = {};
  for (const row of rows) {
    const [id] = normalizeIds([row.productId]);
    if (result[id]) fail("A product can be staged only once.");
    const changes = row.changes || {};
    if (!Object.keys(changes).length || Object.keys(changes).some(key => !STAGED_FIELDS.includes(key))) {
      fail("Save formula, package, and product details locally before auditing. Only stock, tracking, visibility, and sales can be staged.");
    }
    result[id] = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || !Number.isFinite(Number(value))) fail(`Invalid ${key}.`);
      const num = Number(value);
      if (["visible", "trackInventory", "onSale"].includes(key) && ![0, 1].includes(num)) fail(`Invalid ${key}.`);
      if (key === "inventory" && (!Number.isInteger(num) || num < 0)) fail("Stock must be a nonnegative whole number.");
      if (key === "saleDiscount" && (num < 0 || num > 1)) fail("Sale discount must be between 0 and 1.");
      result[id][key] = num;
    }
  }
  return result;
}
export function authorizeRelease(roles, actions, scheduled = false) {
  if (scheduled && !hasGrant(roles, "pricing_admin")) fail("Scheduling requires Pricing Admin.", 403);
  for (const action of actions) {
    if (action.direction !== "outgoing" || !["localline", "square"].includes(action.platform)) fail("Only outgoing actions can be released.");
    if (!hasGrant(roles, `${action.platform}_push`)) fail(`Publishing to ${action.platform === "square" ? "Square" : "Local Line"} requires its Push permission.`, 403);
    if (Object.keys(action.staged || {}).length && !["inventory_admin", "pricing_admin", "local_pricelist_admin"].some(role => hasGrant(roles, role))) {
      fail("Staged changes require local product editing permission.", 403);
    }
  }
}
export function releaseTime(value, now = Date.now()) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now) fail("Choose a future release time.");
  if (date.getUTCMinutes() || date.getUTCSeconds() || date.getUTCMilliseconds()) fail("Releases must be scheduled at the top of an hour.");
  return date.toISOString().slice(0, 19).replace("T", " ");
}
export function preflight(action, current, localApplied = false) {
  if (!same(current.mapping, action.mapping)) return { status: "held", message: "Product match changed. Audit and approve again." };
  if (!same(current.local, localApplied ? action.localAfter : action.localBefore)) return { status: "held", message: "Local inputs changed. Audit and approve again." };
  if (same(current.remote, current.desired)) return { status: "completed", message: "Remote values already match the approved values." };
  // Only fields that will be written participate in drift checks; unrelated remote changes are preserved.
  if (!approvedTransition(current.remote, current.resumeBaseline ?? action.remoteBefore, current.desired)) return { status: "held", message: "Remote values changed. Audit and approve again." };
  return { status: "ready" };
}
export function approvedTransition(current, before, desired) {
  if (same(current, before) || same(current, desired)) return true;
  if (!current || !before || !desired || typeof current !== "object" || typeof before !== "object" || typeof desired !== "object") return false;
  if (!same(Object.keys(current).sort(), Object.keys(before).sort()) || !same(Object.keys(current).sort(), Object.keys(desired).sort())) return false;
  return Object.keys(current).every(key => approvedTransition(current[key], before[key], desired[key]));
}
export function releaseStatus(actions) {
  if (actions.every(action => action.status === "completed")) return "completed";
  if (actions.some(action => action.status === "completed")) return "partial";
  if (actions.some(action => action.status === "held")) return "held";
  return "failed";
}

// The database adapter checkpoints every transition. A restart rechecks remote state before sending.
export async function executeProductActions(actions, io) {
  const checks = [];
  for (const action of actions) {
    if (["completed", "held", "cancelled"].includes(action.status)) continue;
    try {
      const current = await io.inspect(action);
      const check = preflight(action, current, await io.isLocalApplied());
      if (check.status === "held") await io.save(action, check);
      else checks.push({ action, current, check });
    } catch (error) {
      await io.save(action, { status: error.hold ? "held" : "failed", message: error.message });
    }
  }
  if (!checks.length) return;
  try {
    await io.applyLocalOnce();
  } catch (error) {
    for (const { action } of checks) await io.save(action, { status: "held", message: error.message });
    return;
  }
  for (const { action } of checks) {
    try {
      // Inspect again after staging and immediately before this platform's write.
      const current = await io.inspect(action);
      const finalCheck = preflight(action, current, true);
      if (finalCheck.status === "held") { await io.save(action, finalCheck); continue; }
      if (finalCheck.status === "completed") {
        await io.save(action, finalCheck);
        continue;
      }
      await io.save(action, { status: "working", message: "Applying approved values." });
      await io.execute(action, current);
      const verified = await io.inspect(action);
      if (!same(verified.mapping, action.mapping)) throw new Error("Product match changed during publication; review required.");
      if (!same(verified.remote, verified.desired)) throw new Error("Remote confirmation is incomplete. Retry will verify the outcome before resending.");
      await io.save(action, { status: "completed", message: "Approved values confirmed remotely." });
    } catch (error) {
      await io.save(action, { status: error.hold ? "held" : "failed", message: error.message });
    }
  }
}
