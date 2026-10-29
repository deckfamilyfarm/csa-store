import test from "node:test";
import assert from "node:assert/strict";
import { normalizePromotion, promotionPrices, promotionsOverlap, promotionIsActive, buildSquarePromotionCatalogObjects, localLineSalePatch, localLineSaleMatches } from "./enterprisePromotionsCore.js";

test("promotion keeps regular Square price and calculates identical Local Line sale baskets", () => {
  const sale = normalizePromotion({ discountBp: 2000, startAt: "2026-11-01T16:00:00Z", endAt: "2026-11-02T16:00:00Z", packageIds: [10], channels: ["square", "localline"], squareLocationIds: ["MARKET"], timezone: "America/Los_Angeles" });
  const [price] = promotionPrices([{ packageId: 10, localLineRegularCents: 3600 }], sale.discountBp);
  assert.equal(price.saleCents, 2880);
  assert.deepEqual(Object.values(price.baskets), [2880, 2880, 2880, 2880]);
  const objects = buildSquarePromotionCatalogObjects(7, sale, ["VARIATION"]);
  assert.deepEqual(objects.map(row => row.type), ["DISCOUNT", "PRODUCT_SET", "PRICING_RULE"]);
  assert.equal(objects[0].discount_data.percentage, "20.00");
  assert.deepEqual(objects[1].product_set_data.product_ids_any, ["VARIATION"]);
  assert.equal(objects[2].pricing_rule_data.application_mode, "AUTOMATIC");
  assert.equal(objects[2].pricing_rule_data.valid_until_date, "2026-11-02");
  assert.equal(objects[2].pricing_rule_data.valid_until_local_time, "08:00:00");
  assert.ok(objects.every(row => row.present_at_location_ids[0] === "MARKET"));
});

test("open-ended sales remain active without an artificial Square expiry and block overlapping sales", () => {
  const input = {discountBp:2000,startAt:"2026-11-01T16:00:00Z",packageIds:[10],channels:["square","localline"],squareLocationIds:["MARKET"],timezone:"America/Los_Angeles"};
  for (const endAt of [null, undefined, '']) {
    const sale=normalizePromotion({...input,endAt});
    assert.equal(sale.endAt,null);
    assert.equal(promotionIsActive(sale,Date.parse("2099-12-31T00:00:00Z")),true);
    assert.equal(promotionIsActive(sale,Date.parse("2026-11-01T15:59:59Z")),false);
    assert.equal(promotionsOverlap(sale,{...sale,startAt:"2099-01-01T00:00:00Z"}),true);
    assert.equal(promotionsOverlap(sale,{...sale,startAt:"2026-10-01T00:00:00Z",endAt:sale.startAt}),false);
    const rule=buildSquarePromotionCatalogObjects(1,sale,["V1"]).find(o=>o.type==='PRICING_RULE').pricing_rule_data;
    assert.equal(rule.valid_from_date,'2026-11-01');assert.equal(rule.valid_from_local_time,'08:00:00');
    assert.equal(Object.hasOwn(rule,'valid_until_date'),false);
    assert.equal(Object.hasOwn(rule,'valid_until_local_time'),false);
    assert.equal(Object.hasOwn(rule,'time_period_ids'),false);
  }
  for(const endAt of ['invalid','2026-10-01T00:00:00Z']) assert.throws(()=>normalizePromotion({...input,endAt}),/Sale end/);
  assert.throws(()=>normalizePromotion({...input,startAt:null}),/valid sale start/);
});

test("overlap detection is scoped to package and channel", () => {
  const a = normalizePromotion({ discountBp: 1000, startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-02T00:00:00Z", packageIds: [1], channels: ["localline"] });
  const b = { ...a, startAt: "2026-11-01T12:00:00Z", packageIds: [1] };
  assert.equal(promotionsOverlap(a, b), true);
  assert.equal(promotionsOverlap(a, { ...b, channels: ["square"] }), false);
  assert.equal(promotionsOverlap(a, { ...b, packageIds: [2] }), false);
});

test("Local Line sale patch preserves regular unit price and creates four crossed-out sale entries", () => {
  const remote = { vendor: 9, packages: [
    { id: 20, name: "Chuck Roast", price_list_entries: [1, 2, 3, 4].map(id => ({ id: id + 100, price_list: id, adjustment_type: 3, adjustment_value: 36, on_sale_toggle: false })) },
    { id: 21, name: "Other package", unit_price: 5, price_list_entries: [{ id: 201, price_list: 1, adjustment: true, adjustment_type: 2, adjustment_value: 10 }] }
  ] };
  const selected = [{ localLinePackageId: 20, regularCents: 3600, saleCents: 2880 }];
  const patch = localLineSalePatch(remote, selected, [1, 2, 3, 4], true);
  assert.equal(patch.packages[0].unit_price, 36);
  assert.deepEqual(patch.packages[0].price_list_entries.map(row => [row.adjustment_value, row.strikethrough_display_value]), [[28.8, 36], [28.8, 36], [28.8, 36], [28.8, 36]]);
  assert.deepEqual(patch.packages[1].price_list_entries.map(row => [row.adjustment_type, row.adjustment_value]), [[2, 10]], "unselected package remains in the patch with its current pricing");
  assert.equal(localLineSaleMatches(remote, selected, [1, 2, 3, 4], false), true);
  assert.equal(localLineSaleMatches(remote, selected, [1, 2, 3, 4], true), false);
  const live = structuredClone(remote);
  live.packages[0].price_list_entries.forEach(row => { row.adjustment_value = 28.8; row.on_sale_toggle = true; });
  assert.equal(localLineSaleMatches(live, selected, [1, 2, 3, 4], true), true);
});
