import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPricelistSheetValues,
  buildSimplePricelistValues,
  updateGoogleSheet
} from "./exportMasterPricelist.js";

const columns = [
  "id", "localLineProductID", "category", "vendor", "productName", "retailSalesPrice",
  "dff_unit_of_measure", "packageName", "lowest_weight", "highest_weight", "sale",
  "saleDiscount", "squareSalePrice", "packageCount", "description", "FFCSAFactor",
  "avgWeightUsed", "packageQuantityUsed", "ffcsaPurchasePrice", "ffcsaMemberSalesPrice",
  "memberMarkup", "track_inventory", "visible", "remoteSyncStatus", "remoteSyncedAt"
];

test("simple prices uses source results for calculated prices with ID last", () => {
  const source = [columns, [42], [43]];
  source.highlightedRowIndices = [2];
  const values = buildSimplePricelistValues(source, "Prices");
  assert.deepEqual(values[0], [
    "category", "vendor", "productName", "retailSalesPrice", "dff_unit_of_measure",
    "packageName", "sale", "saleDiscount", "squareSalePrice", "ffcsaMemberSalesPrice", "id"
  ]);
  assert.equal(values.length, source.length);
  // Calculated columns must reference the full sheet's results, not formulas
  // with shifted/missing inputs. Blank sale prices must stay blank, not zero.
  assert.equal(values[1][8], '=IF(\'Prices\'!$M$2="","",\'Prices\'!$M$2)');
  assert.equal(values[2][9], '=IF(\'Prices\'!$T$3="","",\'Prices\'!$T$3)');
  assert.equal(values[1][10], '=IF(\'Prices\'!$A$2="","",\'Prices\'!$A$2)');
  assert.deepEqual(values.highlightedRowIndices, [2]);
  assert.deepEqual(source[1], [42]);
});

test("source headers determine references and apostrophes in tab names are escaped", () => {
  const values = buildSimplePricelistValues([[...columns].reverse(), []], "Vendor's prices");
  assert.equal(values[1][10], '=IF(\'Vendor\'\'s prices\'!$Y$2="","",\'Vendor\'\'s prices\'!$Y$2)');
});

test("empty exports keep headers and incomplete source columns fail before publishing", () => {
  assert.equal(buildSimplePricelistValues([columns], "Prices").length, 1);
  assert.throws(() => buildSimplePricelistValues([["id"]], "Prices"), /Missing source pricelist column/);
});

function pricingFixture(overrides = {}) {
  return {
    productRows: [{ id: 42, name: "Milk", vendorId: 1, categoryId: 1 }],
    packageRows: [{ id: 100, productId: 42, name: "Bottle", price: 10 }],
    profileRows: [{
      productId: 42, sourceUnitPrice: 10, unitOfMeasure: "each",
      onSale: 1, saleDiscount: 0.25
    }],
    categoryRows: [{ id: 1, name: "Dairy" }],
    vendorRows: [{ id: 1, name: "Deck Family Farm" }],
    ...overrides
  };
}

function exportedProduct(result) {
  return Object.fromEntries(result.sheetValues[0].map((name, index) => [name, result.sheetValues[1][index]]));
}

test("Google master pricelist defaults to Deck Family Farm, Hyland, and Creamy Cow", () => {
  const fixture = pricingFixture({
    productRows: [
      { id: 1, name: "Beef", vendorId: 1, categoryId: 1 },
      { id: 2, name: "Cheese", vendorId: 2, categoryId: 1 },
      { id: 3, name: "Milk", vendorId: 3, categoryId: 1 },
      { id: 4, name: "Apples", vendorId: 4, categoryId: 1 },
      { id: 5, name: "Unknown vendor", vendorId: 99, categoryId: 1 },
      { id: 6, name: "Deleted beef", vendorId: 1, categoryId: 1, isDeleted: 1 },
      { id: 7, name: "Membership", vendorId: 1, categoryId: 2 }
    ],
    vendorRows: [
      { id: 1, name: "Deck Family Farm" },
      { id: 2, name: "Hyland" },
      { id: 3, name: "Creamy Cow" },
      { id: 4, name: "Other Farm" }
    ],
    categoryRows: [{ id: 1, name: "Food" }, { id: 2, name: "Membership" }]
  });
  const result = buildPricelistSheetValues(fixture);
  assert.deepEqual(result.sheetValues.slice(1).map(row => row[0]), [1, 2, 3]);
  assert.deepEqual(result.vendorNames, ["Creamy Cow", "Deck Family Farm", "Hyland"]);
  assert.equal(result.rowCount, 3);
  assert.equal(buildSimplePricelistValues(result.sheetValues, "Prices").length, 4);

  // Explicitly unfiltered callers can still build rows for other pricelist tools.
  const allVendors = buildPricelistSheetValues({ ...fixture, vendorNameMatcher: null });
  assert.deepEqual(allVendors.sheetValues.slice(1).map(row => row[0]), [4, 1, 2, 3, 5]);
});

test("a Google export with no matching vendors stays empty", () => {
  const result = buildPricelistSheetValues(pricingFixture({
    vendorRows: [{ id: 1, name: "Other Farm" }]
  }));
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.vendorNames, []);
  assert.equal(result.sheetValues.length, 1);
});

