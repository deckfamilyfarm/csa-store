import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicatePricingSnapshot } from './duplicateEnterprisePricing.js';
test('duplication remaps packages, preserves pricing rules and leaves the original untouched', () => {
  const original={input:{markupCategory:'deckHyland',customMarkupBp:null,purchaseCosts:[{enterpriseId:1,cost:'5.00'}],squareEnabled:true,saleBp:2000,packages:[{packageId:10,minWeight:3,maxWeight:5}]},
    output:{squareUnitCents:1000,saleBp:2000,packages:[{packageId:10,localLineRegularCents:3600,localLineSaleCents:2880}]}};
  const copy=duplicatePricingSnapshot(original,[{id:10}],[{id:200}]);
  assert.equal(copy.input.packages[0].packageId,200);assert.equal(copy.input.markupCategory,'deckHyland');
  assert.deepEqual(copy.input.purchaseCosts,original.input.purchaseCosts);
  assert.equal(copy.output.packages[0].localLineSaleCents,3600);assert.equal(copy.input.saleBp,0);
  assert.equal(original.input.packages[0].packageId,10);assert.equal(original.output.packages[0].localLineSaleCents,2880);
  assert.throws(()=>duplicatePricingSnapshot(original,[{id:11}],[{id:201}]),/Package definitions changed/);
});
