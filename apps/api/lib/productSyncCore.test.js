import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStaged, normalizeIds, authorizeRelease, releaseTime, preflight, executeProductActions, releaseStatus } from "./productSyncCore.js";

const action = (platform = "square") => ({ id: 1, platform, direction: "outgoing", kind: "price", status: "pending", mapping: { id: "approved" },
  staged: { onSale: 1 }, localBefore: { price: 10, sale: 0 }, localAfter: { price: 10, sale: 1 }, remoteBefore: { price: 11 }, desired: { price: 9 } });
function harness(actions, options = {}) {
  let localApplied = Boolean(options.localApplied);
  let localApplies = 0;
  const calls = [];
  const remote = new Map(actions.map(a => [a.id, structuredClone(a.remoteBefore)]));
  const io = {
    inspect: async a => ({ local: options.local?.(a, localApplied) || (localApplied ? a.localAfter : a.localBefore), mapping: options.mapping?.(a) || a.mapping,
      remote: remote.get(a.id), desired: a.desired }),
    isLocalApplied: async () => localApplied,
    applyLocalOnce: async () => { if (!localApplied) { localApplies++; localApplied = true; } },
    execute: async a => { calls.push(a.id); if (options.fail?.(a)) throw new Error("Connection lost"); remote.set(a.id, structuredClone(a.desired)); },
    save: async (a, update) => Object.assign(a, update)
  };
  return { io, remote, calls, get localApplies() { return localApplies; } };
}
test("staging accepts only supported fields, uses fractional discounts, and rejects invalid input", () => {
  assert.deepEqual(normalizeStaged([{ productId: 4, changes: { inventory: 5, saleDiscount: 0.1, onSale: true } }]), { 4: { inventory: 5, saleDiscount: 0.1, onSale: 1 } });
  for (const changes of [{ sourceUnitPrice: 10 }, { saleDiscount: 10 }, { inventory: -1 }, { inventory: 1.5 }, { onSale: "false" }, {}]) assert.throws(() => normalizeStaged([{ productId: 1, changes }]));
  assert.throws(() => normalizeStaged([{ productId: 1, changes: { visible: 1 } }, { productId: 1, changes: { visible: 0 } }]));
  assert.throws(() => normalizeIds(["1 OR 1=1"]));
});
test("approval requires every destination's push grant and separate local/scheduling grants", () => {
  const square = { ...action(), staged: {} }, ll = { ...action("localline"), staged: {} };
  assert.doesNotThrow(() => authorizeRelease(["square_push"], [square]));
  assert.throws(() => authorizeRelease(["pricing_admin"], [square]), /Push permission/);
  assert.throws(() => authorizeRelease(["square_push"], [square, ll]), /Push permission/);
  assert.throws(() => authorizeRelease(["square_push"], [square], true), /Scheduling/);
  assert.throws(() => authorizeRelease(["square_push"], [action()]), /local product editing/);
  assert.doesNotThrow(() => authorizeRelease(["pricing_admin", "square_push", "localline_push"], [square, ll], true));
  assert.throws(() => authorizeRelease(["admin"], [{ ...square, direction: "incoming" }]));
});
test("schedule timestamps require future hourly UTC instants", () => {
  assert.equal(releaseTime("2030-02-01T08:00:00Z", 0), "2030-02-01 08:00:00");
  assert.throws(() => releaseTime("2030-02-01T08:30:00Z", 0));
  assert.throws(() => releaseTime("2000-01-01T00:00:00Z"));
  assert.equal(releaseTime(null), null);
});
test("preflight holds local, mapping, and remote drift, and recognizes desired remote state", () => {
  const a = action();
  const current = { local: a.localBefore, mapping: a.mapping, remote: a.remoteBefore, desired: a.desired };
  assert.equal(preflight(a, current).status, "ready");
  assert.equal(preflight(a, { ...current, local: { price: 12 } }).status, "held");
  assert.equal(preflight(a, { ...current, mapping: { id: "replacement" } }).status, "held");
  assert.equal(preflight(a, { ...current, remote: { price: 8 } }).status, "held");
  assert.equal(preflight(a, { ...current, remote: a.desired }).status, "completed");
  assert.equal(preflight(a, { ...current, local: a.localAfter }, true).status, "ready");
});
test("partially applied approved remote fields can resume, but third-party values cannot", () => {
  const a = { ...action(), remoteBefore: { price: 10, visible: true }, desired: { price: 9, visible: false } };
  const current = { local: a.localBefore, mapping: a.mapping, desired: a.desired, remote: { price: 9, visible: true } };
  assert.equal(preflight(a, current).status, "ready");
  assert.equal(preflight(a, { ...current, remote: { price: 7, visible: true } }).status, "held");
});
test("both destinations apply local staging once, and successful actions aren't resent", async () => {
  const actions = [{ ...action("localline"), id: 1 }, { ...action(), id: 2 }];
  const h = harness(actions);
  await executeProductActions(actions, h.io);
  await executeProductActions(actions, h.io);
  assert.equal(h.localApplies, 1); assert.deepEqual(h.calls, [1, 2]);
  assert.equal(releaseStatus(actions), "completed");
});
test("platform failure doesn't stop the other platform; retry only performs unfinished work", async () => {
  let failSquare = true;
  const actions = [{ ...action("localline"), id: 1 }, { ...action(), id: 2 }];
  const h = harness(actions, { fail: a => a.platform === "square" && failSquare });
  await executeProductActions(actions, h.io);
  assert.equal(releaseStatus(actions), "partial"); assert.equal(h.localApplies, 1);
  failSquare = false;
  await executeProductActions(actions, h.io);
  assert.deepEqual(h.calls, [1, 2, 2]); assert.equal(h.localApplies, 1); assert.equal(releaseStatus(actions), "completed");
});
test("a held platform does not stop eligible platform actions or get retried without new review", async () => {
  const actions = [{ ...action("localline"), id: 1 }, { ...action(), id: 2 }];
  const h = harness(actions, { mapping: a => a.platform === "square" ? { id: "changed" } : a.mapping });
  await executeProductActions(actions, h.io);
  await executeProductActions(actions, h.io);
  assert.deepEqual(h.calls, [1]); assert.equal(actions[1].status, "held"); assert.equal(h.localApplies, 1);
});
test("restart after a lost response verifies remote success before resending", async () => {
  const actions = [{ ...action(), status: "working" }];
  const h = harness(actions, { localApplied: true });
  h.remote.set(1, actions[0].desired);
  await executeProductActions(actions, h.io);
  assert.deepEqual(h.calls, []); assert.equal(h.localApplies, 0); assert.equal(actions[0].status, "completed");
});
test("local drift holds all affected actions without applying staged values", async () => {
  const actions = [action()];
  const h = harness(actions, { local: () => ({ price: 77 }) });
  await executeProductActions(actions, h.io);
  assert.equal(actions[0].status, "held"); assert.equal(h.localApplies, 0); assert.deepEqual(h.calls, []);
});
test("publication checkpoints describe checking, sending, and confirmation before completion", async () => {
  const actions = [action()];
  const h = harness(actions);
  const transitions = [];
  const save = h.io.save;
  h.io.save = async (a, result) => { transitions.push({ ...result }); await save(a, result); };
  await executeProductActions(actions, h.io);
  assert.deepEqual(transitions.map(row => row.status), ["working", "working", "working", "completed"]);
  assert.match(transitions[0].message, /Checking/);
  assert.match(transitions[1].message, /Applying/);
  assert.match(transitions[2].message, /Confirming/);
  assert.match(transitions[3].message, /confirmed/);
});
