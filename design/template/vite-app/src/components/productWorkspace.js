import { canPublishInventory } from "../../../../../apps/api/lib/adminRoles.js";
import { farmPounds, FARM_INVENTORY_FIELDS } from "../../../../../apps/api/lib/farmInventory.js";
import { normalizeCustomerPriceOverrides, customerOverridePrice } from '../../../../../apps/api/lib/customerPriceOverrides.js';

// Shared state and local-save rules for the Products grid and Details editor.
export const FORMULA_FIELDS = [
  "unitOfMeasure",
  "sourceUnitPrice",
  "minWeight",
  "maxWeight",
  "avgWeightOverride",
  "sourceMultiplier",
];
export const SCHEDULE_FIELDS = [
  "visible",
  "trackInventory",
  "inventory",
  "onSale",
  "saleDiscount",
];
const METADATA_FIELDS = ["name", "description", "vendorId", "categoryId"];
export const FULL_FARM_INVENTORY_FIELDS = ["inventory", "packageInventory", "trackInventory", "visible"];
export const INVENTORY_FIELDS = [...FULL_FARM_INVENTORY_FIELDS, ...FARM_INVENTORY_FIELDS];

async function saveFarmStock(entry, api) {
  if (entry.meta.farmStockConflict) throw new Error("Review the latest farm count below before retrying.");
  const stockOnFarm = entry.values.stockOnFarm;
  const stockOnFarmLbs = farmPounds(entry.values.stockOnFarmLbs);
  const statusDirty = dirtyFields(entry).includes("stockOnFarm");
  if (statusDirty && typeof stockOnFarm !== "boolean") throw new Error("Choose True or False for Stock on Farm.");
  const response = await api.put(`products/${entry.meta.productId}/farm-stock`, {
    ...(typeof stockOnFarm === "boolean" ? { stockOnFarm } : {}),
    stockOnFarmLbs,
    expectedRevision: entry.meta.farmStockRevision,
  });
  if (!response?.ok || response.stockOnFarm !== stockOnFarm || response.stockOnFarmLbs !== stockOnFarmLbs || !Number.isSafeInteger(response.farmStockRevision)) {
    throw new Error(response?.message || "Farm inventory was not confirmed.");
  }
  return response;
}

async function saveFarmInventory(entry, api, result) {
  try {
    result.farmStock = await saveFarmStock(entry, api);
    result.savedFields.push(...FARM_INVENTORY_FIELDS);
  } catch (error) {
    if (error.farmStockConflict) result.farmStockConflict = error.farmStockConflict;
    result.errors.push(`Stock on Farm: ${error.message || "Local save failed."}`);
  }
}

export function inventorySaveSummary(result) {
  const saved = [];
  if (result.savedFields.some(key => FARM_INVENTORY_FIELDS.includes(key))) saved.push("Farm inventory saved locally");
  if (result.savedFields.some(key => FULL_FARM_INVENTORY_FIELDS.includes(key))) saved.push("Full Farm inventory confirmed in Local Line and saved locally");
  return saved.join("; ") || "No inventory changes saved";
}

