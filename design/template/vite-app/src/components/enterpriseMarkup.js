export const markupCategories = {
  highlyPerishable: "Highly perishable",
  perishable: "Perishable",
  shelfStable: "Shelf stable",
  deckHyland: "DFF markup",
  creamyCow: "Creamy Cow Markup",
  custom: "Custom"
};

export const usesProductMarkup = vendor => /deck family farm|hyland|creamy cow/i.test(String(vendor || ""));
export const markupValue = (input, settings) => input.customMarkupBp ?? settings.markupBp?.[input.markupCategory] ?? null;
export function selectMarkupCategory(category, input, settings) {
  return { markupCategory: category, customMarkupBp: category === "custom" ? markupValue(input, settings) : null };
}
export const percentLabel = bp => bp == null ? "—" : `${Number((bp / 100).toFixed(2))}%`;

export function retailMarginPercent(row) {
  const price = row.input?.squareEnabled ? row.output?.squareUnitCents : row.output?.csaUnitCents;
  const cost = row.buyPrice?.cents ?? (row.output?.buyFromTenThousandths == null ? null : row.output.buyFromTenThousandths / 100);
  if (price == null || cost == null || !Number.isFinite(Number(price)) || !Number.isFinite(Number(cost)) || Number(price) <= 0) return null;
  return (Number(price) - Number(cost)) / Number(price) * 100;
}

export const isDepositPricing = row => row?.sourceEvidence?.pricingRule === "deposit-no-markup" || /deposit/i.test(row?.name || "");
export function depositBaseCents(row) {
  const amounts = (row.legacy?.packages || []).map(pkg => pkg.storedPrice == null ? null : Math.round(Number(pkg.storedPrice) * 100));
  return amounts.length && amounts.every(amount => amount !== null && Number.isFinite(amount) && amount === amounts[0]) ? amounts[0] : null;
}

export function productPricingUnit(row) {
  const unit = row.input?.pricingUnit || row.legacy?.pricingUnit || row.sourceEvidence?.unit;
  return unit === "lb" || unit === "lbs" ? "lb" : unit === "each" ? "each" : null;
}
