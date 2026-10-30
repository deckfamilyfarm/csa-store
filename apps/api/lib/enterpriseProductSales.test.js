import {test} from 'node:test';
import assert from 'node:assert/strict';
import {salePrice, applySaleOutput, effectiveProductSale} from './enterpriseProductSales.js';
test('sale prices use rounded regular amounts without modifying inputs or vendor costs',()=>{
  const output={buyFromTenThousandths:50000,squareUnitCents:1000,packages:[{packageId:1,localLineRegularCents:3600,squareVariationCents:1000}]};
  const sale=applySaleOutput(output,{active:true,discountBp:2000,channels:['localline','square']});
  assert.equal(sale.packages[0].localLineSaleCents,2880);
  assert.equal(sale.squareSaleUnitCents,800);
  assert.equal(sale.buyFromTenThousandths,50000);
  assert.equal(output.packages[0].localLineSaleCents,undefined);
  assert.equal(salePrice(999,1500),849);
  assert.equal(applySaleOutput(output,{active:true,discountBp:2000,channels:['localline']}).squareSaleUnitCents,1000);
});
test('explicit local off wins over published sale; future and partial-package sales require review',()=>{
  const promotion={id:2,status:'active',input:{packageIds:[1],discountBp:2000,channels:['localline'],startAt:'2020-01-01',endAt:null}};
  assert.equal(effectiveProductSale(1,[{packageId:1}],{revision:2,discount_bp:0,promotion_id:3},[promotion]).active,false);
  assert.equal(effectiveProductSale(1,[{packageId:1}],null,[promotion]).discountBp,2000);
  assert.equal(effectiveProductSale(1,[{packageId:1},{packageId:2}],null,[promotion]).complex,true);
  assert.equal(effectiveProductSale(1,[{packageId:1}],null,[{...promotion,input:{...promotion.input,startAt:'2100-01-01'}}]).active,false);
});