export async function saveInventoryDraft(entry, capabilities, api) {
  const dirty = dirtyFields(entry);
  const fields = dirty.filter(key => FULL_FARM_INVENTORY_FIELDS.includes(key));
  const result = { productId: entry.meta.productId, productName: entry.values.name, inventoryOnly: true, ok: false, savedFields: [], savedPackageIds: [], errors: [] };
  try {
    if (!capabilities.edit) throw new Error("Product editing permission is required.");
    if (!Number.isInteger(Number(entry.defaults.vendorId)) || Number(entry.defaults.vendorId) <= 0) throw new Error("A vendor is required. Select a vendor in Details and save it in Pricing before saving inventory.");
  } catch (error) { result.errors.push(error.message); return result; }
  if (dirty.some(key => FARM_INVENTORY_FIELDS.includes(key))) await saveFarmInventory(entry, api, result);
  if (fields.length) {
    try {
      if (!capabilities.inventoryPush) throw new Error("Inventory Admin, or product editing and Local Line Push permissions, are required.");
      const changes = Object.fromEntries(fields.map(key => [key, key==='packageInventory'?entry.values.packageInventory.filter(p=>p.inventory!==entry.defaults.packageInventory.find(old=>old.packageId===p.packageId)?.inventory).map(p=>({packageId:p.packageId,inventory:p.inventory===''?NaN:Number(p.inventory)})):Number(entry.values[key])]));
      if (Object.hasOwn(changes, "inventory") && (!Number.isInteger(changes.inventory) || changes.inventory < 0)) throw new Error("Full Farm Stock must be a nonnegative whole number.");
      if(entry.meta.inventoryConflict)throw new Error('Review current Full Farm stock before retrying.');
      const response = await api.post(`products/${entry.meta.productId}/inventory`, { changes, ...((Object.hasOwn(changes,"inventory")||changes.packageInventory) ? {expectedInventory:entry.meta.inventorySnapshot||{inventory:Number(entry.defaults.inventory),trackInventory:Boolean(entry.defaults.trackInventory)}} : {}) });
      if (!response?.ok || !response?.localLineUpdate) throw new Error(response?.message || "Local Line inventory was not confirmed.");
      result.currentInventory=response.currentInventory;
      result.savedFields.push(...fields);
    } catch (error) { if(error.inventoryConflict)result.inventoryConflict=error.inventoryConflict; result.errors.push(`Full Farm: ${error.message || "Inventory update failed."}`); }
  }
  result.ok = result.errors.length === 0;
  result.partial = !result.ok && result.savedFields.length > 0;
  return result;
}

export function productCapabilities(roles = []) {
  const has = (...keys) =>
    roles.includes("admin") || keys.some((key) => roles.includes(key));
  return {
    view: has(
      "pricing_admin",
      "local_pricelist_admin",
      "inventory_admin",
      "pricing_editor",
      "localline_pull",
      "localline_push",
    ),
    edit: has("inventory_admin", "pricing_admin", "pricing_editor", "local_pricelist_admin"),
    pricing: has("pricing_admin", "local_pricelist_admin"),
    cachedPricing: has("pricing_admin"),
    push: has("localline_push"),
    inventoryPush: canPublishInventory(roles),
    sync: has("localline_push", "square_push", "localline_pull", "square_pull", "pricing_admin"),
    schedule: has("pricing_admin"),
  };
}

export function createDraftPackage(pkg = {}) {
  return {
    id: pkg.id ?? null,
    name: pkg.name || "ea",
    price: pkg.price == null ? "" : String(pkg.price),
    packageCode: pkg.packageCode || "",
    unit: pkg.unit || "",
    numOfItems: Number(pkg.numOfItems) || 1,
    visible: pkg.visible == null ? true : Boolean(pkg.visible),
    trackInventory: Boolean(pkg.trackInventory),
    inventory: Number(pkg.inventory) || 0,
    trackType: pkg.trackType || "package",
    chargeType: pkg.chargeType || "package",
  };
}

export function buildProductDraftFromProduct(
  product = {},
  sanitize = (text) => text || "",
) {
  const field = (key, fallback = "") =>
    String(product.pricingProfile?.[key] ?? product[key] ?? fallback);
  return {
    name: product.name || "",
    description: sanitize(product.description),
    vendorId: product.vendorId == null ? "" : String(product.vendorId),
    categoryId: product.categoryId == null ? "" : String(product.categoryId),
    visible: Boolean(product.visible),
    trackInventory: Boolean(product.trackInventory),
    inventory: product.inventory == null ? 0 : Number(product.inventory),
    packageInventory: product.inventoryType==='package' ? (product.packageInventory||[]) : [],
    stockOnFarm: product.stockOnFarm == null ? null : Boolean(Number(product.stockOnFarm)),
    stockOnFarmLbs: product.stockOnFarmLbs == null ? "" : String(Number(product.stockOnFarmLbs)),
    unitOfMeasure: field("unitOfMeasure", "each") === "lbs" ? "lbs" : "each",
    sourceUnitPrice: field("sourceUnitPrice"),
    minWeight: field("minWeight"),
    maxWeight: field("maxWeight"),
    avgWeightOverride: field("avgWeightOverride"),
    sourceMultiplier: field("sourceMultiplier", "0.5412"),
    markupOverride: product.pricingProfile?.markupOverride != null || product.markupOverride != null
      ? String(Number(product.pricingProfile?.markupOverride ?? product.markupOverride) * 100) : "",
    onSale: Boolean(product.onSale),
    customerPriceOverrides: product.pricingProfile?.customerPriceOverrides || product.customerPriceOverrides || [],
    saleDiscount: Math.round((Number(product.saleDiscount) || 0) * 100),
    packages: (product.packageRecords || product.packages || []).map(
      createDraftPackage,
    ),
  };
}

