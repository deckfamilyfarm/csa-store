import test from "node:test";
import assert from "node:assert/strict";
import {
  productCapabilities,
  hydrateProductDraft,
  patchProductDraft,
  dirtyFields,
  acknowledgeSave,
  saveProductDraft,
  saveInventoryDraft,
  unsupportedScheduleFields,
  syncLabel,
  previewProductPrices,
  buildScheduleUpdate,
  reviewFarmStockConflict,
} from "./productWorkspace.js";
import { computeProductPricingSnapshot } from "../../../../../apps/api/lib/productPricing.js";
import { mobileInventoryView } from "./mobileInventoryView.js";

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

test('customer-group settings survive hydration, save locally, and preserve failed drafts', async () => {
  const standard = { ...product, usesSourcePricing: false, markupOverride: .45, customerPriceLists: [{ id: 3124, key: 'guest' }] };
  const rows = [{ packageId: 70, priceListId: 3124, adjustment: true, adjustmentType: 2, adjustmentValue: 40, onSale: true, strikethrough: 9 }];
  const entry = patchProductDraft({}, standard, { customerPriceOverrides: rows })[7];
  const hydrated = hydrateProductDraft(entry, { ...standard, pricingProfile: { customerPriceOverrides: [] } });
  assert.deepEqual(hydrated.values.customerPriceOverrides, rows);
  assert.equal(previewProductPrices(standard, hydrated.values).guestPrice, 7);
  assert.equal(Object.hasOwn(buildScheduleUpdate(entry).changes, 'onSale'), false);
  const calls = [], api = { put: async (path, body) => { calls.push({path,body}); return {ok:true}; } };
  const denied = await saveProductDraft(entry, productCapabilities(['inventory_admin']), api);
  assert.equal(denied.ok, false); assert.deepEqual(calls, []);
  const failed = await saveProductDraft(entry, productCapabilities(['pricing_admin']), {put:async()=>{throw new Error('Save failed');}});
  assert.ok(dirtyFields(acknowledgeSave(entry, entry, failed.savedFields)).includes('customerPriceOverrides'));
  const saved = await saveProductDraft(entry, productCapabilities(['pricing_admin']), api);
  assert.ok(saved.ok); assert.equal(calls[0].path, 'products/7/customer-prices');
  assert.deepEqual(calls[0].body.customerPriceOverrides, rows);
  assert.deepEqual(dirtyFields(acknowledgeSave(entry, entry, saved.savedFields)), []);
});

test("product markup saves locally and remains a draft on permission or save failure", async () => {
  const standard = { ...product, usesSourcePricing: false, markupOverride: null };
  const entry = patchProductDraft({}, standard, { markupOverride: "45" })[7];
  const calls = [];
  const api = { put: async (path, body) => { calls.push({ path, body }); return { ok: true }; } };
  const denied = await saveProductDraft(entry, productCapabilities(["inventory_admin"]), api);
  assert.equal(denied.ok, false);
  assert.deepEqual(calls, []);
  const saved = await saveProductDraft(entry, productCapabilities(["local_pricelist_admin"]), api);
  assert.equal(saved.ok, true);
  assert.deepEqual(calls, [{ path: "products/7/markup", body: { markupOverride: 0.45 } }]);
  assert.deepEqual(saved.savedFields, ["markupOverride"]);
  assert.ok(unsupportedScheduleFields(entry).includes("markupOverride"));
  const failed = await saveProductDraft(entry, productCapabilities(["admin"]), { put: async () => { throw new Error("Save failed"); } });
  assert.deepEqual(failed.savedFields, []);
  assert.equal(entry.values.markupOverride, "45");
});

test("markup preview supports setting and clearing an override without changing vendor defaults", () => {
  const standard = { ...product, usesSourcePricing: false, markupOverride: 0.45, vendorPriceListMarkup: 0.4,
    guestMarkup: 0.45, memberMarkup: 0.45, herdShareMarkup: 0.45, snapMarkup: 0.45 };
  const draft = hydrateProductDraft(null, standard).values;
  assert.equal(draft.markupOverride, "45");
  assert.equal(previewProductPrices(standard, draft).memberPrice, 7.25);
  assert.equal(previewProductPrices(standard, { ...draft, markupOverride: "" }).memberPrice, 7);
  assert.equal(previewProductPrices(standard, { ...draft, markupOverride: "0" }).memberPrice, 5);
});

