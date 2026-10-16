import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPackDayCycles,
  buildPackDayTeamViewValues,
  scorePackDayCycles
} from "./packDayEfficiency.js";

function labor(workDate, task, hours) {
  return {
    workDate,
    task,
    startTime: `${workDate} 08:00:00`,
    endTime: `${workDate} ${String(8 + hours).padStart(2, "0")}:00:00`,
    breakMinutes: 0,
    hours
  };
}

test("attributes Monday and Tuesday to Tuesday, and Thursday through Saturday to the weekend cycle", () => {
  const orderRows = [
    { fulfillmentDate: "2026-10-13", orders: 10 },
    { fulfillmentDate: "2026-10-16", orders: 4 },
    { fulfillmentDate: "2026-10-17", orders: 6 }
  ];
  const laborRows = [
    labor("2026-10-12", "packout", 2),
    labor("2026-10-13", "dairy_and_frozen_packing", 1),
    labor("2026-10-13", "delivery", 1),
    labor("2026-10-14", "packout", 5),
    labor("2026-10-15", "packout", 3),
    labor("2026-10-16", "delivery", 2),
    labor("2026-10-17", "delivery", 1)
  ];
  assert.deepEqual(buildPackDayCycles({ orderRows, laborRows, throughDate: "2026-10-17" }), [
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 10, packHours: 3, deliveryHours: 1 },
    { cycleDate: "2026-10-17", type: "Friday/Saturday", orders: 10, packHours: 3, deliveryHours: 3 }
  ]);
  assert.deepEqual(buildPackDayCycles({ orderRows, laborRows, throughDate: "2026-10-16" }), [
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 10, packHours: 3, deliveryHours: 1 }
  ]);
});

test("uses one 25th percentile target and lists all cycles from the last two months newest first", () => {
  const cycles = [
    { cycleDate: "2026-02-03", type: "Tuesday", orders: 60, packHours: 6, deliveryHours: 6 },
    { cycleDate: "2026-08-14", type: "Friday/Saturday", orders: 60, packHours: 7, deliveryHours: 7 },
    { cycleDate: "2026-08-15", type: "Friday/Saturday", orders: 60, packHours: 8, deliveryHours: 8 },
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 60, packHours: 9, deliveryHours: 9 },
    { cycleDate: "2026-10-10", type: "Friday/Saturday", orders: 60, packHours: 0, deliveryHours: 8 }
  ];
  const report = scorePackDayCycles(cycles, { throughDate: "2026-10-15" });
  assert.equal(report.windowStart, "2026-08-15");
  assert.equal(report.referenceCycleCount, 4);
  assert.equal(report.targetMinutesPerOrder, 13.5);
  assert.deepEqual(report.rows.map((row) => row.cycleDate), ["2026-10-13", "2026-10-10", "2026-08-15"]);
  const values = buildPackDayTeamViewValues(report, { asOfDate: "2026-10-15" });
  assert.equal(values[0][0], "CSA Packing & Delivery Efficiency");
  assert.equal(values[1][1], 13.5);
  assert.equal(values[5][5], "vs. Target");
  assert.equal(values[6][0], "Tue, Oct 13");
  assert.equal(values[6][4], "=C7+D7");
  assert.match(values[6][5], /\$B\$2/);
  assert.equal(values[7][5], "Awaiting timesheets");
});