export const valuesEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function dirtyFields(entry) {
  if (!entry) return [];
  return Object.keys(entry.values).filter(
    (key) => !valuesEqual(entry.values[key], entry.defaults[key]),
  );
}
export const hasDraftChanges = (drafts) =>
  Object.values(drafts).some((entry) => dirtyFields(entry).length);

export function hydrateProductDraft(existing, product, sanitize) {
  const defaults = buildProductDraftFromProduct(product, sanitize);
  if (existing?.defaults.priceListEntries)
    defaults.priceListEntries = existing.defaults.priceListEntries;
  const values = { ...defaults };
  for (const key of dirtyFields(existing)) values[key] = existing.values[key];
  // Keep the original baseline for dirty fields until their save succeeds.
  const baseline = { ...defaults };
  for (const key of dirtyFields(existing))
    baseline[key] = existing.defaults[key];
  const farmDirty = dirtyFields(existing).some(key => FARM_INVENTORY_FIELDS.includes(key));
  if (farmDirty || existing?.meta.farmStockConflict) {
    for (const key of FARM_INVENTORY_FIELDS) {
      baseline[key] = existing.defaults[key];
      values[key] = existing.values[key];
    }
  }
  return {
    defaults: baseline,
    values,
    meta: {
      ...existing?.meta,
      inventoryConflict: existing?.meta?.inventoryConflict || (dirtyFields(existing).some(k=>['inventory','packageInventory'].includes(k))&&product.inventorySnapshot&&(existing.meta.inventoryType||'product')!==(product.inventoryType||'product')?product.inventorySnapshot:null),
      inventorySnapshot: dirtyFields(existing).some(k=>['inventory','packageInventory','trackInventory'].includes(k)) ? existing.meta.inventorySnapshot : product.inventorySnapshot,
      inventoryType: product.inventoryType||'product',
      productId: Number(product.productId ?? product.id),
      productName: product.name,
      farmStockRevision: farmDirty || existing?.meta.farmStockConflict ? existing.meta.farmStockRevision : Number(product.farmStockRevision || 0),
      categoryName: product.categoryName,
      usesSourcePricing:
        product.usesSourcePricing ?? existing?.meta?.usesSourcePricing,
      localLineProductId:
        product.localLineProductId ??
        product.localLineMeta?.localLineProductId ??
        0,
    },
  };
}

export function patchProductDraft(drafts, product, patch) {
  const id = product.productId ?? product.id;
  const entry = drafts[id] || hydrateProductDraft(null, product);
  const changes = { ...patch };
  if (Object.hasOwn(changes, "stockOnFarmLbs")) {
    // Retain text while typing (including invalid/incomplete input) for validation on save.
    changes.stockOnFarmLbs = changes.stockOnFarmLbs == null ? "" : String(changes.stockOnFarmLbs);
    try {
      const pounds = farmPounds(changes.stockOnFarmLbs);
      if (pounds !== null) changes.stockOnFarm = pounds > 0;
    } catch { /* Do not turn an invalid/incomplete count into a status change. */ }
  } else if (Object.hasOwn(changes, "stockOnFarm")) {
    if (changes.stockOnFarm === false) changes.stockOnFarmLbs = "0";
    else if (changes.stockOnFarm === null) changes.stockOnFarmLbs = "";
    else if (entry.values.stockOnFarmLbs !== "" && Number(entry.values.stockOnFarmLbs) === 0) changes.stockOnFarmLbs = "";
  }
  return {
    ...drafts,
    [id]: { ...entry, values: { ...entry.values, ...changes } },
  };
}

