import { eq } from "drizzle-orm";
import {
  localLinePackageMeta,
  packages,
  products,
  productPricingProfiles,
  productSales,
  vendors
} from "./schema.js";
import {
  getLocalLineAccessToken,
  getLocalLineBaseUrl,
  isLocalLineAuthConfigured
} from "./localLineAuth.js";
import {
  computePackageBasePrice,
  getPriceListDefinitions,
  resolvePricingProfile
} from "./lib/productPricing.js";

const LL_BASEURL = getLocalLineBaseUrl();
const isTestMode = process.env.LOCALLINE_TEST === "true";
const updatePrices = process.env.LOCALLINE_UPDATE_PRICES !== "false";

function parseNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function parseIdList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function buildPriceListsFromEnv() {
  const defaultGuest = parseNumber(process.env.LL_MARKUP_GUEST);
  const defaultMember = parseNumber(process.env.LL_MARKUP_MEMBER);
  const priceLists = {};
  const entries = [
    {
      key: "Guest Basket",
      id: parseNumber(process.env.LL_PRICE_LIST_GUEST_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_GUEST_MARKUP, defaultGuest)
    },
    {
      key: "CSA Members",
      id: parseNumber(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_CSA_MEMBERS_MARKUP, defaultMember)
    },
    {
      key: "Herd Share Members",
      id: parseNumber(process.env.LL_PRICE_LIST_HERDSHARE_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_HERDSHARE_MARKUP, defaultMember)
    },
    {
      key: "SNAP",
      id: parseNumber(process.env.LL_PRICE_LIST_SNAP_ID),
      markup: parseNumber(process.env.LL_PRICE_LIST_SNAP_MARKUP, defaultMember)
    }
  ];

  entries.forEach((entry) => {
    if (!Number.isFinite(entry.id) || !Number.isFinite(entry.markup)) {
      return;
    }
    priceLists[entry.key] = {
      id: entry.id,
      markup: entry.markup
    };
  });

  return priceLists;
}

const DAIRY_PRICE_LIST_IDS = parseIdList(process.env.LL_DAIRY_PRICE_LIST_IDS);
const DAIRY_MARKUP = parseNumber(process.env.LL_MARKUP_DAIRY, null);
const DEBUG_PRODUCT_ID = Number(process.env.LL_DEBUG_PRODUCT_ID || "");

function debugEnabled(productId) {
  return Number.isFinite(DEBUG_PRODUCT_ID) && DEBUG_PRODUCT_ID === productId;
}

function isDairyCategoryName(name) {
  return typeof name === "string" && /dairy|milk|cheese|yogurt/i.test(name);
}

export function isLocalLineEnabled() {
  return isLocalLineAuthConfigured();
}

