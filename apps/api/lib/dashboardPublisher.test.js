import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardRows,
  buildDashboardV2Rows,
  buildMonthlyDashboardSubscriberMap,
  isEmployeeSubscriberSnapshotRow
} from "./dashboardPublisher.js";

const expectedSubscriberRows = [
  "New Subscribers",
  "Exiting Subscribers",
  "Regular subscribers",
  "SNAP subscribers",
  "Employee subscribers",
  "Total Subscribers",
  "Average items Per order",
  "Average Order Amount",
  "Sales compared to yearly average"
];

function rowByLabel(values, label) {
  const row = values.find((cells) => cells[1] === label);
  assert.ok(row, `${label} exists`);
  return row;
}

function assertGivensOrder(values) {
  const givensIndex = values.findIndex((row) => row[0] === "GIVENS");
  const nextSectionIndex = values.findIndex((row, index) => index > givensIndex && row[0]);
  const labels = values.slice(givensIndex + 1, nextSectionIndex).map((row) => row[1]);
  const requested = labels.filter((label) => expectedSubscriberRows.includes(label));
  assert.deepEqual(requested, expectedSubscriberRows);
}

test("weekly and monthly subscriber summaries share the requested GIVENS order", () => {
  const week = { start: "2026-10-05", end: "2026-10-11", label: "Oct 5", year: 2026 };
  const month = { start: "2026-10-01", end: "2026-10-31", label: "Oct", year: 2026, started: true, weekStarts: new Set(["2026-10-01"]) };
  const subscribers = {
    newSubscribers: 4,
    exitingSubscribers: 2,
    regularSubscribers: 306,
    snapSubscribers: 12,
    employeeSubscribers: 14,
    totalSubscribers: 332
  };
  const weekly = buildDashboardRows(
    [week], new Map(),
    { [week.start]: { numOrders: 20, numGuestOrders: 3, averageItemsPerOrder: 7, averageOrderAmount: 80, totalSales: 1600 } },
    {}, {}, [], { [week.start]: subscribers }
  );
  const monthly = buildDashboardV2Rows({
    months: [month],
    manualValueMap: new Map(),
    monthlyKpiMap: { "2026-10-01": { numOrders: 20, totalItemsWeightedByOrder: 140, totalOrderAmountWeightedByOrder: 1600, totalSales: 1600 } },
    monthlySubscriberMap: { "2026-10-01": subscribers }
  });

  assertGivensOrder(weekly.values);
  assertGivensOrder(monthly.values);
  assert.equal(rowByLabel(weekly.values, "Regular subscribers").at(-1), 306);
  assert.equal(rowByLabel(monthly.values, "Employee subscribers").at(-1), 14);
  assert.equal(rowByLabel(monthly.values, "Average items Per order").at(-1), 7);
  assert.equal(rowByLabel(monthly.values, "Average Order Amount").at(-1), 80);
  assert.equal(rowByLabel(monthly.values, "Sales compared to yearly average").at(-1), 0);
});

test("monthly subscriber rollup retains the latest regular and employee counts", () => {
  const weeks = [
    { start: "2026-10-05" },
    { start: "2026-10-12" }
  ];
  const map = buildMonthlyDashboardSubscriberMap(weeks, {
    "2026-10-05": { newSubscribers: 2, exitingSubscribers: 1, regularSubscribers: 300, snapSubscribers: 12, employeeSubscribers: 13, totalSubscribers: 325 },
    "2026-10-12": { newSubscribers: 3, exitingSubscribers: 2, regularSubscribers: 306, snapSubscribers: 12, employeeSubscribers: 14, totalSubscribers: 332 }
  });
  assert.deepEqual(map["2026-10-01"], {
    newSubscribers: 5,
    exitingSubscribers: 3,
    regularSubscribers: 306,
    snapSubscribers: 12,
    employeeSubscribers: 14,
    totalSubscribers: 332
  });
});

test("employee tiers match the subscription export amounts used by the forecast", () => {
  for (const amount of ["100.00", "$150.00", "250.00"]) {
    assert.equal(isEmployeeSubscriberSnapshotRow({ Total: amount }), true);
  }
  for (const amount of ["120.00", "200.00", "300.00", "500.00"]) {
    assert.equal(isEmployeeSubscriberSnapshotRow({ Total: amount }), false);
  }
});

