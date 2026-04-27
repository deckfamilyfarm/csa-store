import { eq } from "drizzle-orm";
import {
  localLineProductMeta,
  localLinePackageMeta,
  packages,
  productImages,
  productMedia,
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
let cachedProductUnits = null;

function debugEnabled(productId) {
  return Number.isFinite(DEBUG_PRODUCT_ID) && DEBUG_PRODUCT_ID === productId;
}

function isDairyCategoryName(name) {
  return typeof name === "string" && /dairy|milk|cheese|yogurt/i.test(name);
}

export function isLocalLineEnabled() {
  return isLocalLineAuthConfigured();
}

async function fetchLocalLineCollection(path, accessToken) {
  const results = [];
  let nextUrl = path.startsWith("http") ? path : `${LL_BASEURL}${path}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LocalLine collection fetch failed: ${response.status} ${body}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.results)) {
      results.push(...payload.results);
      nextUrl = payload.next || null;
      continue;
    }

    if (Array.isArray(payload)) {
      results.push(...payload);
      break;
    }

    break;
  }

  return results;
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

async function createLocalLineProduct(accessToken, payload) {
  const url = `${LL_BASEURL}products/`;
  const companyBaseUrl = process.env.LL_COMPANY_BASEURL || "";
  const response = await fetch(url, {
    method: "POST",
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
    throw new Error(`LocalLine POST failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function createLocalLineProductImage(accessToken, imageBuffer, filename, contentType = "image/jpeg") {
  const url = `${LL_BASEURL}product-images/`;
  const companyBaseUrl = process.env.LL_COMPANY_BASEURL || "";
  const formData = new FormData();
  formData.append("image", new Blob([imageBuffer], { type: contentType }), filename);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(companyBaseUrl
        ? {
            Referer: companyBaseUrl,
            Origin: companyBaseUrl
          }
        : {})
    },
    body: formData
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine product image upload failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function fetchLocalLineProductUnits(accessToken) {
  if (Array.isArray(cachedProductUnits) && cachedProductUnits.length) {
    return cachedProductUnits;
  }

  const url = `${LL_BASEURL}product-units/`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine product units failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  cachedProductUnits = Array.isArray(payload?.results) ? payload.results : [];
  return cachedProductUnits;
}

export async function fetchAllLocalLineFulfillmentStrategies() {
  const accessToken = await getLocalLineAccessToken();
  return fetchLocalLineCollection("fulfillment-strategies/?page_size=100", accessToken);
}

export async function fetchLocalLineOrdersPage(options = {}) {
  const accessToken = await getLocalLineAccessToken();
  const page = Number.isFinite(options.page) ? options.page : 1;
  const pageSize = Number.isFinite(options.pageSize) ? options.pageSize : 100;
  const ordering = String(options.ordering || "-id").trim() || "-id";
  const params = new URLSearchParams({
    page: String(Math.max(1, page)),
    page_size: String(Math.max(1, pageSize)),
    ordering
  });
  const url = `${LL_BASEURL}orders/?${params.toString()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine orders fetch failed: ${response.status} ${body}`);
  }
  return response.json();
}

function normalizeUnitLabel(value) {
  return String(value || "").trim().toLowerCase();
}

function isThumbnailUrl(url) {
  return /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(String(url || ""));
}

function buildFileNameFromUrl(url, fallback = "product-image.jpg") {
  try {
    const parsed = new URL(String(url || ""));
    const candidate = parsed.pathname.split("/").pop() || fallback;
    return candidate.includes(".") ? candidate : fallback;
  } catch (_error) {
    return fallback;
  }
}

