import test from "node:test";
import assert from "node:assert/strict";
import { compareLocalChannelPrices, liveLocalLinePriceComparison, refreshEnterprisePriceCache } from "./enterprisePricingComparison.js";
const revision = { input: { squareEnabled: true, pricingUnit: "lb" }, output: { squareUnitCents: 1000, packages: [{ packageId: 7, localLineRegularCents: 3600 }] } };
const record = { packages: [{ id: 7, name: "Roast", metadata: { localLinePackageId: 70 } }],
  localLinePrices: ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"].map(listName => ({ packageId: 7, listName, finalPrice: "36.00" })),
  squarePrices: [{ packageId: 7, priceCents: 1050 }] };
test("review compares four baskets and eligible Square prices without inventing verification", () => {
  const result = compareLocalChannelPrices(revision, record);
  assert.equal(result.length, 5);
  assert.equal(result.filter(row => row.status === "matches").length, 4);
  assert.equal(result.at(-1).status, "different");
  assert.equal(result.at(-1).currentCents, 1050);
});
test("Square disabled products have no Square comparisons; missing prices and mappings need checking", () => {
  const result = compareLocalChannelPrices({ ...revision, input: { squareEnabled: false } }, { ...record, packages: [], localLinePrices: [] });
  assert.equal(result.length, 4);
  assert(result.every(row => row.destination === "Local Line" && row.status === "needs-check"));
  assert(compareLocalChannelPrices(revision, undefined).every(row => row.status === "needs-check"));
});

test('live comparison preserves unknown prices, matches basket IDs, and refreshes only remote cache', async () => {
  const remote = {packages:[{id:80,name:'Roast',price_list_entries:[
    {price_list_id:1,adjustment_type:2,adjustment_value:50,calculated_value:36},
    {price_list_id:2,adjustment_type:3,adjustment_value:0},
    {price_list_id:3,adjustment_type:2,adjustment_value:50}
  ]}]};
  const payload={packages:[{id:80,name:'Roast',price_list_entries:[1,2,3,4].map(price_list=>({price_list,calculated_value:40}))}]};
  const rows=liveLocalLinePriceComparison(remote,payload);
  assert.deepEqual(rows.map(row=>row.currentCents),[3600,0,null,null]);
  assert.deepEqual(rows.map(row=>row.localCents),[4000,4000,4000,4000]);
  const calls=[];
  await refreshEnterprisePriceCache({query:async(sql,args)=>calls.push({sql,args})},10,remote,payload);
  assert.equal(calls.length,4);
  assert(calls.every(call=>call.sql.startsWith('UPDATE local_line_price_list_entries SET') && call.args[4]===10 && call.args[5]===80));
  assert.deepEqual(calls.map(call=>call.args[0]),[36,0,null,null]);
});
