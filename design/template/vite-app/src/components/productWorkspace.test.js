import test from "node:test";
import assert from "node:assert/strict";
import {
  productCapabilities,
  hydrateProductDraft,
  patchProductDraft,
  dirtyFields,
  acknowledgeSave,
  saveProductDraft,
  unsupportedScheduleFields,
  syncLabel,
  previewProductPrices,
} from "./productWorkspace.js";
import { computeProductPricingSnapshot } from "../../../../../apps/api/lib/productPricing.js";

const product = {
  productId: 7,
  name: "Sausage",
  vendorId: 1,
  categoryId: 2,
  description: "Fresh sausage",
  visible: true,
  inventory: 12,
  trackInventory: true,
  onSale: false,
  saleDiscount: 0,
  usesSourcePricing: true,
  unitOfMeasure: "each",
  sourceUnitPrice: 10,
  sourceMultiplier: 0.5,
  packages: [{ id: 70, name: "Each", quantity: 1, averageWeight: null }],
  packageRecords: [
    { id: 70, name: "Each", price: 5, visible: true, numOfItems: 1 },
  ],
};

test("role combinations keep editing, scheduling, cached pricing, and pushing separate", () => {
  assert.equal(productCapabilities(["inventory_admin"]).pricing, false);
  assert.equal(productCapabilities(["inventory_admin"]).edit, true);
  const local = productCapabilities(["local_pricelist_admin"]);
  assert.equal(local.pricing, true);
  assert.equal(local.schedule, false);
  assert.equal(local.cachedPricing, false);
  assert.equal(local.push, false);
  assert.equal(productCapabilities(["localline_pull"]).edit, false);
  assert.equal(productCapabilities(["localline_push"]).edit, false);
  assert.equal(productCapabilities(["pricing_admin"]).push, false);
  assert.equal(
    productCapabilities(["pricing_admin", "localline_push"]).push,
    true,
  );
  assert.equal(productCapabilities(["membership_admin"]).view, false);
  assert.ok(Object.values(productCapabilities(["admin"])).every(Boolean));
});

test("grid draft survives Details hydration and independent edits across products", () => {
  let drafts = patchProductDraft({}, product, { sourceUnitPrice: "12" });
  drafts = patchProductDraft(
    drafts,
    { ...product, productId: 8 },
    { inventory: 3 },
  );
  const detail = {
    ...product,
    id: 7,
    description: "Full details",
    packages: product.packageRecords,
  };
  const hydrated = hydrateProductDraft(drafts[7], detail);
  assert.equal(hydrated.values.sourceUnitPrice, "12");
  assert.equal(hydrated.values.description, "Full details");
  assert.deepEqual(dirtyFields(hydrated), ["sourceUnitPrice"]);
  drafts[7] = {
    ...hydrated,
    values: { ...hydrated.values, description: "Edited in Details" },
  };
  drafts = patchProductDraft(drafts, product, { inventory: 5 });
  assert.equal(drafts[7].values.description, "Edited in Details");
  assert.equal(drafts[8].values.inventory, 3);
});