test("vendorless drafts fail before any local save and retain every edit", async () => {
  for (const vendorId of [null, "", 0]) {
    const entry = patchProductDraft({}, { ...product, vendorId }, { sourceUnitPrice: "12", inventory: 5 })[7];
    const api = { put: () => assert.fail("No writes allowed"), post: () => assert.fail("No writes allowed") };
    const result = await saveProductDraft(entry, productCapabilities(["admin"]), api);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /vendor is required/);
    assert.deepEqual(result.savedFields, []);
    const inventory = await saveInventoryDraft(entry, productCapabilities(["admin"]), api);
    assert.equal(inventory.ok, false);
    assert.match(inventory.errors[0], /vendor is required/);
  }
});

test("a failed vendor assignment stops all dependent saves", async () => {
  const entry = patchProductDraft({}, product, { vendorId: "99", inventory: 5, sourceUnitPrice: "12" })[7];
  const calls = [];
  const result = await saveProductDraft(entry, productCapabilities(["admin"]), {
    put: async path => { calls.push(path); throw new Error("Invalid vendor"); },
    post: () => assert.fail("Stock must not save after vendor failure")
  });
  assert.deepEqual(calls, ["products/7"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.savedFields, []);
});

test("role combinations keep editing, scheduling, cached pricing, and pushing separate", () => {
  assert.equal(productCapabilities(["inventory_admin"]).pricing, false);
  assert.equal(productCapabilities(["inventory_admin"]).edit, true);
  assert.equal(productCapabilities(["inventory_admin"]).inventoryPush, true);
  assert.equal(productCapabilities(["inventory_admin"]).push, false);
  assert.equal(productCapabilities(["inventory_admin"]).sync, false);
  const local = productCapabilities(["local_pricelist_admin"]);
  assert.equal(local.pricing, true);
  assert.equal(local.schedule, false);
  assert.equal(local.cachedPricing, false);
  assert.equal(local.push, false);
  assert.equal(local.inventoryPush, false);
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
test("Inventory saves push only dirty stock, tracking, and visibility fields and preserve other drafts", async () => {
  const entry=patchProductDraft({},product,{inventory:5,trackInventory:false,sourceUnitPrice:"12",onSale:true,visible:false})[7];
  const result=await saveInventoryDraft(entry,productCapabilities(["inventory_admin"]),{
    post:async(path,body)=>{
      assert.equal(path,"products/7/inventory");
      assert.deepEqual(body,{changes:{inventory:5,trackInventory:0,visible:0},expectedInventory:{inventory:12,trackInventory:true}});
      return {ok:true,localLineUpdate:true};
    }
  });
  assert.equal(result.ok,true);
  const remaining=acknowledgeSave(entry,entry,result.savedFields);
  assert.deepEqual(dirtyFields(remaining).sort(),["onSale","sourceUnitPrice"]);
  const failure=await saveInventoryDraft(entry,productCapabilities(["inventory_admin"]),{post:async()=>{throw new Error("Local Line unavailable");}});
  assert.equal(failure.ok,false); assert.deepEqual(failure.savedFields,[]);
  assert.ok(dirtyFields(acknowledgeSave(entry,entry,failure.savedFields)).includes("inventory"));
});

test("inventory saves preserve existing authorized editors and reject other role combinations", async () => {
  const entry = patchProductDraft({}, product, { inventory: 5 })[7];
  for (const roles of [["admin"], ["inventory_admin"], ["pricing_admin", "localline_push"], ["local_pricelist_admin", "localline_push"]]) {
    const calls = [];
    const result = await saveInventoryDraft(entry, productCapabilities(roles), {
      post: async (path, body) => { calls.push({ path, body }); return { ok: true, localLineUpdate: true }; },
    });
    assert.equal(result.ok, true, roles.join(","));
    assert.deepEqual(calls, [{ path: "products/7/inventory", body: { changes: { inventory: 5 }, expectedInventory:{inventory:12,trackInventory:true} } }]);
  }
  for (const roles of [[], ["pricing_admin"], ["local_pricelist_admin"], ["localline_push"], ["localline_pull"], ["membership_admin", "localline_push"]]) {
    const result = await saveInventoryDraft(entry, productCapabilities(roles), { post: () => assert.fail("No inventory publishing permission") });
    assert.equal(result.ok, false, roles.join(","));
    assert.deepEqual(result.savedFields, []);
    assert.deepEqual(dirtyFields(acknowledgeSave(entry, entry, result.savedFields)), ["inventory"]);
  }
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

test("farm stock keeps null/false distinct through hydration and shared drafts", () => {
  assert.equal(hydrateProductDraft(null, product).values.stockOnFarm, null);
  const draft = patchProductDraft({}, product, { stockOnFarm: false })[7];
  assert.deepEqual(dirtyFields(draft), ['stockOnFarm', 'stockOnFarmLbs']);
  const refreshed = hydrateProductDraft(draft, { ...product, stockOnFarm: true });
  assert.equal(refreshed.values.stockOnFarm, false);
  assert.equal(refreshed.defaults.stockOnFarm, null);
  const newer = { ...draft, values: { ...draft.values, stockOnFarm: true } };
  const saved = acknowledgeSave(newer, draft, ['stockOnFarm', 'stockOnFarmLbs']);
  assert.equal(saved.defaults.stockOnFarm, false);
  assert.deepEqual(dirtyFields(saved), ['stockOnFarm']);
});

test("farm-only saves work from either view without publishing or marking pricing pending", async () => {
  for (const roles of [['admin'], ['inventory_admin'], ['pricing_admin'], ['local_pricelist_admin']]) {
    for (const save of [saveInventoryDraft, saveProductDraft]) {
      const draft = patchProductDraft({}, { ...product, localLineProductId: null }, { stockOnFarm: false })[7];
      const calls = [];
      const result = await save(draft, productCapabilities(roles), {
        put: async (path, body) => { calls.push({ path, body }); return { ok: true, ...body, farmStockRevision: 1 }; },
        post: () => assert.fail('Farm-only save must not publish or queue Product Sync')
      });
      assert.equal(result.ok, true);
      assert.deepEqual(calls, [{ path: 'products/7/farm-stock', body: { stockOnFarm: false, stockOnFarmLbs: 0, expectedRevision: 0 } }]);
      assert.deepEqual(dirtyFields(acknowledgeSave(draft, draft, result.savedFields)), []);
      assert.deepEqual(unsupportedScheduleFields(draft), ['stockOnFarm', 'stockOnFarmLbs']);
      assert.equal(Object.hasOwn(buildScheduleUpdate(draft).changes, 'stockOnFarm'), false);
    }
  }
});

test("mixed inventory saves acknowledge successes independently and retry only failures", async () => {
  for (const failedDomain of ['farm', 'full']) {
    const draft = patchProductDraft({}, product, { stockOnFarm: false, inventory: 0, onSale: true })[7];
    const calls = [];
    const result = await saveInventoryDraft(draft, productCapabilities(['inventory_admin']), {
      put: async (_path, body) => { calls.push('farm'); if (failedDomain === 'farm') throw new Error('Local failure'); return { ok: true, ...body, farmStockRevision: 1 }; },
      post: async (_path, body) => { calls.push('full'); assert.deepEqual(body, { changes: { inventory: 0 }, expectedInventory:{inventory:12,trackInventory:true} }); if (failedDomain === 'full') throw new Error('Local Line unavailable'); return { ok: true, localLineUpdate: true }; }
    });
    assert.deepEqual(calls, ['farm', 'full']);
    assert.equal(result.partial, true);
    assert.deepEqual(result.savedFields, failedDomain === 'farm' ? ['inventory'] : ['stockOnFarm', 'stockOnFarmLbs']);
    const remaining = acknowledgeSave(draft, draft, result.savedFields);
    const retries = [];
    const retried = await saveInventoryDraft(remaining, productCapabilities(['inventory_admin']), {
      put: async (_path, body) => { retries.push('farm'); return { ok: true, ...body, farmStockRevision: 1 }; },
      post: async () => { retries.push('full'); return { ok: true, localLineUpdate: true }; }
    });
    assert.equal(retried.ok, true);
    assert.deepEqual(retries, [failedDomain]);
    assert.deepEqual(dirtyFields(acknowledgeSave(remaining, remaining, retried.savedFields)), ['onSale']);
  }
});

test("farm availability saves despite invalid or unauthorized Full Farm edits", async () => {
  for (const [roles, inventory] of [[['pricing_admin'], 8], [['inventory_admin'], -1]]) {
    const draft = patchProductDraft({}, product, { stockOnFarm: true, inventory })[7];
    const result = await saveInventoryDraft(draft, productCapabilities(roles), {
      put: async (_path, body) => ({ ok: true, ...body, farmStockRevision: 1 }), post: () => assert.fail('Full Farm save must be held')
    });
    assert.equal(result.partial, true);
    assert.deepEqual(result.savedFields, ['stockOnFarm', 'stockOnFarmLbs']);
    assert.deepEqual(dirtyFields(acknowledgeSave(draft, draft, result.savedFields)), ['inventory']);
  }
});

test("farm save requires confirmed value and keeps failed or unreviewed values as drafts", async () => {
  for (const stockOnFarm of [false, null]) {
    const draft = patchProductDraft({}, { ...product, stockOnFarm: true }, { stockOnFarm })[7];
    const result = await saveInventoryDraft(draft, productCapabilities(['admin']), {
      put: async () => ({ ok: true, stockOnFarm: true })
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.savedFields, []);
  }
});

test('farm pounds link status, drive checked filters, and preserve typed drafts and count baselines', () => {
  let drafts = patchProductDraft({}, product, { stockOnFarmLbs: '.125' });
  assert.equal(drafts[7].values.stockOnFarm, true);
  assert.equal(mobileInventoryView([product], drafts, '', 'checked').checked, 1);
  assert.equal(mobileInventoryView([product], drafts, '', 'not-checked').rows.length, 0);
  drafts = patchProductDraft(drafts, product, { stockOnFarmLbs: '' });
  assert.equal(drafts[7].values.stockOnFarm, true);
  drafts = patchProductDraft(drafts, product, { stockOnFarm: false });
  assert.equal(drafts[7].values.stockOnFarmLbs, '0');
  drafts = patchProductDraft(drafts, product, { stockOnFarm: true });
  assert.equal(drafts[7].values.stockOnFarmLbs, '');
  drafts = patchProductDraft(drafts, product, { stockOnFarmLbs: '25.125' });
  const refreshed = hydrateProductDraft(drafts[7], { ...product, stockOnFarm: false, stockOnFarmLbs: 0, farmStockRevision: 5 });
  assert.equal(refreshed.values.stockOnFarmLbs, '25.125');
  assert.equal(refreshed.defaults.stockOnFarmLbs, '');
  assert.equal(refreshed.meta.farmStockRevision, 0);
  drafts = patchProductDraft(drafts, product, { stockOnFarm: null });
  assert.equal(drafts[7].values.stockOnFarmLbs, '');
  assert.deepEqual(dirtyFields(drafts[7]), []);
});

test('pounds-only save persists from either workspace and never enters sync staging', async () => {
  for (const save of [saveInventoryDraft, saveProductDraft]) {
    const counted = { ...product, stockOnFarm: true, stockOnFarmLbs: 10, farmStockRevision: 3 };
    const draft = patchProductDraft({}, counted, { stockOnFarmLbs: '25.500' })[7];
    assert.deepEqual(dirtyFields(draft), ['stockOnFarmLbs']);
    const result = await save(draft, productCapabilities(['inventory_admin']), {
      put: async (path, body) => {
        assert.equal(path, 'products/7/farm-stock');
        assert.deepEqual(body, { stockOnFarm: true, stockOnFarmLbs: 25.5, expectedRevision: 3 });
        return { ok: true, stockOnFarm: true, stockOnFarmLbs: 25.5, farmStockRevision: 4 };
      }, post: () => assert.fail('Farm count must not publish or queue remote changes'),
    });
    assert.equal(result.ok, true);
    const saved = acknowledgeSave(draft, draft, result.savedFields, [], result);
    assert.deepEqual(dirtyFields(saved), []);
    assert.equal(saved.values.stockOnFarmLbs, '25.5');
    assert.equal(saved.meta.farmStockRevision, 4);
    const newer = patchProductDraft({ 7: draft }, counted, { stockOnFarmLbs: '30' })[7];
    const acknowledged = acknowledgeSave(newer, draft, result.savedFields, [], result);
    assert.equal(acknowledged.values.stockOnFarmLbs, '30');
    assert.equal(acknowledged.defaults.stockOnFarmLbs, '25.5');
    assert.deepEqual(unsupportedScheduleFields(draft), ['stockOnFarmLbs']);
    assert.equal(Object.hasOwn(buildScheduleUpdate(draft).changes, 'stockOnFarmLbs'), false);
  }
});

test('farm count conflicts retain drafts, allow independent Full Farm saves, and require explicit review', async () => {
  const draft = patchProductDraft({}, { ...product, stockOnFarm: true, stockOnFarmLbs: 10, farmStockRevision: 3 }, { stockOnFarmLbs: '20', inventory: 5 })[7];
  const latest = { stockOnFarm: true, stockOnFarmLbs: 15, farmStockRevision: 4 };
  const api = { put: async () => { throw Object.assign(new Error('Farm inventory changed'), { status: 409, farmStockConflict: latest }); }, post: async () => ({ ok: true, localLineUpdate: true }) };
  const result = await saveInventoryDraft(draft, productCapabilities(['inventory_admin']), api);
  assert.equal(result.partial, true);
  assert.deepEqual(result.savedFields, ['inventory']);
  const retained = acknowledgeSave(draft, draft, result.savedFields, [], result);
  assert.equal(retained.values.stockOnFarmLbs, '20');
  assert.equal(retained.meta.farmStockRevision, 3);
  const blocked = await saveInventoryDraft(retained, productCapabilities(['inventory_admin']), { put: () => assert.fail('Do not overwrite before review') });
  assert.match(blocked.errors[0], /Review/);
  const adopted = reviewFarmStockConflict(retained, false);
  assert.equal(adopted.values.stockOnFarmLbs, '15');
  assert.deepEqual(dirtyFields(adopted), []);
  const reviewed = reviewFarmStockConflict(retained, true);
  assert.equal(reviewed.values.stockOnFarmLbs, '20');
  assert.equal(reviewed.defaults.stockOnFarmLbs, '15');
  assert.equal(reviewed.meta.farmStockRevision, 4);
  const retry = await saveInventoryDraft(reviewed, productCapabilities(['inventory_admin']), { put: async (_path, body) => {
    assert.equal(body.expectedRevision, 4);
    return { ok: true, stockOnFarm: true, stockOnFarmLbs: 20, farmStockRevision: 5 };
  }, post: () => assert.fail('Do not retry a confirmed Full Farm save') });
  assert.equal(retry.ok, true);
});

test('invalid pounds stay visible for correction without blocking Full Farm saves', async () => {
  const draft = patchProductDraft({}, product, { stockOnFarmLbs: '2.1234', inventory: 5 })[7];
  const result = await saveInventoryDraft(draft, productCapabilities(['inventory_admin']), {
    put: () => assert.fail('Invalid local count must not be sent'), post: async () => ({ ok: true, localLineUpdate: true }),
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.savedFields, ['inventory']);
  assert.equal(acknowledgeSave(draft, draft, result.savedFields).values.stockOnFarmLbs, '2.1234');
});
