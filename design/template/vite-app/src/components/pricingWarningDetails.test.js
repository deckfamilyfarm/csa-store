import test from "node:test";
import assert from "node:assert/strict";
import { pricingWarningDetails } from "./pricingWarningDetails.js";

test("warning details include package blockers, audit errors and publication failures", () => {
  assert.deepEqual(pricingWarningDetails({ check: { error: "Square refresh failed", actions: [
    { platform: "localline", packageName: "2.5 oz", status: "blocked", message: "SNAP price-list entry is missing", warnings: ["SNAP price-list entry is missing"] },
    { platform: "square", status: "changed", releaseStatus: "held", releaseMessage: "Square price changed since review" },
    { platform: "localline", status: "synced", message: "No changes" }
  ] } }), [
    { label: "Server check", message: "Square refresh failed" },
    { label: "Local Line · 2.5 oz", message: "SNAP price-list entry is missing" },
    { label: "Square", message: "Square price changed since review" }
  ]);
  assert.deepEqual(pricingWarningDetails(null), []);
});