export function acknowledgeSave(
  current,
  submitted,
  savedFields,
  savedPackageIds = [],
  result = {},
) {
  if (!current) return current;
  const defaults = { ...current.defaults };
  for (const key of savedFields) defaults[key] = submitted.values[key];
  if (savedPackageIds.length) {
    defaults.packages = defaults.packages.map((pkg) =>
      savedPackageIds.includes(pkg.id)
        ? submitted.values.packages.find((item) => item.id === pkg.id)
        : pkg,
    );
  }
  const values = { ...current.values };
  const meta = { ...current.meta };
  if (result.farmStock) {
    const confirmed = buildProductDraftFromProduct(result.farmStock);
    for (const key of FARM_INVENTORY_FIELDS) {
      defaults[key] = confirmed[key];
      if (valuesEqual(current.values[key], submitted.values[key])) values[key] = confirmed[key];
    }
    meta.farmStockRevision = result.farmStock.farmStockRevision;
    delete meta.farmStockConflict;
  }
  if(result.currentInventory){meta.inventorySnapshot=result.currentInventory;meta.inventoryType=result.currentInventory.inventoryType||'product';delete meta.inventoryConflict;}
  if(result.inventoryConflict)meta.inventoryConflict=result.inventoryConflict;
  if (result.farmStockConflict) meta.farmStockConflict = result.farmStockConflict;
  return { ...current, defaults, values, meta };
}

export function reviewFarmStockConflict(entry, keepDraft) {
  const latest = entry?.meta.farmStockConflict;
  if (!latest) return entry;
  const confirmed = buildProductDraftFromProduct(latest);
  const defaults = { ...entry.defaults }, values = { ...entry.values };
  for (const key of FARM_INVENTORY_FIELDS) {
    defaults[key] = confirmed[key];
    if (!keepDraft) values[key] = confirmed[key];
  }
  const meta = { ...entry.meta, farmStockRevision: latest.farmStockRevision };
  delete meta.farmStockConflict;
  return { ...entry, defaults, values, meta };
}

export function unsupportedScheduleFields(entry) {
  return dirtyFields(entry).filter((key) => !SCHEDULE_FIELDS.includes(key));
}

export function buildScheduleUpdate(entry) {
  const values = entry.values;
  return {
    productId: entry.meta.productId,
    productName: values.name || entry.meta.productName,
    changes: {
      visible: Number(values.visible),
      trackInventory: Number(values.trackInventory),
      inventory: Number(values.inventory),
      ...(!values.customerPriceOverrides?.length ? {
        onSale: Number(values.onSale),
        saleDiscount: Number(values.saleDiscount) / 100,
      } : {}),
    },
  };
}

function numeric(value) {
  return value === "" || value == null ? null : Number(value);
}