test("local saves never push and preserve both domains after a partial failure", async () => {
  const entry = patchProductDraft({}, product, {
    inventory: 5,
    sourceUnitPrice: "12",
  })[7];
  const calls = [];
  const result = await saveProductDraft(entry, productCapabilities(["admin"]), {
    post: async (path, body) => {
      calls.push({ path, body });
      return { results: [{ productId: 7, databaseUpdate: true }] };
    },
    put: async (path) => {
      calls.push({ path });
      throw new Error("Pricing write failed");
    },
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.savedFields, ["inventory"]);
  assert.equal(calls[0].body.applyRemote, false);
  assert.equal(calls[0].body.queueRemoteSync, true);
  const remaining = acknowledgeSave(entry, entry, result.savedFields);
  assert.deepEqual(dirtyFields(remaining), ["sourceUnitPrice"]);
  const retryCalls = [];
  const retry = await saveProductDraft(
    remaining,
    productCapabilities(["local_pricelist_admin"]),
    {
      put: async (path, body) => {
        retryCalls.push({ path, body });
        return { ok: true };
      },
      post: async () => assert.fail("Inventory already saved"),
    },
  );
  assert.equal(retry.ok, true);
  assert.deepEqual(
    retryCalls.map((call) => call.path),
    ["products/7/pricing-profile"],
  );
});

test("a 200 response with an unconfirmed local save is a failure and retains the draft", async () => {
  const entry = patchProductDraft({}, product, { inventory: 9 })[7];
  const result = await saveProductDraft(
    entry,
    productCapabilities(["inventory_admin"]),
    {
      post: async () => ({
        results: [{ productId: 7, databaseUpdate: false }],
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    dirtyFields(acknowledgeSave(entry, entry, result.savedFields)),
    ["inventory"],
  );
});

test("successful package saves are not repeated when another package fails", async () => {
  const source = {
    ...product,
    packageRecords: [
      ...product.packageRecords,
      { ...product.packageRecords[0], id: 71, name: "Box" },
    ],
  };
  const entry = hydrateProductDraft(null, source);
  entry.values.packages = entry.values.packages.map((pkg) => ({
    ...pkg,
    price: "8",
  }));
  const result = await saveProductDraft(
    entry,
    productCapabilities(["local_pricelist_admin"]),
    {
      put: async (path) => {
        if (path.endsWith("71")) throw new Error("Failed package");
        return { ok: true };
      },
    },
  );
  assert.deepEqual(result.savedPackageIds, [70]);
  const remaining = acknowledgeSave(
    entry,
    entry,
    result.savedFields,
    result.savedPackageIds,
  );
  const paths = [];
  await saveProductDraft(
    remaining,
    productCapabilities(["local_pricelist_admin"]),
    {
      put: async (path) => {
        paths.push(path);
        return { ok: true };
      },
    },
  );
  assert.deepEqual(paths, ["packages/71"]);
});

test("acknowledging a save preserves changes made while its request was running", () => {
  const submitted = patchProductDraft({}, product, { inventory: 5 })[7];
  const newer = { ...submitted, values: { ...submitted.values, inventory: 6 } };
  const result = acknowledgeSave(newer, submitted, ["inventory"]);
  assert.equal(result.defaults.inventory, 5);
  assert.equal(result.values.inventory, 6);
  assert.deepEqual(dirtyFields(result), ["inventory"]);
});

test("only supported unsaved fields can be scheduled", () => {
  const inventory = patchProductDraft({}, product, {
    inventory: 0,
    visible: false,
  })[7];
  assert.deepEqual(unsupportedScheduleFields(inventory), []);
  inventory.values.sourceUnitPrice = "13";
  assert.deepEqual(unsupportedScheduleFields(inventory), ["sourceUnitPrice"]);
  inventory.values.description = "New description";
  assert.ok(unsupportedScheduleFields(inventory).includes("description"));
});

test("inventory role cannot save package or formula pricing and read-only roles cannot write", async () => {
  const entry = patchProductDraft({}, product, { sourceUnitPrice: "13" })[7];
  const api = {
    put: async () => assert.fail("Forbidden request"),
    post: async () => assert.fail("Forbidden request"),
  };
  assert.equal(
    (
      await saveProductDraft(
        entry,
        productCapabilities(["inventory_admin"]),
        api,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await saveProductDraft(
        entry,
        productCapabilities(["localline_push"]),
        api,
      )
    ).ok,
    false,
  );
});

test("cached Local Line edits share drafts and survive product hydration", async () => {
  const entry = hydrateProductDraft(null, product);
  entry.defaults.priceListEntries = [{ id: 1, finalPriceCache: 5 }];
  entry.values.priceListEntries = [{ id: 1, finalPriceCache: "6" }];
  const next = hydrateProductDraft(entry, product);
  assert.equal(next.values.priceListEntries[0].finalPriceCache, "6");
  const result = await saveProductDraft(
    next,
    productCapabilities(["pricing_admin"]),
    {
      put: async (path, body) => {
        assert.equal(path, "localline/products/7/price-list-entries");
        assert.equal(body.entries[0].finalPriceCache, 6);
        return { ok: true, updated: 1 };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.savedFields, ["priceListEntries"]);
});

test("local-only and failed sync states stay visible independently of schedules", () => {
  assert.equal(
    syncLabel({ localLineProductId: 0, remoteSyncStatus: "failed" }),
    "Failed",
  );
  assert.equal(syncLabel({ localLineProductId: 0 }), "Local-only");
  assert.equal(
    syncLabel({ localLineProductId: 1164232, hasPendingRemoteApply: true }),
    "Pending push",
  );
  assert.equal(
    syncLabel({ localLineProductId: 1164232, remoteSyncStatus: "applied" }),
    "Synced",
  );
});

test("price previews match server calculation for standard, formula, weight, deposit and sale cases", () => {
  for (const name of ["Sausage", "Jar deposit"])
    for (const source of [true, false])
      for (const unit of ["each", "lbs"]) {
        const vendor = {
          name: source ? "Deck Family Farm" : "Other vendor",
          sourceMultiplier: 0.5,
          priceListMarkup: 0.2,
        };
        const profile = {
          sourceUnitPrice: 10,
          unitOfMeasure: unit,
          minWeight: 1,
          maxWeight: 2,
          onSale: 1,
          saleDiscount: 0.1,
        };
        const snapshot = computeProductPricingSnapshot({
          product: { id: 7, name },
          vendor,
          profile,
          packages: product.packageRecords,
        });
        const row = {
          ...product,
          ...snapshot.profile,
          name,
          ...Object.fromEntries(
            [
              "basePrice",
              "guestPrice",
              "memberPrice",
              "herdSharePrice",
              "snapPrice",
            ].map((key) => [key, snapshot[key]]),
          ),
          packages: snapshot.packageRows,
        };
        const preview = previewProductPrices(
          row,
          hydrateProductDraft(null, row).values,
        );
        for (const key of Object.keys(preview))
          assert.equal(
            preview[key],
            snapshot[key],
            `${name} ${source} ${unit} ${key}`,
          );
      }
});