async function fetchLocalLineProduct(productId, accessToken) {
  const url = `${LL_BASEURL}products/${productId}/?expand=packages,product_price_list_entries`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine GET failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function patchLocalLineProduct(productId, accessToken, payload) {
  const url = `${LL_BASEURL}products/${productId}/`;
  const companyBaseUrl = process.env.LL_COMPANY_BASEURL || "";
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(companyBaseUrl
        ? {
            Referer: companyBaseUrl,
            Origin: companyBaseUrl
          }
        : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine PATCH failed: ${response.status} ${body}`);
  }
}

function buildInventoryPayload(changes) {
  const payload = {};
  if (typeof changes.visible !== "undefined") {
    payload.visible = Boolean(changes.visible);
  }
  if (typeof changes.trackInventory !== "undefined") {
    payload.track_inventory = Boolean(changes.trackInventory);
  }
  if (typeof changes.inventory !== "undefined") {
    const inventory = Number(changes.inventory);
    if (Number.isFinite(inventory)) {
      const shouldSet = payload.track_inventory === true || inventory === 0;
      if (shouldSet) {
        payload.set_inventory = inventory;
      }
    }
  }
  return payload;
}

function buildPriceListEntry(basePrice, entry, markupDecimal, saleEnabled, saleDiscount) {
  if (!entry) return null;
  const safeMarkup = Number(markupDecimal);
  if (!Number.isFinite(safeMarkup)) return null;
  const safeBase = Number(basePrice);
  if (!Number.isFinite(safeBase)) return null;
  const priceListId = Number(entry.price_list_id ?? entry.price_list);
  const productPriceListEntryId = Number(entry.product_price_list_entry ?? entry.id);
  const liveAdjustmentType = Number(entry.adjustment_type);
  const adjustmentType =
    liveAdjustmentType === 1 || liveAdjustmentType === 2 || liveAdjustmentType === 3
      ? liveAdjustmentType
      : 2;
  if (!Number.isFinite(priceListId) || !Number.isFinite(productPriceListEntryId)) {
    return null;
  }

  let basePriceUsed = roundCurrency(safeBase);
  const regularFinalPrice = roundCurrency(safeBase * (1 + safeMarkup));
  let adjustmentValue =
    adjustmentType === 1
      ? roundCurrency(regularFinalPrice - basePriceUsed)
      : adjustmentType === 2
        ? roundCurrency(safeMarkup * 100)
        : regularFinalPrice;
  let calculated = regularFinalPrice;
  let strikethrough = null;
  let onSaleToggle = false;

  const salePct = Number(saleDiscount);
  if (saleEnabled && Number.isFinite(salePct) && salePct > 0) {
    const discountedFinal = regularFinalPrice * (1 - salePct);
    calculated = roundCurrency(discountedFinal);
    strikethrough = regularFinalPrice;
    onSaleToggle = true;

    if (adjustmentType === 1) {
      adjustmentValue = roundCurrency(calculated - basePriceUsed);
    } else if (adjustmentType === 2) {
      basePriceUsed = roundCurrency(discountedFinal / (1 + safeMarkup));
      const saleMarkup = (discountedFinal - basePriceUsed) / basePriceUsed;
      adjustmentValue = roundCurrency(saleMarkup * 100);
    } else {
      adjustmentValue = calculated;
    }
  }

  return {
    adjustment: true,
    adjustment_type: adjustmentType,
    adjustment_value: adjustmentValue,
    price_list: priceListId,
    checked: true,
    notSubmitted: false,
    edited: false,
    dirty: true,
    product_price_list_entry: productPriceListEntryId,
    calculated_value: calculated,
    on_sale: Boolean(saleEnabled),
    on_sale_toggle: onSaleToggle,
    max_units_per_order: null,
    strikethrough_display_value: strikethrough,
    base_price_used: basePriceUsed
  };
}

async function updateLocalLineInventory(db, productId, changes) {
  const payload = buildInventoryPayload(changes);
  if (!Object.keys(payload).length) {
    return { ok: null };
  }
  if (isTestMode) {
    return { ok: null, payload };
  }
  const token = await getLocalLineAccessToken();
  await patchLocalLineProduct(productId, token, payload);
  return { ok: true };
}

async function updateLocalLinePrices(db, productId, changes) {
  if (!updatePrices) {
    return { ok: null };
  }

  const saleFieldsProvided =
    Object.prototype.hasOwnProperty.call(changes, "onSale") ||
    Object.prototype.hasOwnProperty.call(changes, "saleDiscount") ||
    Boolean(changes.forcePriceSync);
  if (!saleFieldsProvided) {
    return { ok: null };
  }

  const productRows = await db.select().from(products).where(eq(products.id, productId));
  if (!productRows.length) {
    throw new Error(`Product ${productId} not found`);
  }
  const product = productRows[0];

  const vendorRows = product.vendorId
    ? await db.select().from(vendors).where(eq(vendors.id, product.vendorId))
    : [];
  const profileRows = await db
    .select()
    .from(productPricingProfiles)
    .where(eq(productPricingProfiles.productId, productId));

  const packageRows = await db.select().from(packages).where(eq(packages.productId, productId));
  const packageMetaRows = packageRows.length
    ? await db
        .select()
        .from(localLinePackageMeta)
        .where(eq(localLinePackageMeta.productId, productId))
        .catch(() => [])
    : [];

  const packageMetaByPackageId = new Map(
    packageMetaRows.map((row) => [Number(row.packageId), row])
  );

  const resolvedProfile = resolvePricingProfile({
    profile: profileRows[0] || null,
    product,
    packages: packageRows,
    packageMetaByPackageId,
    vendor: vendorRows[0] || null
  });
  const priceLists = getPriceListDefinitions(resolvedProfile);
  if (!priceLists || Object.keys(priceLists).length === 0) {
    return { ok: null };
  }

  if (debugEnabled(productId)) {
    console.log("[LocalLine debug] price list config", {
      productId,
      priceListIds: priceLists.map((entry) => entry.id),
      sourceUnitPrice: resolvedProfile.sourceUnitPrice,
      unitOfMeasure: resolvedProfile.unitOfMeasure
    });
  }

  const saleRows = await db.select().from(productSales).where(eq(productSales.productId, productId));
  const saleRow = saleRows[0] || {};
  const saleEnabled =
    typeof changes.onSale !== "undefined"
      ? Boolean(changes.onSale)
      : profileRows.length
        ? Boolean(resolvedProfile.onSale)
        : Boolean(saleRow.onSale);
  const saleDiscountRaw =
    typeof changes.saleDiscount === "number"
      ? changes.saleDiscount
      : profileRows.length
        ? resolvedProfile.saleDiscount
        : saleRow.saleDiscount;
  const saleDiscount = Number(saleDiscountRaw || 0);

  if (!packageRows.length) {
    if (debugEnabled(productId)) {
      console.log("[LocalLine debug] no packages found for product.");
    }
    return { ok: null };
  }

  const token = await getLocalLineAccessToken();
  const llProduct = await fetchLocalLineProduct(productId, token);
  const llEntries = Array.isArray(llProduct?.product_price_list_entries)
    ? llProduct.product_price_list_entries
    : [];
  const productEntryByListId = new Map(
    llEntries.map((entry) => [Number(entry.price_list), entry]).filter(([id]) => Number.isFinite(id))
  );

  if (debugEnabled(productId)) {
    console.log("[LocalLine debug] LocalLine entries", {
      entryListIds: [...productEntryByListId.keys()],
      packageCount: packageRows.length,
      saleEnabled,
      saleDiscount
    });
  }

  const packagePayloads = [];
  for (const pkg of packageRows) {
    const purchasePrice =
      computePackageBasePrice(resolvedProfile, pkg, packageMetaByPackageId.get(Number(pkg.id))) ??
      Number(pkg.price);
    if (!Number.isFinite(purchasePrice)) {
      continue;
    }
    const llPackage = Array.isArray(llProduct?.packages)
      ? llProduct.packages.find((item) => Number(item.id) === Number(pkg.id))
      : null;
    const packageEntryByListId = new Map(productEntryByListId);
    if (Array.isArray(llPackage?.price_list_entries)) {
      llPackage.price_list_entries.forEach((entry) => {
        const listId = Number(entry.price_list_id ?? entry.price_list);
        if (Number.isFinite(listId)) {
          packageEntryByListId.set(listId, entry);
        }
      });
    }

    const entries = [];
    for (const list of priceLists) {
      const markup = list.markup;
      const existingEntry = packageEntryByListId.get(list.id);
      if (!existingEntry) {
        continue;
      }
      const built = buildPriceListEntry(purchasePrice, existingEntry, markup, saleEnabled, saleDiscount);
      if (built) {
        entries.push(built);
      }
    }

    if (!entries.length) {
      continue;
    }

    packagePayloads.push({
      id: pkg.id,
      name: pkg.name,
      unit_price: purchasePrice,
      package_price: purchasePrice,
      package_unit_price: purchasePrice,
      inventory_per_unit: 1,
      price_list_entries: entries,
      package_code: pkg.packageCode || undefined
    });
  }

  if (!packagePayloads.length) {
    if (debugEnabled(productId)) {
      console.log("[LocalLine debug] no price list entries matched for payload.");
    }
    return { ok: null };
  }

  const payload = {
    name: product.name,
    description: product.description || "",
    package_codes_enabled: true,
    packages: packagePayloads
  };
  if (isTestMode) {
    return { ok: null, payload };
  }

  await patchLocalLineProduct(productId, token, payload);
  return { ok: true };
}

export async function updateLocalLineForProduct(db, productId, changes = {}) {
  if (!isLocalLineEnabled()) {
    return { inventoryOk: null, priceOk: null };
  }

  const inventoryResult = await updateLocalLineInventory(db, productId, changes);
  const priceResult = await updateLocalLinePrices(db, productId, changes);

  return {
    inventoryOk: inventoryResult.ok ?? null,
    priceOk: priceResult.ok ?? null
  };
}
