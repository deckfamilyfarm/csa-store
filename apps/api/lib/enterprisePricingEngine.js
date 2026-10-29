// Money and percentages are represented as integers throughout this module.
// Costs use ten-thousandths of a dollar; customer-facing prices use cents.
export const DEFAULT_PRICING_SETTINGS = Object.freeze({
  localLineDiscountBp: 1000,
  squareIncrementCents: 50,
  markupBp: Object.freeze({ highlyPerishable: 10000, perishable: 6500, shelfStable: 5000, deckHyland: 8500 }),
  squareDefaults: Object.freeze({ deck: true, hyland: true, creamyCow: false, other: false }),
  requireDifferentApprover: true
});

function fail(message) { throw new Error(message); }

export function scaledInteger(value, scale, name = "value") {
  const raw = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[2]?.length || 0) > scale) fail(`${name} must be a nonnegative number with at most ${scale} decimal places.`);
  const integer = BigInt(match[1]) * 10n ** BigInt(scale) + BigInt((match[2] || "").padEnd(scale, "0") || "0");
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${name} is too large.`);
  return Number(integer);
}

export function roundRatio(numerator, denominator) {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  if (top < 0n || bottom <= 0n) fail("Pricing amounts must be nonnegative.");
  return Number((top * 2n + bottom) / (bottom * 2n));
}

function whole(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(`${name} is invalid.`);
  return number;
}

export function averagePackageWeight(packageDefinition = {}) {
  const read = (value, label) => value === null || value === undefined || value === "" ? null : scaledInteger(value, 3, label);
  const override = read(packageDefinition.avgWeightOverride, "Average weight override");
  const min = read(packageDefinition.minWeight, "Minimum weight");
  const max = read(packageDefinition.maxWeight, "Maximum weight");
  const cached = read(packageDefinition.cachedWeight, "Cached package weight");
  if ([override, min, max, cached].some(value => value !== null && value <= 0)) fail("Package weights must be greater than zero when provided.");
  if (min !== null && max !== null && max < min) fail("Maximum weight must be at least minimum weight.");
  if (override > 0) return { milliPounds: override, source: "override" };
  if (min !== null && max !== null) return { milliPounds: roundRatio(min + max, 2), source: "midpoint" };
  if (cached > 0) return { milliPounds: cached, source: "cached" };
  if (min > 0) return { milliPounds: min, source: "minimum-only" };
  if (max > 0) return { milliPounds: max, source: "maximum-only" };
  return { milliPounds: null, source: "missing" };
}

function percent(value, label) { return whole(value, label, 0, 100000); }

export function calculateEnterprisePricing(input, settings = DEFAULT_PRICING_SETTINGS) {
  const unit = input.pricingUnit;
  if (!["lb", "each"].includes(unit)) fail("Pricing unit must be lb or each.");
  const cost = scaledInteger(input.buyFromPrice, 4, "Buy Price");
  if (!cost) fail("Buy Price must be greater than zero.");
  const defaults = settings.markupBp || {};
  const category = input.markupCategory;
  if (!["highlyPerishable", "perishable", "shelfStable", "deckHyland", "custom"].includes(category)) fail("Choose a markup category.");
  const markupBp = input.customMarkupBp === null || input.customMarkupBp === undefined || input.customMarkupBp === ""
    ? defaults[category] : input.customMarkupBp;
  if (markupBp === undefined || markupBp === null) fail("This markup category needs a custom percentage.");
  const appliedMarkupBp = percent(markupBp, "Markup");
  const discountBp = percent(settings.localLineDiscountBp, "Local Line discount");
  if (discountBp > 10000) fail("Local Line discount cannot exceed 100%.");
  const increment = whole(settings.squareIncrementCents, "Square rounding increment", 1, 10000);
  const calculatedCents = roundRatio(BigInt(cost) * BigInt(10000 + appliedMarkupBp), 1000000n);
  const squareEnabled = input.squareEnabled === true;
  let squareUnitCents = null;
  let csaUnitCents;
  if (squareEnabled) {
    const rounded = roundRatio(BigInt(cost) * BigInt(10000 + appliedMarkupBp), BigInt(increment) * 1000000n) * increment;
    squareUnitCents = input.squareOverride === null || input.squareOverride === undefined || input.squareOverride === ""
      ? rounded : scaledInteger(input.squareOverride, 2, "Square override");
    if (squareUnitCents % increment !== 0) fail(`Square override must be a multiple of $${(increment / 100).toFixed(2)}.`);
    csaUnitCents = roundRatio(BigInt(squareUnitCents) * BigInt(10000 - discountBp), 10000n);
    if (input.csaOverride !== null && input.csaOverride !== undefined && input.csaOverride !== "") fail("CSA override applies only to products not sold in Square.");
  } else {
    if (input.squareOverride !== null && input.squareOverride !== undefined && input.squareOverride !== "") fail("Square override requires Square eligibility.");
    csaUnitCents = input.csaOverride === null || input.csaOverride === undefined || input.csaOverride === ""
      ? calculatedCents : scaledInteger(input.csaOverride, 2, "CSA override");
  }
  const saleBp = input.saleBp === null || input.saleBp === undefined || input.saleBp === "" ? 0 : percent(input.saleBp, "Sale");
  if (saleBp >= 10000) fail("Sale must be less than 100%.");
  const packages = (input.packages || []).map(pkg => {
    const packageId = whole(pkg.packageId, "Package ID", 1);
    const weight = unit === "lb" ? averagePackageWeight(pkg) : null;
    const quantity = unit === "each" ? whole(pkg.quantity ?? 1, "Package quantity", 1, 100000) : null;
    const factor = unit === "lb" ? weight.milliPounds : quantity;
    const divisor = unit === "lb" ? 1000 : 1;
    const localLineRegularCents = factor === null ? null : roundRatio(BigInt(csaUnitCents) * BigInt(factor), BigInt(divisor));
    const localLineSaleCents = localLineRegularCents === null ? null : roundRatio(BigInt(localLineRegularCents) * BigInt(10000 - saleBp), 10000n);
    const squareVariationCents = squareEnabled
      ? unit === "lb" ? squareUnitCents : roundRatio(BigInt(squareUnitCents) * BigInt(quantity), BigInt(increment)) * increment
      : null;
    return {
      packageId, quantity, averageWeightMilliPounds: weight?.milliPounds ?? null,
      weightSource: weight?.source ?? null, squareVariationCents,
      localLineRegularCents, localLineSaleCents,
      localLineBasketCents: Object.fromEntries(["guest", "member", "herdShare", "snap"].map(key => [key, localLineSaleCents]))
    };
  });
  const retailCents = squareEnabled ? squareUnitCents : csaUnitCents;
  const effectiveMarkupBp = roundRatio(BigInt(retailCents) * 1000000n, BigInt(cost)) - 10000;
  return {
    pricingUnit: unit, buyFromTenThousandths: cost, appliedMarkupBp,
    calculatedRetailCents: calculatedCents, squareUnitCents, csaUnitCents,
    effectiveMarkupBp, saleBp, packages,
    squareOverrideActive: input.squareOverride !== null && input.squareOverride !== undefined && input.squareOverride !== "",
    csaOverrideActive: input.csaOverride !== null && input.csaOverride !== undefined && input.csaOverride !== ""
  };
}