// Each successful domain is acknowledged separately. Retrying cannot erase failed or newer edits.
export async function saveProductDraft(entry, capabilities, api) {
  const fields = dirtyFields(entry);
  const value = entry.values;
  const productId = entry.meta.productId;
  const result = {
    productId,
    productName: value.name,
    ok: false,
    savedFields: [],
    savedPackageIds: [],
    errors: [],
  };
  const run = async (label, keys, operation, packageId = null) => {
    try {
      const response = await operation();
      if (response?.ok === false || response?.skipped)
        throw new Error(response.message || "Update was not applied.");
      result.savedFields.push(...keys);
      if (packageId != null) result.savedPackageIds.push(packageId);
    } catch (error) {
      result.errors.push(`${label}: ${error.message || "Save failed"}`);
    }
  };
  if (!capabilities.edit) {
    result.errors.push("Product editing permission is required.");
    return result;
  }
  if (!String(value.name).trim()) {
    result.errors.push("Product name is required.");
    return result;
  }
  if (!Number.isInteger(Number(value.vendorId)) || Number(value.vendorId) <= 0) {
    result.errors.push("A vendor is required. Select a vendor in Product Details before saving.");
    return result;
  }
  if (
    !Number.isFinite(Number(value.inventory)) ||
    Number(value.inventory) < 0 ||
    !Number.isFinite(Number(value.saleDiscount)) ||
    Number(value.saleDiscount) < 0 ||
    Number(value.saleDiscount) > 100
  ) {
    result.errors.push(
      "Stock must be nonnegative and sale discount must be between 0 and 100.",
    );
    return result;
  }
  const metadata = fields.filter((key) => METADATA_FIELDS.includes(key));
  if (metadata.length) {
    await run("Details", metadata, () =>
      api.put(
        `products/${productId}`,
        Object.fromEntries(
          metadata.map((key) => [
            key,
            key.endsWith("Id") ? numeric(value[key]) : value[key],
          ]),
        ),
      ),
    );
  }
  if (metadata.includes("vendorId") && !result.savedFields.includes("vendorId")) return result;
  if (fields.some(key => FARM_INVENTORY_FIELDS.includes(key))) await saveFarmInventory(entry, api, result);
  if (fields.includes('customerPriceOverrides')) {
    await run('Customer prices', ['customerPriceOverrides'], async () => {
      if (!capabilities.pricing) throw new Error('Pricing permission is required.');
      return api.put(`products/${productId}/customer-prices`, { customerPriceOverrides: normalizeCustomerPriceOverrides(value.customerPriceOverrides) });
    });
    if (!result.savedFields.includes('customerPriceOverrides')) return result;
  }
  const inventory = fields.filter((key) => SCHEDULE_FIELDS.includes(key));
  if (inventory.length) {
    await run("Stock / sale", inventory, async () => {
      const response = await api.post("products/bulk-update", {
        applyRemote: false,
        queueRemoteSync: true,
        syncPricingProfileSale: true,
        updates: [buildScheduleUpdate(entry)],
      });
      const saved = response.results?.find(
        (item) => Number(item.productId) === productId,
      );
      if (!saved?.databaseUpdate)
        throw new Error(saved?.message || "Local update was not confirmed.");
      return { ok: true };
    });
  }
  const formula = fields.filter((key) => FORMULA_FIELDS.includes(key));
  if (fields.includes("markupOverride")) {
    await run("Product markup", ["markupOverride"], async () => {
      if (!capabilities.pricing) throw new Error("Pricing permission is required.");
      const markup = numeric(value.markupOverride);
      if (markup !== null && (!Number.isFinite(markup) || markup < 0)) throw new Error("Product markup must be a nonnegative percentage.");
      return api.put(`products/${productId}/markup`, { markupOverride: markup === null ? null : markup / 100 });
    });
  }
  if (formula.length) {
    await run("Formula pricing", formula, async () => {
      if (!capabilities.pricing)
        throw new Error("Pricing permission is required.");
      if (
        metadata.includes("vendorId") &&
        !result.savedFields.includes("vendorId")
      )
        throw new Error("Save the vendor change before changing its formula.");
      if (!(numeric(value.sourceUnitPrice) > 0))
        throw new Error("Vendor's retail price must be greater than zero.");
      for (const key of ["minWeight", "maxWeight", "avgWeightOverride"]) {
        if (
          value[key] !== "" &&
          (!Number.isFinite(Number(value[key])) || Number(value[key]) < 0)
        )
          throw new Error("Weights must be nonnegative numbers.");
      }
      if (
        value.minWeight !== "" &&
        value.maxWeight !== "" &&
        Number(value.minWeight) > Number(value.maxWeight)
      )
        throw new Error("Minimum weight cannot exceed maximum weight.");
      return api.put(
        `products/${productId}/pricing-profile`,
        Object.fromEntries(
          FORMULA_FIELDS.map((key) => [
            key,
            key === "unitOfMeasure" ? value[key] : numeric(value[key]),
          ]),
        ),
      );
    });
  }
  if (fields.includes("packages")) {
    for (const pkg of value.packages) {
      const original = entry.defaults.packages.find(
        (item) => item.id === pkg.id,
      );
      if (valuesEqual(pkg, original)) continue;
      await run(
        `Package ${pkg.name}`,
        [],
        async () => {
          if (!capabilities.pricing)
            throw new Error("Pricing permission is required.");
          if (!pkg.id || !original)
            throw new Error("Save new packages through product creation.");
          if (
            pkg.price === "" ||
            !Number.isFinite(Number(pkg.price)) ||
            Number(pkg.price) < 0
          )
            throw new Error("Price must be a nonnegative number.");
          return api.put(`packages/${pkg.id}`, {
            ...pkg,
            price: Number(pkg.price),
          });
        },
        pkg.id,
      );
    }
  }
  if (fields.includes("priceListEntries")) {
    await run("Cached Local Line entries", ["priceListEntries"], async () => {
      if (!capabilities.cachedPricing)
        throw new Error("Pricing Admin permission is required.");
      const entries = value.priceListEntries.map((entry) => ({
        ...entry,
        finalPriceCache: numeric(entry.finalPriceCache),
        strikethroughDisplayValue: numeric(entry.strikethroughDisplayValue),
        maxUnitsPerOrder: numeric(entry.maxUnitsPerOrder),
      }));
      const response = await api.put(
        `localline/products/${productId}/price-list-entries`,
        { entries },
      );
      if (response.updated !== entries.length)
        throw new Error("Some cached entries were not updated.");
      return response;
    });
  }
  result.ok = result.errors.length === 0;
  result.partial =
    !result.ok &&
    Boolean(result.savedFields.length || result.savedPackageIds.length);
  return result;
}

