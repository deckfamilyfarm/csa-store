// New local products must choose a selling basis rather than inheriting a guess.
export function requireProductPricingUnit(payload, usesSourcePricing) {
  const unit = payload?.pricingProfile?.unitOfMeasure ?? payload?.unitOfMeasure;
  if (!['each', 'lbs'].includes(unit)) {
    throw Object.assign(new Error('Pricing unit is required. Choose Each (one package/bag) or Pounds before creating the product.'), { status: 400 });
  }
  if (!usesSourcePricing && unit !== 'each') {
    throw Object.assign(new Error('Standard products use the package price. Choose Each (one package/bag).'), { status: 400 });
  }
  return unit;
}
