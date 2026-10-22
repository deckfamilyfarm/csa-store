import { averagePackageWeight, roundRatio, scaledInteger } from "./enterprisePricingEngine.js";

// Read-only evidence from the existing store database.
const numberOrNull = value => value === null || value === undefined || value === ""
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const cents = value => {
  const amount = numberOrNull(value);
  return amount === null ? null : Math.round(amount * 100);
};

const basketNames = ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"];

// The local sample migration uses the stored package price as its starting Buy
// Price. Weighted packages are converted to a per-pound amount; each packages
// are converted to a per-item amount. Missing units retain a package amount
// until a pricing unit is selected for a proposal.
export function deriveMigrationBuyPrice(record) {
  const profile = record?.profile || {};
  const unit = profile.pricingUnit === "lbs" ? "lb" : profile.pricingUnit === "each" ? "each" : null;
  const packages = record?.packages || [];
  if (!packages.length) return null;
  const amounts = packages.map(pkg => {
    try {
      const packageCents = scaledInteger(pkg.price, 2, "Stored package price");
      if (packageCents <= 0) return null;
      if (unit === "lb") {
        const positive = value => Number(value) > 0 ? value : null;
        const weight = averagePackageWeight({ avgWeightOverride: positive(profile.avgWeightOverride),
          minWeight: positive(profile.minWeight), maxWeight: positive(profile.maxWeight),
          cachedWeight: positive(pkg.cachedWeight) });
        return weight.milliPounds ? roundRatio(BigInt(packageCents) * 1000n, BigInt(weight.milliPounds)) : null;
      }
      const quantity = Number(pkg.numOfItems) || 1;
      return Number.isSafeInteger(quantity) && quantity > 0 ? roundRatio(packageCents, quantity) : null;
    } catch { return null; }
  });
  if (amounts.some(amount => amount === null) || new Set(amounts).size !== 1) return null;
  return { cents: amounts[0], unit, basis: unit || "package" };
}

export function deriveLegacyPricingEvidence(record, capturedAt = null) {
  if (!record) return null;
  const profile = record.profile || {};
  const vendor = record.product || {};
  const unit = profile.pricingUnit === "lbs" ? "lb" : profile.pricingUnit === "each" ? "each" : null;
  const vendorMarkup = numberOrNull(vendor.vendorPriceListMarkup);
  const markup = vendorMarkup !== null && vendorMarkup > 0 ? vendorMarkup
    : numberOrNull(profile.markupOverride) ?? numberOrNull(profile.guestMarkup)
      ?? numberOrNull(vendor.vendorGuestMarkup);
  const saleFlag = Boolean(Number(record.sale?.onSale));
  const profileSaleFlag = Boolean(Number(profile.onSale));
  const saleRate = numberOrNull(profile.saleDiscount) ?? numberOrNull(record.sale?.saleDiscount);
  const packageRows = (record.packages || []).map(pkg => {
    const listRows = (record.localLinePrices || []).filter(row => Number(row.packageId) === Number(pkg.id)
      && basketNames.includes(row.listName) && cents(row.finalPrice) !== null);
    const byList = Object.fromEntries(listRows.map(row => [row.listName, cents(row.finalPrice)]));
    const prices = Object.values(byList);
    const uniform = basketNames.every(name => Object.hasOwn(byList, name)) && new Set(prices).size === 1;
    const displayedPriceCents = prices.length && new Set(prices).size === 1 ? prices[0] : null;
    const average = numberOrNull(profile.avgWeightOverride) > 0 ? Number(profile.avgWeightOverride)
      : numberOrNull(profile.minWeight) > 0 && numberOrNull(profile.maxWeight) > 0
        ? (Number(profile.minWeight) + Number(profile.maxWeight)) / 2
        : numberOrNull(pkg.cachedWeight) > 0 ? Number(pkg.cachedWeight) : null;
    const factor = unit === "lb" ? average : unit === "each" ? Number(pkg.numOfItems) || 1 : null;
    return {
      name: pkg.name, storedSourcePriceCents: cents(pkg.price),
      basketPricesCents: byList, basketCount: Object.keys(byList).length,
      basketsUniform: uniform, displayedPriceCents,
      estimatedCsaUnitCents: displayedPriceCents !== null && factor > 0
        ? Math.round(displayedPriceCents / factor) : null,
      averageWeight: unit === "lb" ? average : null,
      crossedOutPriceCents: listRows.map(row => cents(row.crossedOutPrice)).find(value => value > 0) || null
    };
  });
  return {
    capturedAt,
    unit,
    sourceRetailUnitCents: cents(profile.sourceUnitPrice),
    markupPercent: markup === null ? null : Math.round(markup * 10000) / 100,
    packages: packageRows,
    square: (record.squarePrices || []).map(row => ({
      packageName: (record.packages || []).find(pkg => Number(pkg.id) === Number(row.packageId))?.name || null,
      priceCents: numberOrNull(row.priceCents), cachedAt: row.cachedAt
    })),
    sale: {
      activeInProduct: saleFlag,
      activeInProfile: profileSaleFlag,
      discountPercent: saleRate === null ? null : Math.round(saleRate * 10000) / 100,
      flagsConflict: Boolean(record.sale) && Boolean(record.profile) && saleFlag !== profileSaleFlag
    },
    sourceSyncStatus: profile.remoteSyncStatus || null
  };
}
