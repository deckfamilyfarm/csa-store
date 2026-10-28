import assert from "node:assert/strict";
import test from "node:test";
import { getFulfillmentLaborMinutes, buildFulfillmentEfficiencyFormula } from "./dashboardFulfillmentEfficiency.js";

test("fulfillment minutes include both packing tasks, delivery, and pickups only", () => {
  assert.equal(getFulfillmentLaborMinutes({ packout: 2, dairy_and_frozen_packing: 1, delivery: 3, pick_ups: 0.5, administrative: 100 }), 390);
  assert.equal(getFulfillmentLaborMinutes({ dairy_and_frozen_packing: 1, delivery: 1, pick_ups: 1 }), 180);
  assert.equal(getFulfillmentLaborMinutes({ packout: 1.23, delivery: 2.34, pick_ups: 0.56 }), 247.8);
});

test("missing labor stays unavailable instead of being reported as zero", () => {
  assert.equal(getFulfillmentLaborMinutes(), null);
  for (const missing of ["packout", "delivery", "pick_ups"]) {
    const hours = { packout: 1, delivery: 1, pick_ups: 1 };
    delete hours[missing];
    assert.equal(getFulfillmentLaborMinutes(hours), null);
  }
  assert.equal(getFulfillmentLaborMinutes({ packout: 1, delivery: Infinity, pick_ups: 1 }), null);
});

test("period ratios divide total minutes by matching orders, excluding missing labor and zero orders", () => {
  assert.equal(buildFulfillmentEfficiencyFormula([
    { minutes: 240, orders: 10, orderCell: "J6" },
    { minutes: 360, orders: 30, orderCell: "K6" },
    { minutes: null, orders: 50, orderCell: "L6" },
    { minutes: 999, orders: 0, orderCell: "M6" }
  ]), '=IF(OR(COUNT(J6,K6)<>2,MIN(J6,K6)<=0),"",600/SUM(J6,K6))');
  assert.equal(buildFulfillmentEfficiencyFormula([{ minutes: 20, orders: 0, orderCell: "J6" }]), "");
  assert.throws(() => buildFulfillmentEfficiencyFormula([{ minutes: 20, orders: 1, orderCell: "invalid" }]), /Invalid Dashboard order cell/);
});
