// Explicitly reviewed local pricing, separate from the refreshable Local Line cache.
// IDs are local package IDs and configured Local Line customer-list IDs.
const invalid = message => Object.assign(new Error(message), { status: 400 });
const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean' ? NaN : Number(value);
const money = value => Number(Number(value).toFixed(2));

export function normalizeCustomerPriceOverrides(value) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw invalid('Invalid customer price settings.'); }
  }
  if (!Array.isArray(value) || value.length > 1000) throw invalid('Customer price settings must be a list.');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object') throw invalid('Invalid customer price row.');
    const packageId = number(row.packageId), priceListId = number(row.priceListId);
    const adjustmentType = number(row.adjustmentType), adjustmentValue = number(row.adjustmentValue);
    const strikethrough = row.strikethrough == null || row.strikethrough === '' ? null : number(row.strikethrough);
    if (![packageId, priceListId].every(n => Number.isSafeInteger(n) && n > 0)) throw invalid('Select a package and customer group.');
    const key = `${packageId}:${priceListId}`;
    if (seen.has(key)) throw invalid('Each package can have only one setting per customer group.');
    seen.add(key);
    if (typeof row.adjustment !== 'boolean' || typeof row.onSale !== 'boolean' || ![1,2,3].includes(adjustmentType) || !Number.isFinite(adjustmentValue) || Math.abs(adjustmentValue) > 999999.99) throw invalid('Enter a valid customer price adjustment.');
    if (row.adjustment && (adjustmentType === 2 && adjustmentValue < -100 || adjustmentType === 3 && adjustmentValue < 0)) throw invalid('Customer prices must be nonnegative.');
    if (strikethrough !== null && (!Number.isFinite(strikethrough) || strikethrough < 0 || strikethrough > 99999999.99)) throw invalid('Crossed-out prices must be nonnegative.');
    // Preserve unusual but valid remote displays, including a crossed-out price below the selling price.
    return { packageId, priceListId, adjustment: row.adjustment, adjustmentType, adjustmentValue: money(adjustmentValue), onSale: row.onSale, strikethrough: strikethrough === null ? null : money(strikethrough) };
  }).sort((a,b) => a.packageId - b.packageId || a.priceListId - b.priceListId);
}

export function customerOverridePrice(basePrice, row) {
  const base = number(basePrice);
  if (!Number.isFinite(base) || base < 0) throw invalid('Customer pricing requires a nonnegative package price.');
  const final = money(!row.adjustment ? base : row.adjustmentType === 1 ? base + row.adjustmentValue : row.adjustmentType === 2 ? base * (1 + row.adjustmentValue / 100) : row.adjustmentValue);
  if (final < 0) throw invalid('Customer price adjustments cannot produce a negative price.');
  return { final, regular: row.strikethrough ?? final, strikethrough: row.strikethrough, onSale: row.onSale, overridden: true };
}

export function findCustomerPriceOverride(profile, packageId, priceListId) {
  return profile?.customerPriceOverrides?.find(row => row.packageId === Number(packageId) && row.priceListId === Number(priceListId)) || null;
}

export function assertProductWideSaleAllowed(profile, changes) {
  if (!Object.hasOwn(changes, 'onSale') && !Object.hasOwn(changes, 'saleDiscount')) return;
  if (normalizeCustomerPriceOverrides(profile?.customerPriceOverrides ?? profile?.customerPriceOverridesJson).length) {
    throw invalid('This product uses customer-group sale settings. Edit them in Details, or remove them before changing the product-wide sale.');
  }
}
