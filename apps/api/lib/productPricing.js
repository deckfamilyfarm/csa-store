function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function parsePriceListId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeVendorName(value) {
  return String(value || "").trim().toLowerCase();
}

export function isSourcePricingVendor(vendor = null) {
  const normalized = normalizeVendorName(vendor?.name);
  return normalized.includes("deck family farm") || normalized.includes("hyland");
}

function normalizeUnitOfMeasure(value, fallback = "each") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "lbs" || normalized === "lb" || normalized === "pounds") {
    return "lbs";
  }
  if (normalized === "each" || normalized === "ea") {
    return "each";
  }
  return fallback;
}

function isVisiblePackage(pkg) {
  return pkg?.visible === null || typeof pkg?.visible === "undefined" || Boolean(pkg.visible);
}

function getDefaultSourceMultiplier() {
  const configured = toNumber(process.env.PRICELIST_SOURCE_MULTIPLIER);
  return configured === null ? 0.5412 : configured;
}

function getVisiblePackages(packages = []) {
  const visiblePackages = packages.filter(isVisiblePackage);
  return visiblePackages.length ? visiblePackages : packages;
}

function inferUnitOfMeasure(packages = [], packageMetaByPackageId = new Map()) {
  const visiblePackages = getVisiblePackages(packages);
  const hasWeight = visiblePackages.some((pkg) => {
    const weight = toNumber(packageMetaByPackageId.get(pkg.id)?.avgPackageWeight);
    if (weight !== null && weight > 0) return true;
    return /lb|pound/i.test(String(pkg?.unit || ""));
  });
  return hasWeight ? "lbs" : "each";
}

function inferAverageWeight(packages = [], packageMetaByPackageId = new Map()) {
  const visiblePackages = getVisiblePackages(packages);
  for (const pkg of visiblePackages) {
    const weight = toNumber(packageMetaByPackageId.get(pkg.id)?.avgPackageWeight);
    if (weight !== null && weight > 0) {
      return Number(weight.toFixed(3));
    }
  }
  return null;
}

function inferBasePackage(packages = []) {
  return getVisiblePackages(packages)
    .map((pkg) => ({ pkg, price: toNumber(pkg?.price) }))
    .filter((entry) => entry.price !== null)
    .sort((left, right) => left.price - right.price)[0] || null;
}

function getPackageQuantity(pkg, packageMeta) {
  const quantity = toNumber(packageMeta?.numOfItems ?? pkg?.numOfItems);
  if (quantity === null || quantity <= 0) return 1;
  return quantity;
}

export function computeAverageWeight(profile, packageMeta = null) {
  const overrideWeight = toNumber(profile?.avgWeightOverride);
  if (overrideWeight !== null && overrideWeight > 0) return Number(overrideWeight.toFixed(3));

  const packageWeight = toNumber(packageMeta?.avgPackageWeight);
  if (packageWeight !== null && packageWeight > 0) return Number(packageWeight.toFixed(3));

  const minWeight = toNumber(profile?.minWeight);
  const maxWeight = toNumber(profile?.maxWeight);
  if (minWeight !== null && maxWeight !== null) {
    return Number((((minWeight + maxWeight) / 2)).toFixed(3));
  }
  if (minWeight !== null) return Number(minWeight.toFixed(3));
  if (maxWeight !== null) return Number(maxWeight.toFixed(3));
  return null;
}

export function resolvePricingProfile({
  profile = null,
  product = null,
  packages = [],
  packageMetaByPackageId = new Map(),
  vendor = null
}) {
  const defaultGuestMarkup = toNumber(vendor?.guestMarkup);
  const defaultMemberMarkup = toNumber(vendor?.memberMarkup);
  const sourceMultiplier =
    toNumber(profile?.sourceMultiplier) ?? getDefaultSourceMultiplier();
  const unitOfMeasure = normalizeUnitOfMeasure(
    profile?.unitOfMeasure,
    inferUnitOfMeasure(packages, packageMetaByPackageId)
  );

  let sourceUnitPrice = toNumber(profile?.sourceUnitPrice);
  const avgWeightOverride = toNumber(profile?.avgWeightOverride);
  let minWeight = toNumber(profile?.minWeight);
  let maxWeight = toNumber(profile?.maxWeight);

  if (minWeight === null && maxWeight === null && avgWeightOverride === null && unitOfMeasure === "lbs") {
    const inferredAverageWeight = inferAverageWeight(packages, packageMetaByPackageId);
    if (inferredAverageWeight !== null) {
      minWeight = inferredAverageWeight;
      maxWeight = inferredAverageWeight;
    }
  }

  if (sourceUnitPrice === null) {
    const basePackage = inferBasePackage(packages);
    if (basePackage && sourceMultiplier > 0) {
      if (unitOfMeasure === "lbs") {
        const averageWeight = computeAverageWeight(
          { avgWeightOverride, minWeight, maxWeight },
          packageMetaByPackageId.get(basePackage.pkg.id)
        );
        if (averageWeight !== null && averageWeight > 0) {
          sourceUnitPrice = roundCurrency(basePackage.price / (averageWeight * sourceMultiplier));
        }
      } else {
        const quantity = getPackageQuantity(
          basePackage.pkg,
          packageMetaByPackageId.get(basePackage.pkg.id)
        );
        sourceUnitPrice = roundCurrency(basePackage.price / (Math.max(quantity, 1) * sourceMultiplier));
      }
    }
  }

  const memberMarkup = toNumber(profile?.memberMarkup) ?? defaultMemberMarkup ?? 0.4;
  const guestMarkup = toNumber(profile?.guestMarkup) ?? defaultGuestMarkup ?? 0.55;

  return {
    productId: Number(product?.id ?? profile?.productId),
    usesSourcePricing: isSourcePricingVendor(vendor),
    unitOfMeasure,
    sourceUnitPrice,
    minWeight,
    maxWeight,
    avgWeightOverride,
    sourceMultiplier,
    guestMarkup,
    memberMarkup,
    herdShareMarkup: toNumber(profile?.herdShareMarkup) ?? memberMarkup,
    snapMarkup: toNumber(profile?.snapMarkup) ?? memberMarkup,
    onSale:
      typeof profile?.onSale === "boolean"
        ? profile.onSale
        : Boolean(profile?.onSale),
    saleDiscount: Math.max(0, Math.min(toNumber(profile?.saleDiscount) ?? 0, 1)),
    remoteSyncStatus: profile?.remoteSyncStatus || "pending",
    remoteSyncMessage: profile?.remoteSyncMessage || "",
    remoteSyncedAt: profile?.remoteSyncedAt || null,
    createdAt: profile?.createdAt || null,
    updatedAt: profile?.updatedAt || null
  };
}

