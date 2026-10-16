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

test("email reports previous cycle's packing, delivery, total, and one target", () => {
  const report = {
    scored: {
      targetMinutesPerOrder: 23.974647887323943,
      rows: [{
        cycleDate: "2026-10-13",
        orders: 58,
        complete: true,
        packMinutesPerOrder: 15.186206896551724,
        deliveryMinutesPerOrder: 12.258620689655173,
        totalMinutesPerOrder: 27.444827586206898
      }]
    }
  };
  const email = buildPackDayEfficiencyEmail(report, "2026-10-13", { spreadsheetId: "sheet-123" });
  assert.match(email.subject, /Tue, Oct 13/);
  assert.match(email.text, /58 fulfilled orders/);
  assert.match(email.text, /Packing: 15\.2 min\/order/);
  assert.match(email.text, /Delivery: 12\.3 min\/order/);
  assert.match(email.text, /Total: 27\.4 min\/order/);
  assert.match(email.text, /Target: 24\.0 min\/order/);
  assert.match(email.text, /3\.5 min slower than target/);
  assert.match(email.text, /spreadsheets\/d\/sheet-123/);
  assert.throws(() => buildPackDayEfficiencyEmail(report, "2026-10-10"), /No paid pack-day cycle/);
});

test("incomplete timesheets are disclosed instead of reporting misleading efficiency", () => {
  const report = {
    scored: {
      targetMinutesPerOrder: 24,
      rows: [{ cycleDate: "2026-10-10", orders: 84, complete: false }]
    }
  };
  const email = buildPackDayEfficiencyEmail(report, "2026-10-10");
  assert.match(email.text, /Efficiency pending/);
  assert.doesNotMatch(email.text, /Total:/);
});
