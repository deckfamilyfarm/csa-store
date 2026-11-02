import test from "node:test";
import assert from "node:assert/strict";
import { planDashboardVendorCosts, dashboardCostRawJson, rebuildDashboardVendorCosts } from "./dashboardVendorCosts.js";

const row = { id: 1, local_line_order_id: 10, product_id: 20, product_name: "Carrots", package_name: "1 lb", quantity: 2, retail_amount: 6,
  purchase_unit_price: 3, purchase_total: 6 };
const entry = { id: 30, product: 20, package_name: "1 lb", package_unit_price: 1, quantity_to_charge: 2, total_price: 6 };
const saved = value => ({ local_line_order_id: 10, raw_json: value });
const price = e => ({ price: e.package_unit_price, quantity: e.quantity_to_charge, totalPrice: e.package_unit_price * e.quantity_to_charge, retailTotal: e.total_price });

test("dashboard cost comes from the saved order, independently of retail or today's catalog", () => {
  const result = planDashboardVendorCosts([row], [saved(entry)], price);
  assert.deepEqual(result.issues, []);
  assert.equal(result.changes[0].unit, 1); assert.equal(result.changes[0].total, 2);
  assert.equal(row.retail_amount, 6);
  const rerun = planDashboardVendorCosts([{ ...row, purchase_unit_price: 1, purchase_total: 2 }], [saved(entry)], price);
  assert.equal(rerun.changes.length, 0);
});

test("reviewed incident correction is applied without changing the raw order price", () => {
  const result = planDashboardVendorCosts([row], [saved(entry)], e => ({ ...price(e), totalPrice: 1.5, costCorrection: { approved: true } }));
  assert.equal(result.correctedEntries, 1); assert.equal(result.changes[0].total, 1.5);
  const raw = JSON.parse(dashboardCostRawJson('{"Product":"Carrots"}', result.pricedRows[0], "reviewed-v2"));
  assert.equal(raw.Product, "Carrots"); assert.equal(raw._dashboardVendorCost.entries[0].package_unit_price, 1);
});

test("weighted charge costs are normalized to export packages without changing quantity", () => {
  const result = planDashboardVendorCosts([{ ...row, quantity: 1 }], [saved({ ...entry, quantity_to_charge: 2.5 })], price);
  assert.equal(result.changes[0].total, 2.5); assert.equal(result.changes[0].unit, 2.5);
});

test("missing prices and stale retail comparisons block repair; membership is excluded", () => {
  assert.equal(planDashboardVendorCosts([row], [], price).issues.length, 1);
  assert.equal(planDashboardVendorCosts([row], [saved({ ...entry, total_price: 7 })], price).issues.length, 1);
  assert.equal(planDashboardVendorCosts([{ ...row, category_name: "Membership" }], [], price).issues.length, 0);
});

test("repeated package lines retain the exact total with cent rounding", () => {
  const rows = [{ ...row, quantity: 1, retail_amount: 3 }, { ...row, id: 2, quantity: 1, retail_amount: 3 }];
  const result = planDashboardVendorCosts(rows, [saved(entry)], e => ({ ...price(e), totalPrice: 2.01 }));
  assert.equal(result.pricedRows.reduce((sum, r) => sum + Math.round(r.total * 100), 0), 201);
});

test("manual charges without a catalog product retain existing cost and are reported separately", () => {
  const result = planDashboardVendorCosts([{ ...row, product_id: 0, purchase_total: 1.5 }], [], price);
  assert.deepEqual(result.customRows, [1]); assert.deepEqual(result.issues, []);
  assert.deepEqual(result.changes, []);
});

test("cache repair rejects concurrent edits before writing any costs", async () => {
  const original = { ...row, raw_json: dashboardCostRawJson('{}', { entries: [entry] }, 'test') };
  const calls = [];
  const connection = {
    query: async sql => {
      calls.push(sql);
      return [[sql.includes('FOR UPDATE') ? { ...original, retail_amount: 7 } : original]];
    },
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback')
  };
  await assert.rejects(rebuildDashboardVendorCosts(connection, {
    apply: true, refreshMissing: false, pricing: { priceOrderEntry: price, PRICING_BASIS: 'test' }
  }), /changed during cost review/);
  assert.equal(calls.at(-1), 'rollback');
  assert.ok(!calls.some(call => call.startsWith('UPDATE')));
});
