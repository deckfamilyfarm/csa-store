export function merchandiseProductSummary(product) {
  const available = product.variants.filter(variant => variant.canSell);
  const selling = available.filter(variant => variant.enabled && variant.sellingPriceCents != null);
  const reviewed = product.artworkReviewed && product.currency === 'USD';
  const listed = Boolean(product.active && reviewed && selling.length);
  const modified = available.filter(variant => variant.retailCents != null).length;
  const prices = (listed ? selling : available).map(variant => variant.sellingPriceCents).filter(price => price != null);
  const defaults = available.map(variant => variant.proposedRetailCents).filter(price => price != null);
  return {
    available: available.length, selling: selling.length, total: product.variants.length,
    modified, listed, reviewed,
    status: !available.length ? 'unavailable' : listed ? 'listed' : 'draft',
    allSelling: listed && selling.length === available.length,
    priceRange: prices.length ? [Math.min(...prices), Math.max(...prices)] : null,
    defaultRange: defaults.length ? [Math.min(...defaults), Math.max(...defaults)] : null,
    approvalIssue: !available.length ? 'No available supplier variants.'
      : available.some(variant => variant.sellingPriceCents == null) ? 'Review prices in Settings before selling all variants.' : ''
  };
}

export function merchandiseSaveInput(product, priceInputs = {}) {
  return {
    version: product.version, vendorId: product.vendorId, active: product.active && product.variants.some(variant => variant.canSell),
    artworkReviewed: product.artworkReviewed, currency: product.currency,
    variants: product.variants.map(variant => {
      let retailCents = variant.retailCents;
      if (Object.hasOwn(priceInputs, variant.id)) {
        const value = String(priceInputs[variant.id]).trim();
        if (value && !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter modified prices with at most two decimal places.');
        retailCents = value ? Math.round(Number(value) * 100) : null;
        if (retailCents != null && (!Number.isSafeInteger(retailCents) || retailCents < 50 || retailCents > 10000000)) {
          throw new Error('Modified prices must be between $0.50 and $100,000.00.');
        }
      }
      return { id: variant.id, enabled: Boolean(variant.enabled), retailCents };
    })
  };
}

export function merchandiseQuickApproval(product) {
  const summary = merchandiseProductSummary(product);
  if (summary.approvalIssue) throw new Error(summary.approvalIssue);
  return merchandiseSaveInput({
    ...product, active: true, artworkReviewed: true, currency: 'USD',
    variants: product.variants.map(variant => ({ ...variant, enabled: Boolean(variant.canSell) }))
  });
}
