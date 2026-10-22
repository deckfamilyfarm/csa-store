import test from "node:test";
import assert from "node:assert/strict";
import { pricingUtcDate } from "./enterprisePricingDates.js";

test("imported Buy Price dates remain available when editing prices on a non-UTC host", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ["America/Phoenix", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = zone;
      const costDate = pricingUtcDate("2026-10-21 23:46:14", "Cost effective date");
      const priceDate = pricingUtcDate("2026-10-22T00:11:55.231Z", "Price effective date");
      assert.equal(costDate, "2026-10-21 23:46:14");
      assert.ok(costDate <= priceDate);
      assert.equal(pricingUtcDate(costDate, "Cost effective date"), costDate, "Repeated saves must not shift dates");
      assert.equal(pricingUtcDate("2026-10-21T23:46:14", "Date"), costDate);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("pricing dates preserve explicit offsets and date-only costs", () => {
  assert.equal(pricingUtcDate("2026-10-21T16:46:14-07:00", "Date"), "2026-10-21 23:46:14");
  assert.equal(pricingUtcDate("2026-10-21", "Date"), "2026-10-21 00:00:00");
  assert.throws(() => pricingUtcDate("invalid", "Cost effective date"), { status: 400, message: "Cost effective date must be a valid date and time." });
});