async function getLocalProductImageSources(db, productId) {
  let mediaRows = [];
  try {
    mediaRows = await db.select().from(productMedia).where(eq(productMedia.productId, productId));
  } catch (_error) {
    mediaRows = [];
  }

  const preferred = mediaRows
    .slice()
    .sort((left, right) => {
      const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
      if (primaryDelta !== 0) return primaryDelta;
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    })
    .map((row) => row.publicUrl || row.remoteUrl || row.sourceUrl || "")
    .filter((url) => url && !isThumbnailUrl(url));

  const imageRows = await db.select().from(productImages).where(eq(productImages.productId, productId));
  const fallback = imageRows
    .map((row) => row.url)
    .filter((url) => url && !isThumbnailUrl(url));

  return [...new Set([...preferred, ...fallback])];
}

async function syncLocalLineProductImages(db, productId, remoteProductId, accessToken) {
  const imageUrls = await getLocalProductImageSources(db, productId);
  if (!imageUrls.length) {
    return { uploaded: 0 };
  }

  const uploadedImages = [];
  for (const [index, imageUrl] of imageUrls.entries()) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Unable to fetch local product image ${index + 1}: ${response.status} ${body}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const uploaded = await createLocalLineProductImage(
      accessToken,
      Buffer.from(arrayBuffer),
      buildFileNameFromUrl(imageUrl, `product-${productId}-${index + 1}.jpg`),
      contentType
    );
    const uploadedId = parseNumber(uploaded?.id);
    if (uploadedId !== null) {
      uploadedImages.push({
        priority_order: index,
        product_image: uploadedId
      });
    }
  }

  if (!uploadedImages.length) {
    return { uploaded: 0 };
  }

  await patchLocalLineProduct(remoteProductId, accessToken, {
    images: uploadedImages
  });

  return { uploaded: uploadedImages.length };
}

async function updateLocalLineImages(db, productId, changes = {}) {
  if (!Boolean(changes.forceImageSync)) {
    return { ok: null };
  }

  const metaRow = await getLocalLineMetaRow(db, productId);
  const remoteProductId = resolveRemoteProductId(metaRow, productId);
  if (!Number.isFinite(remoteProductId) || remoteProductId <= 0) {
    return { ok: null };
  }

  if (isTestMode) {
    return { ok: null };
  }

  const token = await getLocalLineAccessToken();
  await syncLocalLineProductImages(db, productId, remoteProductId, token);
  return { ok: true };
}

function pickUnitByNames(units, names) {
  const normalizedNames = names.map((value) => normalizeUnitLabel(value));
  return (
    units.find((unit) => {
      const unitName = normalizeUnitLabel(unit?.name);
      const unitAbbreviation = normalizeUnitLabel(unit?.abbrieviation);
      return normalizedNames.includes(unitName) || normalizedNames.includes(unitAbbreviation);
    }) || null
  );
}

function resolveLocalLineUnitIds(productUnits, resolvedProfile, packageRows = []) {
  const itemUnits = productUnits.filter((unit) => unit?.unit_type === "item");
  const weightUnits = productUnits.filter((unit) => unit?.unit_type === "weight");
  const packageUnitNames = packageRows
    .map((pkg) => normalizeUnitLabel(pkg?.unit))
    .filter(Boolean);
  const usesWeight =
    resolvedProfile?.unitOfMeasure === "lbs" ||
    packageUnitNames.some((value) => /lb|lbs|pound|oz|ounce|kg|kilogram|g|gram/.test(value));

  const itemFallback =
    pickUnitByNames(itemUnits, ["ea", "each", "item"]) ||
    itemUnits.find((unit) => Boolean(unit?.default)) ||
    itemUnits[0] ||
    null;
  const weightFallback =
    pickUnitByNames(weightUnits, ["pound", "lb", "lbs", "ounce", "oz"]) ||
    weightUnits.find((unit) => Boolean(unit?.default)) ||
    weightUnits[0] ||
    null;

  const chosenUnit = usesWeight ? weightFallback || itemFallback : itemFallback || weightFallback;
  if (!chosenUnit?.id) {
    throw new Error("Unable to determine Local Line product unit ids");
  }

  return {
    baseUnitId: Number(chosenUnit.id),
    chargeUnitId: Number(chosenUnit.id)
  };
}

