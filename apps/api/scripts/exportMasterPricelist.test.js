import assert from "node:assert/strict";
import test from "node:test";
import { buildSimplePricelistValues } from "./exportMasterPricelist.js";

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
