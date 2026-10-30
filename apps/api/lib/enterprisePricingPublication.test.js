import test from "node:test";
import assert from "node:assert/strict";
import { applyEnterpriseLocalLinePrices } from "./enterprisePricingPublication.js";

test("enterprise Local Line payload writes one fixed price to three active baskets", () => {
  const payload = { vendor: 7, packages: [{ id: 20, name: "Roast", unit_price: 12,
    price_list_entries: [1, 3, 4].map(price_list => ({ price_list, product_price_list_entry: price_list + 100, adjustment_type: 2, adjustment_value: 50 })) }] };
  const context = { packages: [{ id: 10 }], packageMeta: [{ packageId: 10, localLinePackageId: 20 }] };
  const revision = { output: { saleBp: 0, packages: [{ packageId: 10, localLineRegularCents: 3600 }] } };
  const result = applyEnterpriseLocalLinePrices(payload, context, revision, [1, 3, 4]);
  assert.equal(result.packages[0].unit_price, 36);
  assert.deepEqual(result.packages[0].price_list_entries.map(row => [row.adjustment_type, row.adjustment_value]), [[3, 36], [3, 36], [3, 36]]);
  assert.deepEqual(result.packages[0].price_list_entries.map(row => row.product_price_list_entry), [101, 103, 104]);
});

test("missing basket mapping holds the product", () => {
  assert.throws(() => applyEnterpriseLocalLinePrices(
    { packages: [{ id: 20, price_list_entries: [{ price_list: 1 }] }] },
    { packages: [{ id: 10 }], packageMeta: [{ packageId: 10, localLinePackageId: 20 }] },
    { output: { packages: [{ packageId: 10, localLineRegularCents: 3600 }] } }
    , [1, 3, 4]
  ), /valid active/);
});
