import test from "node:test";
import assert from "node:assert/strict";
import { compareLocalChannelPrices, liveLocalLinePriceComparison, refreshEnterprisePriceCache } from "./enterprisePricingComparison.js";
const revision = { input: { squareEnabled: true, pricingUnit: "lb" }, output: { squareUnitCents: 1000, packages: [{ packageId: 7, localLineRegularCents: 3600 }] } };
const record = { packages: [{ id: 7, name: "Roast", metadata: { localLinePackageId: 70 } }],
  localLinePrices: ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"].map(listName => ({ packageId: 7, listName, finalPrice: "36.00" })),
  squarePrices: [{ packageId: 7, priceCents: 1050 }] };
test("review compares three active baskets and eligible Square prices without inventing verification", () => {
  const result = compareLocalChannelPrices(revision, record);
  assert.equal(result.length, 4);
  assert.equal(result.filter(row => row.status === "matches").length, 3);
  assert.equal(result.at(-1).status, "different");
  assert.equal(result.at(-1).currentCents, 1050);
});
test("Square disabled products have no Square comparisons; missing prices and mappings need checking", () => {
  const result = compareLocalChannelPrices({ ...revision, input: { squareEnabled: false } }, { ...record, packages: [], localLinePrices: [] });
  assert.equal(result.length, 3);
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
  const db={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
    query:async(sql,args)=>{calls.push({sql,args});return [sql.includes('FROM packages')?[{id:7,remoteId:80}]:sql.includes('FROM price_lists')?[1,2,3,4].map(id=>({id,remoteId:id,name:`List ${id}`})):[]];}};
  await refreshEnterprisePriceCache({getConnection:async()=>db},10,remote,payload);
  const updates=calls.filter(c=>c.sql.startsWith('UPDATE'));
  assert.equal(updates.length,4);
  assert(updates.every(call=>call.sql.startsWith('UPDATE local_line_price_list_entries SET') && call.args[4]===10 && call.args[5]===80));
  assert.deepEqual(updates.map(call=>call.args[0]),[36,0,null,null]);
  const inserts=calls.filter(c=>c.sql.startsWith('INSERT'));
  assert.equal(inserts.length,3,'Only existing remote entries with established local mappings can be cached');
  assert(inserts.every(c=>c.sql.includes('WHERE NOT EXISTS') && c.args[2]===7));
  assert.deepEqual(inserts.map(c=>c.args[8]),[36,0,null],'Cache observed values, never the proposed $40');
});
