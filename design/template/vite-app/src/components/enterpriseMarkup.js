export const markupCategories = {
  highlyPerishable: "Highly perishable",
  perishable: "Perishable",
  shelfStable: "Shelf stable",
  custom: "Custom"
};

export const usesProductMarkup = vendor => /deck family farm|hyland|creamy cow/i.test(String(vendor || ""));
export const markupValue = (input, settings) => input.customMarkupBp ?? settings.markupBp?.[input.markupCategory] ?? null;
export function selectMarkupCategory(category, input, settings) {
  return { markupCategory: category, customMarkupBp: category === "custom" ? markupValue(input, settings) : null };
}
export const percentLabel = bp => bp == null ? "—" : `${Number((bp / 100).toFixed(2))}%`;