test("ended sales override stale profile sales and clear all sale-only cells", () => {
  for (const onSale of [false, 0, "false", "FALSE", "0", "", 2, "yes"]) {
    const result = buildPricelistSheetValues(pricingFixture({
      saleRows: [{ productId: 42, onSale, saleDiscount: 0.25 }]
    }));
    const row = exportedProduct(result);
    assert.equal(row.sale, "", `sale flag ${JSON.stringify(onSale)}`);
    assert.equal(row.saleDiscount, "");
    assert.equal(row.squareSalePrice, "");
    // Ended sales stay in the regular pricelist with their ordinary prices.
    assert.equal(result.rowCount, 1);
    assert.equal(row.retailSalesPrice, 10);
    assert.ok(row.ffcsaMemberSalesPrice.startsWith("=IF("));
  }
});

test("explicitly active sales use the current sale discount instead of the stale profile", () => {
  for (const onSale of [true, 1, "true", " TRUE ", "1"]) {
    const fixture = pricingFixture({ saleRows: [{ productId: 42, onSale, saleDiscount: "0.10" }] });
    fixture.profileRows[0].onSale = 0;
    const row = exportedProduct(buildPricelistSheetValues(fixture));
    assert.equal(row.sale, "TRUE", `sale flag ${JSON.stringify(onSale)}`);
    assert.equal(row.saleDiscount, 0.1);
    assert.ok(row.squareSalePrice.startsWith('=IF(K2,'));
    assert.ok(row.squareSalePrice.endsWith(',"")'));
  }
});

test("profile-only sales remain supported but missing or false flags never enable a sale", () => {
  const fixture = pricingFixture();
  assert.equal(exportedProduct(buildPricelistSheetValues(fixture)).sale, "TRUE");
  fixture.profileRows[0].onSale = "false";
  assert.equal(exportedProduct(buildPricelistSheetValues(fixture)).sale, "");
  delete fixture.profileRows[0].onSale;
  assert.equal(exportedProduct(buildPricelistSheetValues(fixture)).saleDiscount, "");
  fixture.profileRows = [];
  fixture.saleRows = [{ productId: 42, onSale: true, saleDiscount: 0.15 }];
  assert.equal(exportedProduct(buildPricelistSheetValues(fixture)).saleDiscount, 0.15);
});

test("refresh replaces ended sales and removes old rows from both Google pricelist tabs", async (t) => {
  const tabs = new Map([
    ["Prices", { sheetId: 0, values: [] }],
    ["simple prices", { sheetId: 1, values: [] }]
  ]);
  const clears = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const requestUrl = new URL(url);
    if (!requestUrl.pathname.includes("/values/")) {
      return { ok: true, json: async () => ({ sheets: [...tabs].map(([title, tab]) => ({
        properties: { title, sheetId: tab.sheetId, gridProperties: { rowCount: 1000, columnCount: 30 } }
      })) }) };
    }
    const range = decodeURIComponent(requestUrl.pathname.split("/values/")[1]);
    if (options.method === "POST") {
      // A whole-tab clear must reach rows/columns beyond the new export dimensions.
      const match = range.match(/^'([^']+)':clear$/);
      assert.ok(match, `Expected a whole-tab clear, received ${range}`);
      tabs.get(match[1]).values = [];
      clears.push(match[1]);
    } else {
      assert.equal(options.method, "PUT");
      const title = range.match(/^'([^']+)'!/)[1];
      const tab = tabs.get(title);
      assert.deepEqual(tab.values, [], "Clear old values before writing the new export");
      tab.values = JSON.parse(options.body).values;
    }
    return { ok: true };
  });

  const initial = buildPricelistSheetValues(pricingFixture()).sheetValues;
  tabs.get("Prices").values = [...initial, [99, "Removed sale product", "old sale formula"]];
  tabs.get("simple prices").values = [...buildSimplePricelistValues(initial, "Prices"), ["old row"]];

  const refreshed = buildPricelistSheetValues(pricingFixture({
    saleRows: [{ productId: 42, onSale: false, saleDiscount: 0.25 }]
  })).sheetValues;
  const simpleValues = buildSimplePricelistValues(refreshed, "Prices");
  for (const [sheetName, values] of [["prices", refreshed], ["simple prices", simpleValues]]) {
    await updateGoogleSheet({ accessToken: "test-token", spreadsheetId: "test-sheet", sheetName, values });
  }
  assert.deepEqual(clears, ["Prices", "simple prices"]);
  assert.deepEqual(tabs.get("Prices").values, refreshed);
  assert.deepEqual(tabs.get("simple prices").values, simpleValues);
  assert.deepEqual(tabs.get("Prices").values[1].slice(10, 13), ["", "", ""]);
  assert.equal(tabs.get("Prices").values.length, 2);
  assert.equal(tabs.get("simple prices").values.length, 2);

  // An empty catalog must remove the final product, too, leaving only headers.
  const empty = buildPricelistSheetValues().sheetValues;
  for (const [sheetName, values] of [["Prices", empty], ["simple prices", buildSimplePricelistValues(empty, "Prices")]]) {
    await updateGoogleSheet({ accessToken: "test-token", spreadsheetId: "test-sheet", sheetName, values });
    assert.equal(tabs.get(sheetName).values.length, 1);
  }
});

test("a failed Google clear aborts the export instead of claiming stale rows were removed", async (t) => {
  const methods = [];
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    methods.push(options.method || "GET");
    if (!options.method) {
      return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 0, title: "prices" } }] }) };
    }
    return { ok: false, status: 403, statusText: "Forbidden", text: async () => "Clear failed" };
  });
  await assert.rejects(updateGoogleSheet({
    accessToken: "test-token", spreadsheetId: "test-sheet", sheetName: "prices", values: [columns]
  }), /Google Sheets request failed: 403 Forbidden Clear failed/);
  assert.deepEqual(methods, ["GET", "POST"]);
});
