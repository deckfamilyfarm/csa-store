import assert from "node:assert/strict";
import { test } from "node:test";
import { localLineProjection, squareProjection, localLineInputs } from "./productSyncAdapters.js";
import { buildSquarePriceAuditRow, buildVariationUpdateObject } from "./squareStoreSync.js";
import { incomingProposals } from "./productSyncIncoming.js";

test("Local Line confirms writable price inputs even when API-derived display fields are absent", () => {
  const payload = { name: "Milk", visible: true, set_inventory: 5, packages: [{ id: 4, name: "Bottle", unit_price: 7,
    package_price: 7, package_unit_price: 7, price_list_entries: [{ price_list: 1, product_price_list_entry: 9, adjustment: true, adjustment_type: 2, adjustment_value: 10, on_sale: true,
      on_sale_toggle: true, calculated_value: 7.7, strikethrough_display_value: 9, max_units_per_order: null, checked: true, dirty: true }] }] };
  const remote = { name: "Milk", visible: true, inventory: "5.000", irrelevantField: "keep", packages: [{ id:4, name:"Bottle", unit_price:"7.00", package_price:"7.0",
    price_list_entries: [{price_list_id:"1", product_price_list_entry:9, adjustment:true, adjustment_type:2, adjustment_value:"10.0", on_sale:"True", on_sale_toggle:true, strikethrough_display_value:"9.00", max_units_per_order:null}] }] };
  assert.deepEqual(localLineProjection(remote,payload),localLineProjection(payload,payload,true));
  remote.packages[0].price_list_entries[0].adjustment_value="20";
  assert.notDeepEqual(localLineProjection(remote,payload),localLineProjection(payload,payload,true));
});
test("Square updates retain unrelated fields while changing only the normal variation price", () => {
  const remote={id:"variation", type:"ITEM_VARIATION", version:9, item_variation_data:{item_id:"item", name:"Large", pricing_type:"FIXED_PRICING", price_money:{amount:900,currency:"USD"}, sku:"ABC", track_inventory:true}};
  const next=buildVariationUpdateObject(remote,800,"USD");
  assert.equal(next.item_variation_data.track_inventory,true); assert.equal(next.item_variation_data.sku,"ABC"); assert.equal(remote.item_variation_data.price_money.amount,900);
  assert.equal(squareProjection(next).amount,800);
});
test("Square uses source unit price for formulas, package price for standard products, and blocks missing prices", () => {
  const row={productId:1,packageId:2,productName:"Steak",vendorName:"Deck Family Farm",sourceUnitPrice:10,sourceMultiplier:0.54,minWeight:2,maxWeight:4,guestMarkup:2,
    saleOnSale:1,saleSaleDiscount:0.1,squareVariationId:"V",squareItemId:"I",squarePricingType:"FIXED_PRICING",squarePriceAmount:1000,squareCurrency:"USD"};
  const packages=new Map([[1,[{id:2,productId:1,name:"ea",price:42,numOfItems:3}]]]);
  const formula=buildSquarePriceAuditRow(row,packages,new Map()); assert.equal(formula.proposedAmount,900);
  const standard=buildSquarePriceAuditRow({...row,vendorName:"Other"},packages,new Map()); assert.equal(standard.proposedAmount,3780);
  const invalid=buildSquarePriceAuditRow({...row,sourceUnitPrice:null},new Map([[1,[{id:2,name:"ea",price:null}]]]),new Map()); assert.equal(invalid.status,"blocked");
});
test("incoming formula price drift is review only, catalog fixes remain selectable, and Membership is excluded", () => {
  const report={proposedUpdates:{storePackageUpdates:[{action:"update-store-package-from-localline",productId:1,packageId:2,changes:{price:{from:10,to:20},name:{from:"old",to:"new"}}}, {action:"update-store-package-from-localline",productId:3,packageId:4,changes:{price:{from:10,to:20}}}],pricelistRowUpdates:[{action:"update-pricelist-row-from-localline",productId:1,changes:{sourceUnitPrice:{from:10,to:20}}}]}};
  const rows=incomingProposals(report,[{id:1,vendorName:"Deck Family Farm",categoryName:"Meat"},{id:3,categoryName:"Membership"}]);
  assert.equal(rows.length,3);
  assert.equal(rows.filter(row=>row.supported).length,1);
  assert.deepEqual(rows.find(row=>row.supported).proposal.changes,{name:{from:"old",to:"new"}});
  assert.ok(rows.filter(row=>row.proposal.changes?.price).every(row=>!row.supported));
});
test("Local Line baselines ignore timestamps and cache prices but retain formula inputs", () => {
  const context={product:{id:1,name:"Milk",visible:1,inventory:2},vendor:{name:"Deck Family Farm"},profile:{sourceUnitPrice:"10.00"},sale:{onSale:0},packages:[{id:2,name:"ea",price:10}],packageMeta:[],imageUrls:[]};
  const before=localLineInputs(context);
  const cached={...context,product:{...context.product,updatedAt:new Date()},packageMeta:[{packageId:2,localLinePackageId:9,livePrice:20}]};
  assert.deepEqual(localLineInputs(cached),before);
  assert.notDeepEqual(localLineInputs({...context,profile:{sourceUnitPrice:11}}),before);
});
