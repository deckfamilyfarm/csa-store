import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPackDayEfficiencyEmail,
  isScheduledPackDayEmailTime,
  previousPacificDay
} from "./packDayEfficiencyEmail.js";

test("Wednesday and Sunday 10 AM Pacific runs once across daylight-saving changes", () => {
  for (const instant of [
    "2026-10-14T17:00:00Z", // Wednesday in daylight time
    "2026-10-18T17:00:00Z", // Sunday in daylight time
    "2026-12-16T18:00:00Z", // Wednesday in standard time
    "2026-12-20T18:00:00Z"  // Sunday in standard time
  ]) {
    assert.equal(isScheduledPackDayEmailTime(new Date(instant)), true, instant);
  }
  for (const instant of [
    "2026-10-14T18:00:00Z", // alternate UTC hour in daylight time
    "2026-12-16T17:00:00Z", // alternate UTC hour in standard time
    "2026-10-16T17:00:00Z", // Friday
    "2026-10-14T17:01:00Z"
  ]) {
    assert.equal(isScheduledPackDayEmailTime(new Date(instant)), false, instant);
  }
  assert.equal(previousPacificDay(new Date("2026-10-14T17:00:00Z")), "2026-10-13");
  assert.equal(previousPacificDay(new Date("2026-10-18T17:00:00Z")), "2026-10-17");
});

function reportForEmail(overrides = {}) {
  return { scored: {
    targetMinutesPerOrder: 27.5,
    rows: [{
      cycleDate: "2026-10-27", orders: 77, complete: true,
      packMinutesPerOrder: 8.820779, deliveryMinutesPerOrder: 8.836364,
      pickupMinutesPerOrder: 1.192208, totalMinutesPerOrder: 18.849351,
      ordersPerMinute: 0.053052,
      dailyOrderAverage: { year: 2026, operatingDays: 86, orders: 72.593023 },
      averages: { operatingDays: 30, startDate: "2026-07-14", endDate: "2026-10-24",
        orders: 77.266667, ordersPerMinute: 0.032637, packMinutesPerOrder: 15.40975,
        deliveryMinutesPerOrder: 11.936324, pickupMinutesPerOrder: 3.293529, totalMinutesPerOrder: 30.639603 },
      ...overrides
    }]
  } };
}

test("plain-text and HTML email show daily orders, efficiency, pickup, totals, and comparison in requested order", () => {
  const report = reportForEmail();
  const email = buildPackDayEfficiencyEmail(report, "2026-10-27", { spreadsheetId: "sheet-123" });
  for (const text of [
    "DAILY ORDER REPORT · Tue, Oct 27", "77 fulfilled on Tuesday October 27th.",
    "Daily Average: 72.6 orders (based on all 2026 pack-day data through Oct 27)",
    "Packing: 8.8 min/order · Average: 15.4 min/order",
    "Delivery: 8.8 min/order · Average: 11.9 min/order",
    "Pickup: 1.2 min/order · Average: 3.3 min/order",
    "Total: 18.8 min/order · Average: 30.6 min/order",
    "Target: 27.5 min/order", "8.7 min/order faster than target",
    "Time averages: previous 30 operating days (Jul 14–Oct 24).",
    "Each time average is the total labor minutes for that category divided by fulfilled orders over the same period.",
    "All times reflect labor minutes."
  ]) {
    assert.ok(email.text.includes(text), text);
    assert.ok(email.html.includes(text), text);
  }
  assert.ok(email.text.indexOf("ORDERS\n") < email.text.indexOf("TIME PER ORDER\n"));
  assert.doesNotMatch(email.text, /EFFICIENCY|Orders\/min|fulfilled today|Daily Average: 77.3/);
  assert.doesNotMatch(email.html, /EFFICIENCY|Orders\/min|fulfilled today/);
  assert.ok(email.text.indexOf("Total:") < email.text.indexOf("faster than target"));
  assert.match(email.html, /background-color:#DCFCE7;color:#166534/);
  assert.match(email.text, /spreadsheets\/d\/sheet-123/);
  assert.throws(() => buildPackDayEfficiencyEmail(report, "2026-10-24"), /No paid pack-day cycle/);
});

test("slower and on-target comparisons use the right direction and highlighting", () => {
  const report = reportForEmail({ totalMinutesPerOrder: 28.5 });
  const slower = buildPackDayEfficiencyEmail(report, "2026-10-27");
  assert.match(slower.text, /1.0 min\/order slower than target/);
  assert.match(slower.html, /background-color:#FEE2E2;color:#991B1B/);
  report.scored.rows[0].totalMinutesPerOrder = 27.5;
  const onTarget = buildPackDayEfficiencyEmail(report, "2026-10-27");
  assert.match(onTarget.text, /On target/);
  assert.match(onTarget.html, /background-color:#DCFCE7;color:#166534/);
});

test("missing labor and short history are disclosed without NaN, invented zeroes, or a faster claim", () => {
  const report = reportForEmail({ complete: false, pickupMinutesPerOrder: null,
    totalMinutesPerOrder: null, ordersPerMinute: null,
    averages: { operatingDays: 2, orders: 77, ordersPerMinute: null, pickupMinutesPerOrder: null }
  });
  const email = buildPackDayEfficiencyEmail(report, "2026-10-27");
  assert.match(email.text, /Pickup: Pending min/);
  assert.match(email.text, /Total: Pending min/);
  assert.match(email.text, /Pickup: Pending min\/order · Average: Pending min\/order/);
  assert.match(email.text, /Time per order pending/);
  assert.match(email.text, /previous 2 operating days available/);
  assert.doesNotMatch(email.text, /NaN|Infinity|faster than target|Pickup: 0.0/);
  report.scored.targetMinutesPerOrder = null;
  report.scored.rows[0] = { ...reportForEmail().scored.rows[0], averages: {} };
  const noHistory = buildPackDayEfficiencyEmail(report, "2026-10-27");
  assert.match(noHistory.text, /Target: Pending min/);
  assert.match(noHistory.text, /Time averages: pending operating-day history/);
  assert.doesNotMatch(noHistory.text, /NaN|Infinity|faster than target/);
});


test("fulfillment dates use ordinal suffixes including teens", () => {
  for (const [day, suffix] of [[1, "st"], [2, "nd"], [3, "rd"], [11, "th"], [12, "th"], [13, "th"], [21, "st"], [22, "nd"], [23, "rd"], [27, "th"]]) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    const email = buildPackDayEfficiencyEmail(reportForEmail({ cycleDate: date }), date);
    assert.ok(email.text.includes(`October ${day}${suffix}.`));
    assert.ok(email.html.includes(`October ${day}${suffix}.`));
  }
});
