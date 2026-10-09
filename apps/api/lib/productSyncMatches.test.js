import { test } from "node:test";
import assert from "node:assert/strict";
import { localLineMatchRow } from "./productSyncMatches.js";

test("Local Line matches keep local and remote IDs distinct and never infer publication from cache refresh", () => {
  const row = localLineMatchRow({ id: 1, name: "Lamb", localLineProductId: 20, pending: 0,
    rawJson: JSON.stringify({ name: "Lamb in Local Line", packages: [{ id: 300, name: "Small", unit_price: 9 }] }),
    cachedAt: "2026-10-08 12:00:00", lastCheckedAt: "2026-10-07 12:00:00", lastPublishedAt: null },
    [{ id: 3, localLinePackageId: 300, name: "Regular", price: 10 }]);
  assert.equal(row.localLineProductId, 20);
  assert.equal(row.lastPublishedAt, null);
  assert.equal(row.lastCheckedAt, "2026-10-07T12:00:00Z");
  assert.equal(row.packages[0].localLinePackageId, 300);
  assert.equal(row.packages[0].localLinePrice, 9);
  assert.equal(row.packages[0].localPrice, 10);
});
test("missing links remain unlinked; latest comparison carries a held result for review", () => {
  const row = localLineMatchRow({ id: 7, name: "New", pending: 1 }, [{ id: 70, name: "Each" }],
    { id: 3, audit_id: 1, status: "held", data_json: JSON.stringify({ kind: "create", message: "Create" }), result_json: JSON.stringify({ message: "Needs reconciliation" }) });
  assert.equal(row.localLineProductId, null);
  assert.equal(row.packages[0].localLinePackageId, null);
  assert.equal(row.latestComparison.message, "Needs reconciliation");
  assert.equal(row.pending, true);
});
