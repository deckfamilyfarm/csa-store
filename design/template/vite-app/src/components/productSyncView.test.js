import { test } from "node:test";
import assert from "node:assert/strict";
import { pacificCandidates, pacificInput, acknowledgeSyncDrafts, groupSyncActions, releaseProgress, isReleaseActive, elapsedText } from "./productSyncView.js";
test("Pacific scheduling is independent of browser time zone and handles DST", () => {
  assert.deepEqual(pacificCandidates("2026-09-25T14:00"), ["2026-09-25T21:00:00.000Z"]);
  assert.deepEqual(pacificCandidates("2026-12-25T14:00"), ["2026-12-25T22:00:00.000Z"]);
  assert.deepEqual(pacificCandidates("2026-03-08T02:00"), []);
  assert.deepEqual(pacificCandidates("2026-11-01T01:00"), ["2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z"]);
  assert.deepEqual(pacificCandidates("2026-09-25T14:30"), []);
  assert.equal(pacificInput("2026-09-25T07:00:00Z"), "2026-09-25T00:00");
});
test("release approval clears only the exact staged drafts included in the release", () => {
  const first = { meta: { productId: 1 }, values: { inventory: 2 } };
  const second = { meta: { productId: 2 }, values: { inventory: 3 } };
  const drafts = { 1: structuredClone(first), 2: second };
  assert.deepEqual(acknowledgeSyncDrafts(drafts, [first, second], [1]), { 2: second });
  drafts[1].values.inventory = 9;
  assert.deepEqual(acknowledgeSyncDrafts(drafts, [first], [1]), drafts);
});
test("actions stay grouped by product with independent platform choices", () => {
  const rows = [{ id: 1, productId: 1, platform: "localline" }, { id: 2, productId: 1, platform: "square" }, { id: 3, productId: 2, platform: "square" }];
  const groups = groupSyncActions(rows);
  assert.equal(groups.length, 2); assert.deepEqual(groups[0].actions.map(row => row.id), [1, 2]);
});
test("publishing progress counts verified success separately from failed, held, and unfinished updates", () => {
  const release = { status: "running", actions: [
    { id: 1, productId: 1, status: "completed" }, { id: 2, productId: 1, status: "held" },
    { id: 3, productId: 2, status: "failed" }, { id: 4, productId: 3, status: "working" },
    { id: 5, productId: 3, status: "pending" }
  ] };
  const progress = releaseProgress(release);
  assert.equal(progress.total, 5); assert.equal(progress.products, 3);
  assert.equal(progress.processed, 3); assert.equal(progress.completed, 1);
  assert.deepEqual(progress.current.map(row => row.id), [4]);
  assert.equal(isReleaseActive(release), true);
  assert.equal(isReleaseActive({status:"queued"}), true);
  assert.equal(isReleaseActive({status:"partial"}), false);
  assert.equal(elapsedText("2026-09-25T00:00:00Z", "2026-09-25T00:01:05Z"), "1m 5s");
});
