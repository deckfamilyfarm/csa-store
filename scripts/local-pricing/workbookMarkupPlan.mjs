export const PRESET_BY_BP = Object.freeze({ 5000: 'shelfStable', 6500: 'perishable', 8500: 'deckHyland', 10000: 'highlyPerishable' });
const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const specialPricing = row => /deposit|membership/i.test(row.name || '') || /^membership$/i.test(row.category || '');

export function workbookMarkupPlan(workbook, catalog) {
  const byId = new Map(catalog.map(row => [Number(row.id), row]));
  const grouped = new Map();
  for (const row of workbook.rows) {
    if (!row['Product ID'] || row['New markup'] === '' || row['New markup'] == null) continue;
    const id = Number(row['Product ID']);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid product ID on row ${row.row}`);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return [...grouped].map(([id, sourceRows]) => {
    const local = byId.get(id), reasons = [], notes = [];
    const rates = sourceRows.map(row => Number(row['New markup']) * 10000);
    const bp = rates[0], target = PRESET_BY_BP[bp];
    if (!target || rates.some(rate => !Number.isSafeInteger(rate) || rate !== bp)) reasons.push('Unsupported or conflicting package markup percentages');
    if (!local || local.deleted) reasons.push('Product missing or deleted');
    else {
      if (specialPricing(local)) reasons.push('Fixed deposit or membership pricing');
      if (!local.vendor?.trim()) reasons.push('Missing vendor');
      else if (sourceRows.some(row => normalize(row.Vendor) !== normalize(local.vendor))) reasons.push('Vendor differs from workbook');
      if (sourceRows.some(row => normalize(row.Product) !== normalize(local.name))) {
        // Reviewed spelling correction: IDs, vendor, and package all match this record.
        if (id === 890649 && local.name === 'Chiogga Beets' && sourceRows.every(row => row.Product === 'Chioggia Beets')) notes.push('Matched existing Chiogga Beets spelling by product and package IDs');
        else reasons.push('Product name differs from workbook');
      }
      if (sourceRows.some(row => !local.packages.some(pkg => Number(pkg.id) === Number(row['Package ID'])))) reasons.push('Package does not belong to product');
    }
    return { id, name: local?.name || sourceRows[0].Product, vendor: local?.vendor || '', target, bp,
      sourceRows: sourceRows.map(row => row.row), packageIds: sourceRows.map(row => Number(row['Package ID'])), notes, reasons,
      status: reasons.length ? 'held' : 'matched' };
  });
}

export function matchingProducePresets(workbook, catalog) {
  const names = new Map(), explicitIds = new Set(workbook.rows.map(row => Number(row['Product ID'])));
  for (const row of workbook.rows) {
    if (!row.Product || !PRESET_BY_BP[Number(row['New markup']) * 10000]) continue;
    const key = normalize(row.Product);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(row);
  }
  return catalog.filter(row => !row.deleted && !explicitIds.has(Number(row.id)) && row.vendor?.trim()
    && !/deck family farm|hyland|creamy cow/i.test(row.vendor) && !specialPricing(row)
    && (!row.category || /organic.*(fruit|vegetable|mushroom)/i.test(row.category))).flatMap(row => {
    const matched = names.get(normalize(row.name)) || [];
    const rates = [...new Set(matched.map(source => Number(source['New markup']) * 10000))];
    if (rates.length !== 1) return [];
    return [{ id: Number(row.id), name: row.name, vendor: row.vendor, bp: rates[0], target: PRESET_BY_BP[rates[0]], sourceRows: matched.map(row => row.row),
      notes: ['Additional produce: same product name as workbook; apply its unambiguous preset across vendors'], reasons: [], status: 'matched', additionalMatch: true }];
  });
}
