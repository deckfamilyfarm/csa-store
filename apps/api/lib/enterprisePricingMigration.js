import crypto from "node:crypto";
import { calculateEnterprisePricing, averagePackageWeight, DEFAULT_PRICING_SETTINGS, roundRatio, scaledInteger } from "./enterprisePricingEngine.js";
import { deriveLegacyPricingEvidence } from "./legacyPricingEvidence.js";
import { computeProductPricingSnapshot, computePackageBasePrice, computeCustomerPrice, isSourcePricingVendor } from "./productPricing.js";

export const MIGRATION_VERSION = "enterprise-pricing-v1";
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
const group = (rows, key) => {
  const map = new Map();
  for (const row of rows) { const id = Number(row[key]); if (!map.has(id)) map.set(id, []); map.get(id).push(row); }
  return map;
};
const positive = value => Number(value) > 0 ? Number(value) : null;
const cents = value => value == null ? null : Math.round(Number(value) * 100);
const baskets = ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"];
export const migrationFingerprint = record => crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");

// A caller-supplied read-only connection lets preview run without schema writes.
export async function readMigrationCatalog(connection) {
  const rows = {};
  for (const name of ["products", "packages", "vendors", "categories", "product_pricing_profiles", "product_sales",
    "local_line_package_meta", "local_line_price_list_entries", "square_variation_links", "square_catalog_variations", "price_lists"]) {
    const order = ["product_pricing_profiles", "product_sales"].includes(name) ? "product_id"
      : name === "square_catalog_variations" ? "square_variation_id"
        : name === "local_line_package_meta" ? "package_id" : "id";
    const [values] = await connection.query(`SELECT * FROM \`${name}\` ORDER BY ${order}`);
    rows[name] = values;
  }
  const byId = name => new Map(rows[name].map(row => [Number(row.id), row]));
  const vendors = byId("vendors"), categories = byId("categories");
  const profiles = group(rows.product_pricing_profiles, "product_id"), sales = group(rows.product_sales, "product_id");
  const packages = group(rows.packages, "product_id"), meta = group(rows.local_line_package_meta, "package_id");
  const ll = group(rows.local_line_price_list_entries, "product_id"), links = group(rows.square_variation_links, "product_id");
  const variations = new Map(rows.square_catalog_variations.map(row => [row.square_variation_id, row]));
  return rows.products.filter(row => !Number(row.is_deleted)).map(rawProduct => {
    const product = camel(rawProduct), vendor = camel(vendors.get(Number(product.vendorId)));
    product.vendorName = vendor?.name || null;
    product.categoryName = categories.get(Number(product.categoryId))?.name || null;
    product.vendorPriceListMarkup = vendor?.priceListMarkup;
    product.vendorGuestMarkup = vendor?.guestMarkup;
    const profile = camel(profiles.get(Number(product.id))?.[0]);
    if (profile) profile.pricingUnit = profile.unitOfMeasure;
    return { product, vendor, profile, sale: camel(sales.get(Number(product.id))?.[0]) || null,
      priceListIds: Object.fromEntries(rows.price_lists.map(row => [row.name, Number(row.local_line_price_list_id)])),
      packages: (packages.get(Number(product.id)) || []).map(row => ({ ...camel(row),
        cachedWeight: meta.get(Number(row.id))?.[0]?.avg_package_weight || null,
        metadata: camel(meta.get(Number(row.id))?.[0]) || null })),
      localLinePrices: (ll.get(Number(product.id)) || []).map(row => ({ ...camel(row),
        listName: row.price_list_name, finalPrice: row.final_price_cache,
        crossedOutPrice: row.strikethrough_display_value })),
      squarePrices: (links.get(Number(product.id)) || []).filter(row => row.approved_at).map(row => {
        const variation = variations.get(row.square_variation_id);
        return { ...camel(row), priceCents: variation?.price_amount ?? null,
          variation: camel(variation) || null, cachedAt: variation?.last_synced_at || null };
      }) };
  });
}

