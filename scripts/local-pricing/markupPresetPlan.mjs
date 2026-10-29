// Explicit local repricing request. Deck/Hyland takes priority over the 43–48% band.
export const REQUESTED_MARKUPS = Object.freeze({ deckHyland: 8500, shelfStable: 5000, perishable: 6500 });
export function markupPresetAssignment(row) {
  if (/deposit|membership/i.test(row.name || "") || /^membership$/i.test(row.categoryName || "")) return null;
  if (/deck family farm|hyland/i.test(row.vendorName || "")) return "deckHyland";
  const bp = row.output?.appliedMarkupBp ?? row.input?.customMarkupBp ?? row.sourceMarkupBp;
  if (bp != null && Number(bp) >= 4300 && Number(bp) <= 4800) return "shelfStable";
  if (row.input?.customMarkupBp == null && ["perishable", "shelfStable", "deckHyland"].includes(row.input?.markupCategory)) return row.input.markupCategory;
  return null;
}
