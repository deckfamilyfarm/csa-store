import test from "node:test";
import assert from "node:assert/strict";
import { pricingWarningDetails, pricingChannelStatuses, productPricingWarnings } from "./pricingWarningDetails.js";

test("warning details include package blockers, audit errors and publication failures", () => {
  assert.deepEqual(pricingWarningDetails({ check: { error: "Square refresh failed", actions: [
    { platform: "localline", packageName: "2.5 oz", status: "blocked", message: "SNAP price-list entry is missing", warnings: ["SNAP price-list entry is missing"] },
    { platform: "square", status: "changed", releaseStatus: "held", releaseMessage: "Square price changed since review" },
    { platform: "localline", status: "synced", message: "No changes" }
  ] } }), [
    { label: "Server check", message: "Square refresh failed" },
    { label: "Local Line · 2.5 oz", message: "SNAP price-list entry is missing" },
    { label: "Square", message: "Square price changed since review" }
  ]);
  assert.deepEqual(pricingWarningDetails(null), []);
});

test('a successful Local Line-only check cannot hide the outstanding Square mapping', () => {
  const review = {check:{status:'completed',actions:[{platform:'localline',status:'changed',releaseStatus:'completed'}]}};
  const row = {input:{squareEnabled:true},publications:[{platform:'square',attempted:true}],approvedSquareLinks:0,sync:{channels:[
    {platform:'localline',state:'matched'},
    {platform:'square',state:'attention',reason:'Channel price or mapping needs checking; Publication blocked'}
  ]}};
  const result = pricingWarningDetails(review,row);
  assert.equal(result.length,1);
  assert.equal(result[0].label,'Square');
  assert.match(result[0].message,/no approved Square variation link/);
});

test('verified current destination suppresses an old blocker while preserving the other failure', () => {
  const review = {check:{actions:[{platform:'localline',status:'blocked',message:'Old Local Line issue'},
    {platform:'square',status:'changed',releaseStatus:'failed',releaseMessage:'Square connection interrupted'}]}};
  assert.deepEqual(pricingWarningDetails(review,{input:{squareEnabled:true},publications:[{platform:'square',attempted:true}],sync:{channels:[{platform:'localline',state:'matched'},
    {platform:'square',state:'attention',reason:'Publication failed'}]}}),
    [{label:'Square',message:'Square connection interrupted'}]);
});

test('Square pending publication is explained even when the latest audit omits Square', () => {
  assert.deepEqual(pricingWarningDetails(null,{input:{squareEnabled:true},publications:[{platform:'square',attempted:true}],approvedSquareLinks:1,sync:{channels:[
    {platform:'square',state:'attention',reason:'Publication pending'}]}}),
    [{label:'Square',message:'Square changes have not been published yet. Review them in Review & Publish.'}]);
});

test('status summary shows Local Line success and Square issue only when Square enabled', () => {
  const row = {input:{squareEnabled:true},approvedSquareLinks:0,publications:[{platform:'localline',status:'verified'},{platform:'square',attempted:true}],
    sync:{channels:[{platform:'localline',state:'matched'},{platform:'square',state:'attention',reason:'Publication blocked'}]}};
  const result = pricingChannelStatuses(row,null);
  assert.deepEqual(result[0],{platform:'localline',message:'Sync succeeded.'});
  assert.equal(result[1].platform,'square');
  assert.match(result[1].message,/no approved Square variation link/);
  assert.deepEqual(pricingChannelStatuses({...row,input:{squareEnabled:false}},null),[result[0]]);
});

test('an unattempted Square check never creates a warning icon or error', () => {
  const row={input:{squareEnabled:true},status:'partial',approvedSquareLinks:0,
    publications:[{platform:'localline',status:'verified',attempted:true},{platform:'square',status:'blocked',attempted:false}],
    sync:{channels:[{platform:'localline',state:'matched'},{platform:'square',state:'attention',reason:'Publication blocked'}]}};
  const review={check:{actions:[{platform:'square',status:'blocked',message:'Old audit-only mapping warning'}]}};
  assert.deepEqual(productPricingWarnings(row),[]);
  assert.deepEqual(pricingWarningDetails(review,row),[]);
  assert.equal(pricingChannelStatuses(row,review)[1].message,'Not synced yet.');
  row.publications[1].attempted=true;
  assert.equal(productPricingWarnings(row).length,1);
  assert.match(pricingWarningDetails(review,row)[0].message,/Old audit-only/);
});