export function planProductMigration(record, { settings = DEFAULT_PRICING_SETTINGS, effectiveAt } = {}) {
  const productId = Number(record.product.id);
  const result = { productId, product: record.product.name, vendor: record.product.vendorName,
    fingerprint: migrationFingerprint(record), approvedForMigration: false,
    action: "review", blockers: [], reviewReasons: [], input: null, output: null,
    source: record, comparisons: [], buyPrice: null };
  const hold = reason => { result.blockers.push(reason); return result; };
  if (/deposit/i.test(result.product) || String(record.product.categoryName).toLowerCase() === "membership") {
    result.action = "preserve-special";
    result.reviewReasons.push("Keep the existing deposit or membership workflow.");
    return result;
  }
  if (!record.vendor?.name?.trim()) return hold("Vendor missing");
  if (!record.packages.length) return hold("No package definitions");
  const formula = isSourcePricingVendor(record.vendor);
  const profile = record.profile || {};
  const vendorName = result.vendor.toLowerCase();
  const squareGroup = vendorName.includes("hyland") ? "hyland" : vendorName.includes("deck family farm") ? "deck"
    : vendorName.includes("creamy cow") ? "creamyCow" : "other";
  const squareEnabled = Boolean(settings.squareDefaults[squareGroup]);
  let unit = ["lb", "lbs"].includes(profile.pricingUnit) ? "lb" : profile.pricingUnit === "each" ? "each" : null;
  if (!unit && !formula) unit = "each";
  if (!unit && !squareEnabled && record.packages.every(pkg =>
    !positive(pkg.cachedWeight) && Number(pkg.numOfItems || 1) >= 1 && !/lb|pound/i.test(pkg.unit || ""))) {
    unit = "each";
    result.reviewReasons.push("Each unit inferred from fixed packages; confirm during migration review.");
  }
  if (!unit) return hold("Explicit pricing unit required");
  const packages = record.packages.map(pkg => ({ packageId: Number(pkg.id), quantity: Number(pkg.numOfItems) || 1,
    minWeight: positive(profile.minWeight), maxWeight: positive(profile.maxWeight),
    avgWeightOverride: positive(profile.avgWeightOverride), cachedWeight: positive(pkg.cachedWeight) }));
  let factors;
  try {
    factors = packages.map(pkg => unit === "lb" ? averagePackageWeight(pkg).milliPounds / 1000 : pkg.quantity);
    if (factors.some(value => !(value > 0))) return hold("Package weight or quantity missing");
  } catch (error) { return hold(error.message); }
  // Prefer the first visible package as the reproducible reference package.
  const refIndex = Math.max(0, record.packages.findIndex(pkg => Number(pkg.visible ?? 1) !== 0));
  const reference = record.packages[refIndex];
  const packageCostCents = record.packages.map((pkg, index) => cents(Number(pkg.price) / factors[index]));
  const buyCents = packageCostCents[refIndex];
  if (!(buyCents > 0)) return hold("Positive Buy Price could not be inferred from stored package prices");
  result.buyPrice = { cents: buyCents, basis: `Stored package ${reference.id} price divided by ${factors[refIndex]} ${unit}`,
    inferred: true, pricingUnit: unit };
  if (new Set(packageCostCents).size > 1) result.reviewReasons.push("Package Buy Prices differ; the first visible package is the reference.");
  const evidence = deriveLegacyPricingEvidence(record);
  const onSale = evidence.sale.activeInProduct || evidence.sale.activeInProfile;
  const saleBp = onSale && positive(evidence.sale.discountPercent) ? Math.round(evidence.sale.discountPercent * 100) : 0;
  if (onSale) result.reviewReasons.push("Existing sale must be reviewed as a separate promotion; this proposal sets regular prices.");
  if (evidence.sale.flagsConflict) result.reviewReasons.push("Existing sale flags disagree.");
  if (profile.customerPriceOverridesJson && profile.customerPriceOverridesJson !== "[]") {
    result.reviewReasons.push("Existing basket-specific overrides require reconciliation.");
  }
  if (record.squarePrices.length && !squareEnabled) result.reviewReasons.push("Existing Square mapping retained; vendor default excludes Square publication.");
  result.sale = { onSale, discountBp: saleBp };
  const meta = new Map(record.packages.map(pkg => [Number(pkg.id), { ...pkg.metadata, avgPackageWeight: pkg.cachedWeight }]));
  const legacy = computeProductPricingSnapshot({ product: record.product, vendor: record.vendor, profile,
    packages: record.packages, packageMetaByPackageId: meta });
  const legacyRows = new Map(record.packages.map(pkg => {
    const basePrice = computePackageBasePrice(legacy.profile, pkg, meta.get(Number(pkg.id)));
    const guest = computeCustomerPrice(basePrice, legacy.profile, Number(pkg.id), {
      id: record.priceListIds?.["Guest Basket"] ?? record.localLinePrices.find(row => row.listName === "Guest Basket")?.priceListId,
      markup: legacy.profile.guestMarkup });
    return [Number(pkg.id), { customerPrices: { guest } }];
  }));
  const normalLL = record.packages.map(pkg => {
    const entries = record.localLinePrices.filter(row => Number(row.packageId) === Number(pkg.id) && baskets.includes(row.listName));
    const entry = entries.find(row => row.listName === "Guest Basket") || entries.find(row => row.finalPrice != null);
    return positive(entry?.crossedOutPrice) && (onSale || Number(entry?.onSale)) ? cents(entry.crossedOutPrice)
      : entry?.finalPrice != null && !onSale ? cents(entry.finalPrice)
        : cents(legacyRows.get(Number(pkg.id))?.customerPrices?.guest?.regular);
  });
  const cachedSquare = record.squarePrices.find(row => Number(row.packageId) === Number(reference.id) && row.priceCents > 0);
  let target;
  if (squareEnabled) {
    target = onSale && positive(profile.sourceUnitPrice) ? cents(profile.sourceUnitPrice)
      : cachedSquare ? roundRatio(Number(cachedSquare.priceCents), unit === "each" ? packages[refIndex].quantity : 1)
        : cents(profile.sourceUnitPrice);
    if (!(target > 0)) return hold("Square reference price missing");
    target = roundRatio(target, settings.squareIncrementCents) * settings.squareIncrementCents;
    if (!cachedSquare) result.reviewReasons.push("Square reference uses stored retail price; variation mapping needs review.");
  } else target = normalLL[refIndex] == null ? null : cents(normalLL[refIndex] / 100 / factors[refIndex]);
  if (!(target > 0)) return hold("Retail reference price missing");
  if (target < buyCents) return hold("Retail reference is below inferred Buy Price; cost or pricing needs review");
  const markupBp = roundRatio(BigInt(target) * 10000n, BigInt(buyCents)) - 10000;
  const input = { retailEnterpriseCode: "ffcsa", pricingUnit: unit, priceEffectiveAt: effectiveAt,
    markupCategory: "custom", customMarkupBp: markupBp, squareEnabled,
    squareOverride: null, csaOverride: null, overrideNote: "", saleBp: 0,
    purchaseCosts: [{ enterpriseCode: "ffcsa", cost: (buyCents / 100).toFixed(2), effectiveAt,
      documentationRef: `Migration inference: package ${reference.id}; source ${result.fingerprint}` }],
    wholesale: [], packages };
  let output;
  try { output = calculateEnterprisePricing({ ...input, buyFromPrice: input.purchaseCosts[0].cost }, settings); }
  catch (error) { return hold(error.message); }
  // Calibrated markup normally reproduces the target. An explicit override
  // handles integer percentage precision at unusually large prices.
  if ((squareEnabled ? output.squareUnitCents : output.csaUnitCents) !== target) {
    input[squareEnabled ? "squareOverride" : "csaOverride"] = (target / 100).toFixed(2);
    input.overrideNote = "Preserve migration reference price after markup precision rounding";
    output = calculateEnterprisePricing({ ...input, buyFromPrice: input.purchaseCosts[0].cost }, settings);
  }
  output.wholesale = [];
  result.input = input; result.output = output;
  result.action = "ready";
  for (const [index, pkg] of record.packages.entries()) {
    const prices = record.localLinePrices.filter(row => Number(row.packageId) === Number(pkg.id) && baskets.includes(row.listName));
    if (new Set(prices.map(row => cents(row.finalPrice))).size > 1 && !result.reviewReasons.includes("Existing basket prices differ.")) {
      result.reviewReasons.push("Existing basket prices differ.");
    }
    if (new Set(prices.map(row => row.listName)).size !== 4 && !result.reviewReasons.includes("One or more Local Line basket prices are missing.")) {
      result.reviewReasons.push("One or more Local Line basket prices are missing.");
    }
    const regular = output.packages[index].localLineRegularCents;
    const projectedSale = saleBp ? roundRatio(BigInt(regular) * BigInt(10000 - saleBp), 10000n) : regular;
    result.comparisons.push({ packageId: Number(pkg.id), package: pkg.name,
      currentLocalCents: cents(legacyRows.get(Number(pkg.id))?.customerPrices?.guest?.final),
      currentLocalLine: prices.map(row => ({ basket: row.listName, cents: cents(row.finalPrice),
        proposedCents: projectedSale, differenceCents: row.finalPrice == null ? null : projectedSale - cents(row.finalPrice) })),
      currentSquare: record.squarePrices.filter(row => Number(row.packageId) === Number(pkg.id)).map(row => ({
        cents: row.priceCents, proposedRegularCents: output.packages[index].squareVariationCents,
        proposedSaleCents: output.packages[index].squareVariationCents == null ? null
          : roundRatio(BigInt(output.packages[index].squareVariationCents) * BigInt(10000 - saleBp), 10000n) })),
      proposedLocalLineRegularCents: regular, proposedLocalLineSaleCents: projectedSale });
  }
  if (result.comparisons.some(pkg => pkg.currentLocalLine.some(price => price.cents > 0 && Math.abs(price.differenceCents / price.cents) > 0.2))) {
    result.reviewReasons.push("Local Line price changes by more than 20%; review the reference price and package units.");
  }
  return result;
}

export function buildMigrationPlan(records, options = {}) {
  const effectiveAt = options.effectiveAt || new Date().toISOString().slice(0, 19).replace("T", " ");
  const settings = options.settings || DEFAULT_PRICING_SETTINGS;
  const rows = records.map(record => planProductMigration(record, { settings, effectiveAt }));
  return { version: MIGRATION_VERSION, createdAt: new Date().toISOString(), settings, rows,
    summary: { products: rows.length, ready: rows.filter(row => row.action === "ready").length,
      held: rows.filter(row => row.action === "review").length,
      preservedSpecial: rows.filter(row => row.action === "preserve-special").length } };
}
