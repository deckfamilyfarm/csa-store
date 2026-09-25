import assert from "node:assert/strict";
import test from "node:test";
import { getPricelistPublishWeek, publicationFromRow } from "./googleDrivePublishing.js";

test("pricelist weeks switch at Monday midnight in Pacific time, not UTC", () => {
  assert.deepEqual(getPricelistPublishWeek(new Date("2026-09-21T06:59:59Z")), {
    latestWeekStart: "2026-09-14", latestWeekEnd: "2026-09-20"
  });
  assert.deepEqual(getPricelistPublishWeek(new Date("2026-09-21T07:00:00Z")), {
    latestWeekStart: "2026-09-21", latestWeekEnd: "2026-09-27"
  });
});

test("Pacific week boundaries handle daylight saving and year changes", () => {
  assert.deepEqual(getPricelistPublishWeek(new Date("2026-03-09T06:59:59Z")), {
    latestWeekStart: "2026-03-02", latestWeekEnd: "2026-03-08"
  });
  assert.deepEqual(getPricelistPublishWeek(new Date("2026-11-02T07:59:59Z")), {
    latestWeekStart: "2026-10-26", latestWeekEnd: "2026-11-01"
  });
  assert.deepEqual(getPricelistPublishWeek(new Date("2027-01-01T12:00:00Z")), {
    latestWeekStart: "2026-12-28", latestWeekEnd: "2027-01-03"
  });
});

test("existing dashboard history retains its published week and timestamp", () => {
  const summary = { latestWeekStart: "2026-09-14", latestWeekEnd: "2026-09-20" };
  assert.deepEqual(publicationFromRow({
    publishedAt: new Date("2026-09-21T18:37:56Z"), summaryJson: JSON.stringify(summary)
  }), {
    publishedAt: "2026-09-21T18:37:56.000Z", ...summary, summary
  });
});

test("missing history and publishes without a completed dashboard week stay distinct", () => {
  assert.equal(publicationFromRow(undefined), null);
  assert.equal(publicationFromRow({ summaryJson: "{}" }), null);
  assert.deepEqual(publicationFromRow({ publishedAt: "2026-09-21T18:37:56Z", summaryJson: "{}" }), {
    publishedAt: "2026-09-21T18:37:56.000Z",
    latestWeekStart: null, latestWeekEnd: null, summary: {}
  });
});