async function getLocalLineMetaRow(db, productId) {
  const rows = await db
    .select()
    .from(localLineProductMeta)
    .where(eq(localLineProductMeta.productId, productId))
    .catch(() => []);
  return rows[0] || null;
}

function resolveRemoteProductId(metaRow, productId) {
  const mappedId = Number(metaRow?.localLineProductId);
  if (Number.isFinite(mappedId) && mappedId > 0) {
    return mappedId;
  }
  return metaRow ? null : productId;
}

async function upsertLocalLineProductMeta(db, productId, localLineProductId, payload = {}) {
  const now = new Date();
  const existing = await getLocalLineMetaRow(db, productId);
  const record = {
    localLineProductId,
    internalId: payload.internalId ?? existing?.internalId ?? null,
    vendorName: payload.vendorName ?? existing?.vendorName ?? null,
    status: payload.status ?? existing?.status ?? null,
    visible: payload.visible ?? existing?.visible ?? null,
    trackInventory: payload.trackInventory ?? existing?.trackInventory ?? null,
    inventoryType: payload.inventoryType ?? existing?.inventoryType ?? null,
    productInventory: payload.productInventory ?? existing?.productInventory ?? null,
    packageCodesEnabled: payload.packageCodesEnabled ?? existing?.packageCodesEnabled ?? null,
    rawJson: payload.rawJson ?? existing?.rawJson ?? null,
    updatedAt: now,
    lastSyncedAt: payload.lastSyncedAt ?? now
  };

  if (existing) {
    await db
      .update(localLineProductMeta)
      .set(record)
      .where(eq(localLineProductMeta.productId, productId));
    return;
  }

  await db.insert(localLineProductMeta).values({
    productId,
    createdAt: now,
    ...record
  });
}

