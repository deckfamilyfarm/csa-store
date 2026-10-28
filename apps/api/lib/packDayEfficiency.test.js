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
    labor("2026-10-13", "pick_ups", 2),
    labor("2026-10-14", "packout", 5),
    labor("2026-10-15", "packout", 3),
    labor("2026-10-16", "delivery", 2),
    labor("2026-10-16", "pick_ups", 1),
    labor("2026-10-17", "delivery", 1)
  ];
  assert.deepEqual(buildPackDayCycles({ orderRows, laborRows, throughDate: "2026-10-17" }), [
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 10, packHours: 3, deliveryHours: 1, pickupHours: 2 },
    { cycleDate: "2026-10-17", type: "Friday/Saturday", orders: 10, packHours: 3, deliveryHours: 3, pickupHours: 1 }
  ]);
  assert.deepEqual(buildPackDayCycles({ orderRows, laborRows, throughDate: "2026-10-16" }), [
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 10, packHours: 3, deliveryHours: 1, pickupHours: 2 }
  ]);
});

test("uses one 25th percentile target and lists all cycles from the last two months newest first", () => {
  const cycles = [
    { cycleDate: "2026-02-03", type: "Tuesday", orders: 60, packHours: 6, deliveryHours: 6, pickupHours: 2 },
    { cycleDate: "2026-08-14", type: "Friday/Saturday", orders: 60, packHours: 7, deliveryHours: 7, pickupHours: 2 },
    { cycleDate: "2026-08-15", type: "Friday/Saturday", orders: 60, packHours: 8, deliveryHours: 8, pickupHours: 2 },
    { cycleDate: "2026-10-13", type: "Tuesday", orders: 60, packHours: 9, deliveryHours: 9, pickupHours: 2 },
    { cycleDate: "2026-10-10", type: "Friday/Saturday", orders: 60, packHours: 0, deliveryHours: 8, pickupHours: 2 }
  ];
  const report = scorePackDayCycles(cycles, { throughDate: "2026-10-15" });
  assert.equal(report.windowStart, "2026-08-15");
  assert.equal(report.referenceCycleCount, 4);
  assert.equal(report.targetMinutesPerOrder, 15.5);
  assert.deepEqual(report.rows.map((row) => row.cycleDate), ["2026-10-13", "2026-10-10", "2026-08-15"]);
  const values = buildPackDayTeamViewValues(report, { asOfDate: "2026-10-15" });
  assert.equal(values[0][0], "CSA Packing, Delivery & Pickup Efficiency");
  assert.equal(values[1][1], 15.5);
  assert.equal(values[5][6], "vs. Target");
  assert.equal(values[6][0], "Tue, Oct 13");
  assert.equal(values[6][5], "=SUM(C7:E7)");
  assert.match(values[6][6], /\$B\$2/);
  assert.equal(values[7][6], "Awaiting timesheets");
});


test("averages use exactly the previous 30 operating cycles, even beyond the displayed two months", () => {
  const cycles = Array.from({ length: 33 }, (_, i) => ({
    cycleDate: new Date(Date.UTC(2026, 5, 1 + i * 4)).toISOString().slice(0, 10),
    orders: i % 2 ? 80 : 20,
    packHours: 2, deliveryHours: 1, pickupHours: 1
  }));
  const last = cycles.at(-1);
  last.orders = 1000;
  cycles[0].orders = 9999;
  const report = scorePackDayCycles(cycles.reverse(), { throughDate: last.cycleDate });
  assert.ok(report.rows.length < 30);
  const { averages } = report.rows[0];
  assert.equal(averages.operatingDays, 30);
  assert.equal(averages.orders, 50);
  assert.equal(averages.ordersPerMinute, 1500 / (30 * 240));
  assert.equal(averages.packMinutesPerOrder, 30 * 120 / 1500);
  assert.equal(averages.deliveryMinutesPerOrder, 30 * 60 / 1500);
  assert.equal(averages.pickupMinutesPerOrder, 30 * 60 / 1500);
  assert.equal(averages.totalMinutesPerOrder, 30 * 240 / 1500);
  assert.equal(averages.packMinutesPerOrder + averages.deliveryMinutesPerOrder + averages.pickupMinutesPerOrder, averages.totalMinutesPerOrder);
});

test("missing pickup does not become zero labor or improve the total, target, or historical efficiency", () => {
  const cycles = [
    { cycleDate: "2026-10-13", orders: 10, packHours: 1, deliveryHours: 1, pickupHours: 1 },
    { cycleDate: "2026-10-17", orders: 20, packHours: 1, deliveryHours: 1, pickupHours: 0 },
    { cycleDate: "2026-10-20", orders: 30, packHours: 1, deliveryHours: 1, pickupHours: 1 }
  ];
  const report = scorePackDayCycles(cycles, { throughDate: "2026-10-20" });
  const missing = report.rows[1];
  assert.equal(missing.complete, false);
  assert.equal(missing.totalMinutesPerOrder, null);
  assert.equal(missing.ordersPerMinute, null);
  assert.equal(missing.pickupMinutesPerOrder, null);
  assert.equal(report.referenceCycleCount, 2);
  assert.equal(report.targetMinutesPerOrder, 9);
  assert.equal(report.rows[0].averages.orders, 15);
  assert.equal(report.rows[0].averages.operatingDays, 2);
  assert.equal(report.rows[0].averages.totalMinutesPerOrder, null);
  assert.equal(report.rows[0].averages.packMinutesPerOrder, 4);
  assert.equal(report.rows[0].averages.deliveryMinutesPerOrder, 4);
  assert.equal(report.rows[0].averages.ordersPerMinute, null);
  assert.equal(report.rows[0].averages.pickupMinutesPerOrder, null);
  assert.equal(report.rows[2].averages.orders, null);
});


test("includes the first January operating cycle and excludes orders and labor before 2026", () => {
  const cycles = buildPackDayCycles({
    orderRows: [
      { fulfillmentDate: "2025-12-30", orders: 1000 },
      { fulfillmentDate: "2026-01-02", orders: 20 },
      { fulfillmentDate: "2026-01-03", orders: 38 }
    ],
    laborRows: [labor("2025-12-30", "packout", 10), labor("2026-01-02", "pick_ups", 1)],
    throughDate: "2026-01-03"
  });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].cycleDate, "2026-01-03");
  assert.equal(cycles[0].orders, 58);
  assert.equal(cycles[0].packHours, 0);
  assert.equal(cycles[0].pickupHours, 1);
});

test("daily order average includes all same-year operating cycles through the report date, independent of labor completeness", () => {
  const cycle = (cycleDate, orders) => ({ cycleDate, orders, packHours: 1, deliveryHours: 1, pickupHours: 1 });
  const cycles = [cycle("2025-12-30", 1000), cycle("2026-01-03", 58), cycle("2026-05-02", 100),
    cycle("2026-10-27", 77), cycle("2026-10-31", 900)];
  cycles[1].packHours = 0;
  const scored = scorePackDayCycles(cycles, { throughDate: "2026-10-27" });
  assert.deepEqual(scored.rows[0].dailyOrderAverage, { year: 2026, operatingDays: 3, orders: 235 / 3 });
});