test("monthly sales use the same-year monthly baseline and order averages are weighted", () => {
  const months = [
    { start: "2026-01-01", year: 2026, started: true, weekStarts: new Set(["2026-01-01"]) },
    { start: "2026-02-01", year: 2026, started: true, weekStarts: new Set(["2026-02-01"]) }
  ];
  const dashboard = buildDashboardV2Rows({
    months,
    summaryPeriods: [{ key: "v2:2026:total", label: "Total", year: 2026, started: true, weekStarts: new Set(["2026-01-01", "2026-02-01"]) }],
    manualValueMap: new Map(),
    monthlyKpiMap: {
      "2026-01-01": { numOrders: 10, totalItemsWeightedByOrder: 50, totalOrderAmountWeightedByOrder: 1000, totalSales: 100 },
      "2026-02-01": { numOrders: 30, totalItemsWeightedByOrder: 270, totalOrderAmountWeightedByOrder: 6000, totalSales: 300 }
    }
  });
  assert.deepEqual(rowByLabel(dashboard.values, "Average items Per order").slice(4), [8, 5, 9]);
  assert.deepEqual(rowByLabel(dashboard.values, "Average Order Amount").slice(4), [175, 100, 200]);
  assert.deepEqual(rowByLabel(dashboard.values, "Sales compared to yearly average").slice(4), ["", -0.5, 0.5]);
});

test("weekly fulfillment time follows Num Orders, uses hours independently of wages, and weights period totals", () => {
  const weeks = ["2026-01-05", "2026-04-06", "2026-04-13", "2026-04-20", "2026-04-27"]
    .map((start) => ({ start, end: new Date(Date.parse(start) + 6 * 86400000).toISOString().slice(0, 10), label: start, year: 2026 }));
  const kpi = Object.fromEntries(weeks.map((week, index) => [week.start, { numOrders: [10, 30, 50, 0, 100][index] }]));
  const labor = {
    "2026-01-05": { totalWages: 0, taskHours: { packout: 1, delivery: 2, pick_ups: 1 } },
    "2026-04-06": { totalWages: 9999, taskHours: { dairy_and_frozen_packing: 2, delivery: 3, pick_ups: 1 } },
    "2026-04-13": { taskHours: { packout: 1, delivery: 2 } },
    "2026-04-20": { taskHours: { packout: 1, delivery: 2, pick_ups: 1 } },
    "2026-04-27": { taskHours: { packout: 99, delivery: 99, pick_ups: 99 } }
  };
  const periods = [
    { label: "Total", started: true, weekStarts: new Set(weeks.map((w) => w.start)) },
    { label: "Q1", started: true, weekStarts: new Set(["2026-01-05"]) },
    { label: "Q2", started: true, weekStarts: new Set(weeks.slice(1).map((w) => w.start)) },
    { label: "Q3", started: false }, { label: "Q4", started: false }
  ];
  const report = buildDashboardRows(weeks, new Map(), kpi, {}, labor, [], {}, new Set(weeks.slice(0, 4).map((w) => w.start)), periods);
  const ordersIndex = report.values.findIndex((row) => row[1] === "Num Orders");
  assert.equal(ordersIndex, 5);
  const row = report.values[ordersIndex + 1];
  assert.equal(row[1], "Pack / Delivery / Pickup (min/order)");
  assert.equal(row[2], "AUTO");
  assert.deepEqual(row.slice(4, 9), [
    '=IF(OR(COUNT(J6,K6)<>2,MIN(J6,K6)<=0),"",600/SUM(J6,K6))',
    '=IF(OR(COUNT(J6)<>1,MIN(J6)<=0),"",240/SUM(J6))',
    '=IF(OR(COUNT(K6)<>1,MIN(K6)<=0),"",360/SUM(K6))', "", ""
  ]);
  assert.deepEqual(row.slice(9), [
    '=IF(OR(COUNT(J6)<>1,MIN(J6)<=0),"",240/SUM(J6))',
    '=IF(OR(COUNT(K6)<>1,MIN(K6)<=0),"",360/SUM(K6))', "", "", ""
  ]);
  const metadata = report.metricRows.find((metric) => metric.rowIndex === ordersIndex + 1);
  assert.equal(metadata.valueType, "minutes");
  assert.match(metadata.note, /eligible completed weeks only/);
  assert.match(rowByLabel(report.values, "Num Subscriber Orders")[4], /E6-E9/);
});