async function upsertLocalLinePackageMetaRows(db, productId, localPackageRows, remotePackages = []) {
  if (!localPackageRows.length || !remotePackages.length) {
    return;
  }

  const now = new Date();
  const existingRows = await db
    .select()
    .from(localLinePackageMeta)
    .where(eq(localLinePackageMeta.productId, productId))
    .catch(() => []);
  const existingByPackageId = new Map(
    existingRows.map((row) => [Number(row.packageId), row])
  );

  for (let index = 0; index < localPackageRows.length; index += 1) {
    const localPackage = localPackageRows[index];
    const remotePackage = remotePackages[index];
    const localPackageId = Number(localPackage?.id);
    const remotePackageId = Number(remotePackage?.id);
    if (!Number.isFinite(localPackageId) || !Number.isFinite(remotePackageId) || remotePackageId <= 0) {
      continue;
    }

    const record = {
      productId,
      localLinePackageId: remotePackageId,
      liveName: remotePackage?.name || localPackage?.name || "",
      livePrice: parseNumber(remotePackage?.package_price ?? remotePackage?.unit_price),
      liveVisible:
        typeof remotePackage?.visible === "boolean" ? (remotePackage.visible ? 1 : 0) : null,
      liveTrackInventory:
        typeof remotePackage?.track_inventory === "boolean"
          ? (remotePackage.track_inventory ? 1 : 0)
          : null,
      inventoryType: remotePackage?.inventory_type || null,
      packageInventory: parseNumber(remotePackage?.current_inventory),
      packageReservedInventory: parseNumber(remotePackage?.current_reserved_inventory),
      packageAvailableInventory: parseNumber(remotePackage?.current_unreserved_inventory),
      avgPackageWeight: parseNumber(remotePackage?.average_pack_weight),
      numOfItems: parseNumber(localPackage?.numOfItems),
      packageCode: remotePackage?.package_code || localPackage?.packageCode || null,
      rawJson: JSON.stringify(remotePackage || {}),
      updatedAt: now,
      lastSyncedAt: now
    };

    if (existingByPackageId.has(localPackageId)) {
      await db
        .update(localLinePackageMeta)
        .set(record)
        .where(eq(localLinePackageMeta.packageId, localPackageId));
      continue;
    }

    await db.insert(localLinePackageMeta).values({
      packageId: localPackageId,
      createdAt: now,
      ...record
    });
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
  const metaRow = await getLocalLineMetaRow(db, productId);
  const remoteProductId = resolveRemoteProductId(metaRow, productId);
  if (!Number.isFinite(remoteProductId) || remoteProductId <= 0) {
    return { ok: null };
  }
  if (isTestMode) {
    return { ok: null, payload };
  }
  const token = await getLocalLineAccessToken();
  await patchLocalLineProduct(remoteProductId, token, payload);
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
  const remotePackageIdByPackageId = new Map(
    packageMetaRows
      .map((row) => [Number(row.packageId), Number(row.localLinePackageId)])
      .filter(([, remoteId]) => Number.isFinite(remoteId) && remoteId > 0)
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
  const metaRow = await getLocalLineMetaRow(db, productId);
  const remoteProductId = resolveRemoteProductId(metaRow, productId);
  if (!Number.isFinite(remoteProductId) || remoteProductId <= 0) {
    return { ok: null };
  }
  const llProduct = await fetchLocalLineProduct(remoteProductId, token);
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
      ? llProduct.packages.find((item) => {
          const remotePackageId = remotePackageIdByPackageId.get(Number(pkg.id)) ?? Number(pkg.id);
          return Number(item.id) === Number(remotePackageId);
        })
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
      id: remotePackageIdByPackageId.get(Number(pkg.id)) ?? Number(pkg.id),
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

  await patchLocalLineProduct(remoteProductId, token, payload);
  return { ok: true };
}

export async function createLocalLineProductFromStoreProduct(db, productId) {
  if (!isLocalLineEnabled()) {
    throw new Error("Local Line authentication is not configured");
  }

  const productRows = await db.select().from(products).where(eq(products.id, productId));
  if (!productRows.length) {
    throw new Error(`Product ${productId} not found`);
  }
  const product = productRows[0];

  const existingMeta = await getLocalLineMetaRow(db, productId);
  const existingRemoteProductId = Number(existingMeta?.localLineProductId);
  const saleRows = await db.select().from(productSales).where(eq(productSales.productId, productId));
  const saleRow = saleRows[0] || null;
  if (Number.isFinite(existingRemoteProductId) && existingRemoteProductId > 0) {
    await updateLocalLineForProduct(db, productId, {
      visible: product.visible,
      trackInventory: product.trackInventory,
      inventory: product.inventory,
      onSale: saleRow?.onSale ?? 0,
      saleDiscount:
        saleRow?.saleDiscount === null || typeof saleRow?.saleDiscount === "undefined"
          ? 0
          : Number(saleRow.saleDiscount),
      forcePriceSync: true,
      forceImageSync: true
    });
    return {
      ok: true,
      alreadyLinked: true,
      localLineProductId: existingRemoteProductId
    };
  }

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
  if (!packageRows.length) {
    throw new Error("Product must have at least one package before pushing to Local Line");
  }

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

  const token = await getLocalLineAccessToken();
  const productUnits = await fetchLocalLineProductUnits(token);
  const { baseUnitId, chargeUnitId } = resolveLocalLineUnitIds(
    productUnits,
    resolvedProfile,
    packageRows
  );

  const packagePayloads = packageRows.map((pkg) => {
    const purchasePrice =
      computePackageBasePrice(resolvedProfile, pkg, packageMetaByPackageId.get(Number(pkg.id))) ??
      Number(pkg.price);
    if (!Number.isFinite(purchasePrice)) {
      throw new Error(`Package ${pkg.name || pkg.id} is missing a valid price`);
    }

    return {
      name: pkg.name || "Package",
      unit_price: purchasePrice,
      inventory_per_unit: Number(pkg.numOfItems) > 0 ? Number(pkg.numOfItems) : 1,
      package_code: pkg.packageCode || undefined,
      set_inventory:
        Number(pkg.trackInventory)
          ? parseNumber(pkg.inventory, null)
          : undefined,
      price_list_entries: priceLists.map((list) => ({ price_list: list.id }))
    };
  });

  const payload = {
    name: product.name,
    description: product.description || "",
    visible: Boolean(product.visible),
    track_inventory: Boolean(product.trackInventory),
    set_inventory:
      Number(product.trackInventory) || Number(product.inventory) === 0
        ? parseNumber(product.inventory, 0)
        : undefined,
    base_unit_id: baseUnitId,
    charge_unit_id: chargeUnitId,
    track_type: "package",
    charge_type: "package",
    package_codes_enabled: packagePayloads.some((pkg) => Boolean(pkg.package_code)),
    packages: packagePayloads,
    product_price_list_entries: priceLists.map((list) => ({
      price_list: list.id,
      taxed: false,
      valid_for_storecredits: true
    }))
  };

  if (isTestMode) {
    return {
      ok: true,
      testMode: true,
      payload
    };
  }

  const createdProduct = await createLocalLineProduct(token, payload);
  const createdProductId = Number(createdProduct?.id);
  if (!Number.isFinite(createdProductId) || createdProductId <= 0) {
    throw new Error("Local Line create response did not include a product id");
  }

  try {
    await syncLocalLineProductImages(db, productId, createdProductId, token);
  } catch (error) {
    console.error("LocalLine image sync failed:", error.message);
  }

  const remoteProduct = await fetchLocalLineProduct(createdProductId, token);

  await upsertLocalLineProductMeta(db, productId, createdProductId, {
    status: remoteProduct?.status || null,
    visible: typeof remoteProduct?.visible === "boolean" ? (remoteProduct.visible ? 1 : 0) : null,
    trackInventory:
      typeof remoteProduct?.track_inventory === "boolean"
        ? (remoteProduct.track_inventory ? 1 : 0)
        : null,
    inventoryType: remoteProduct?.inventory_type || null,
    productInventory: parseNumber(remoteProduct?.inventory),
    packageCodesEnabled:
      typeof remoteProduct?.package_codes_enabled === "boolean"
        ? (remoteProduct.package_codes_enabled ? 1 : 0)
        : null,
    rawJson: JSON.stringify(remoteProduct || {}),
    lastSyncedAt: new Date()
  });
  await upsertLocalLinePackageMetaRows(db, productId, packageRows, remoteProduct?.packages || []);

  try {
    await updateLocalLineForProduct(db, productId, {
      visible: product.visible,
      trackInventory: product.trackInventory,
      inventory: product.inventory,
      onSale: saleRow?.onSale ?? 0,
      saleDiscount:
        saleRow?.saleDiscount === null || typeof saleRow?.saleDiscount === "undefined"
          ? 0
          : Number(saleRow.saleDiscount),
      forcePriceSync: true,
      forceImageSync: true
    });
  } catch (error) {
    console.error("LocalLine post-create sync failed:", error.message);
  }

  return {
    ok: true,
    alreadyLinked: false,
    localLineProductId: createdProductId
  };
}

export async function updateLocalLineForProduct(db, productId, changes = {}) {
  if (!isLocalLineEnabled()) {
    return { inventoryOk: null, priceOk: null, imagesOk: null };
  }

  const inventoryResult = await updateLocalLineInventory(db, productId, changes);
  const priceResult = await updateLocalLinePrices(db, productId, changes);
  const imageResult = await updateLocalLineImages(db, productId, changes);

  return {
    inventoryOk: inventoryResult.ok ?? null,
    priceOk: priceResult.ok ?? null,
    imagesOk: imageResult.ok ?? null
  };
}
