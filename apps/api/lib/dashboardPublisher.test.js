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