export function computePackageBasePrice(profile, pkg, packageMeta = null) {
  const sourceUnitPrice = toNumber(profile?.sourceUnitPrice);
  const sourceMultiplier = toNumber(profile?.sourceMultiplier);
  if (sourceUnitPrice === null || sourceMultiplier === null) return null;

  if (profile?.unitOfMeasure === "lbs") {
    const averageWeight = computeAverageWeight(profile, packageMeta);
    if (averageWeight === null || averageWeight <= 0) return null;
    return roundCurrency(sourceUnitPrice * averageWeight * sourceMultiplier);
  }

  const quantity = getPackageQuantity(pkg, packageMeta);
  return roundCurrency(sourceUnitPrice * quantity * sourceMultiplier);
}

export function computeFinalPrice(basePrice, markup, onSale, saleDiscount) {
  const safeBasePrice = toNumber(basePrice);
  const safeMarkup = toNumber(markup);
  if (safeBasePrice === null || safeMarkup === null) {
    return { regular: null, final: null, strikethrough: null };
  }

  const regular = roundCurrency(safeBasePrice * (1 + safeMarkup));
  if (!onSale || !Number.isFinite(Number(saleDiscount)) || Number(saleDiscount) <= 0) {
    return { regular, final: regular, strikethrough: null };
  }

  return {
    regular,
    final: roundCurrency(regular * (1 - Number(saleDiscount))),
    strikethrough: regular
  };
}

export function getPriceListDefinitions(profile) {
  return [
    {
      key: "guest",
      name: "Guest Basket",
      id: parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID),
      markup: profile.guestMarkup
    },
    {
      key: "member",
      name: "CSA Members",
      id: parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
      markup: profile.memberMarkup
    },
    {
      key: "herdShare",
      name: "Herd Share Members",
      id: parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID),
      markup: profile.herdShareMarkup
    },
    {
      key: "snap",
      name: "SNAP",
      id: parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID),
      markup: profile.snapMarkup
    }
  ].filter((entry) => entry.id !== null && entry.markup !== null);
}

export function computeProductPricingSnapshot({
  product = null,
  packages = [],
  packageMetaByPackageId = new Map(),
  vendor = null,
  profile = null
}) {
  const resolvedProfile = resolvePricingProfile({
    profile,
    product,
    packages,
    packageMetaByPackageId,
    vendor
  });

  const packageRows = getVisiblePackages(packages).map((pkg) => {
    const packageMeta = packageMetaByPackageId.get(pkg.id) || null;
    const basePrice = computePackageBasePrice(resolvedProfile, pkg, packageMeta);
    return {
      id: pkg.id,
      name: pkg.name || "",
      quantity: getPackageQuantity(pkg, packageMeta),
      averageWeight: computeAverageWeight(resolvedProfile, packageMeta),
      basePrice
    };
  });

  const basePrices = packageRows
    .map((row) => row.basePrice)
    .filter((value) => value !== null);
  const basePrice = basePrices.length ? Math.min(...basePrices) : null;
  const guest = computeFinalPrice(
    basePrice,
    resolvedProfile.guestMarkup,
    resolvedProfile.onSale,
    resolvedProfile.saleDiscount
  );
  const member = computeFinalPrice(
    basePrice,
    resolvedProfile.memberMarkup,
    resolvedProfile.onSale,
    resolvedProfile.saleDiscount
  );
  const herdShare = computeFinalPrice(
    basePrice,
    resolvedProfile.herdShareMarkup,
    resolvedProfile.onSale,
    resolvedProfile.saleDiscount
  );
  const snap = computeFinalPrice(
    basePrice,
    resolvedProfile.snapMarkup,
    resolvedProfile.onSale,
    resolvedProfile.saleDiscount
  );

  return {
    profile: resolvedProfile,
    packageRows,
    basePrice,
    guestPrice: guest.final,
    memberPrice: member.final,
    herdSharePrice: herdShare.final,
    snapPrice: snap.final,
    guestRegularPrice: guest.regular,
    memberRegularPrice: member.regular,
    herdShareRegularPrice: herdShare.regular,
    snapRegularPrice: snap.regular
  };
}