export function syncLabel(row) {
  if (row.remoteSyncStatus === "failed") return "Failed";
  if (!(Number(row.localLineProductId) > 0)) return "Local-only";
  if (row.hasPendingRemoteApply || row.remoteSyncStatus === "pending")
    return "Pending push";
  return row.remoteSyncStatus === "applied" ? "Synced" : "Not pushed";
}

export function previewProductPrices(row, values) {
  const round = (value) => Number(value.toFixed(2));
  const visible = values.packages.filter((pkg) => pkg.visible);
  const packages = visible.length ? visible : values.packages;
  const noMarkup = String(values.name).toLowerCase().includes("deposit");
  const prices = packages
    .map((pkg) => {
      if (!row.usesSourcePricing) return numeric(pkg.price);
      const sourcePrice = numeric(values.sourceUnitPrice);
      const factor = noMarkup ? 1 : numeric(values.sourceMultiplier);
      if (sourcePrice === null || factor === null) return null;
      const snapshot = row.packages?.find((item) => item.id === pkg.id);
      let quantity = snapshot?.quantity ?? pkg.numOfItems ?? 1;
      if (values.unitOfMeasure === "lbs") {
        const min = numeric(values.minWeight),
          max = numeric(values.maxWeight),
          override = numeric(values.avgWeightOverride);
        quantity =
          override > 0
            ? override
            : min !== null && max !== null
              ? (min + max) / 2
              : (snapshot?.averageWeight ?? min ?? max);
        if (!(quantity > 0)) return null;
        quantity = Number(Number(quantity).toFixed(3));
      }
      return round(sourcePrice * factor * quantity);
    })
    .filter((value) => value !== null && Number.isFinite(value));
  const basePrice = prices.length ? Math.min(...prices) : null;
  const result = { basePrice };
  for (const kind of ["guest", "member", "herdShare", "snap"]) {
    const override = !row.usesSourcePricing ? numeric(values.markupOverride) : null;
    const defaultMarkup = row.markupOverride != null ? numeric(row.vendorPriceListMarkup) : numeric(row[`${kind}Markup`]);
    const markup = noMarkup ? 0 : override !== null ? override / 100 : defaultMarkup;
    result[`${kind}Price`] =
      basePrice === null || markup === null
        ? null
        : round(
            basePrice *
              (1 + markup) *
              (values.onSale ? 1 - Number(values.saleDiscount) / 100 : 1),
          );
    if (!row.usesSourcePricing && !noMarkup && values.customerPriceOverrides?.length) {
      const listId = row.customerPriceLists?.find(list => list.key === kind)?.id;
      const choices = packages.map(pkg => {
        const setting = values.customerPriceOverrides.find(setting => Number(setting.packageId) === Number(pkg.id) && Number(setting.priceListId) === Number(listId));
        try { return setting ? customerOverridePrice(pkg.price, normalizeCustomerPriceOverrides([setting])[0]).final
          : numeric(pkg.price) === null || markup === null ? null : round(Number(pkg.price) * (1 + markup) * (values.onSale ? 1 - Number(values.saleDiscount) / 100 : 1)); }
        catch { return null; }
      }).filter(value => value !== null);
      result[`${kind}Price`] = choices.length ? Math.min(...choices) : null;
    }
  }
  return result;
}
