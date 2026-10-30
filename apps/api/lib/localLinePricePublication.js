import { readProductSales, salePrice } from './enterpriseProductSales.js';
import { activeLocalLinePriceListIds } from './localLinePricingLists.js';
import { localLineSalePatch } from './enterprisePromotionsCore.js';

export const LOCAL_LINE_PRICE_SCOPE = 'localline-prices-and-sales';
export function validateLocalLinePriceScope(options) {
  if (!options.publicationScope) return false;
  if (options.publicationScope !== LOCAL_LINE_PRICE_SCOPE || options.platforms?.length !== 1 || options.platforms[0] !== 'localline'
    || !options.enterpriseRevisionId || options.incoming || Object.keys(options.staged || {}).length) {
    throw new Error('Price-only publication requires one approved enterprise revision and Local Line only.');
  }
  return true;
}
// Freeze the desired sale independently of the regular pricing revision. Never
// approve a Square promotion as a side effect of publishing Local Line prices.
export async function localLineSaleSnapshot(db, productId, packages) {
  const state = (await readProductSales(db, [productId])).get(Number(productId));
  const [rows] = await db.query("SELECT id,status,input_json FROM enterprise_promotions WHERE status IN ('pending','approved','scheduled','active','partial','cancelling')");
  const ids = new Set(packages.map(p => Number(p.packageId ?? p.id)));
  const related = rows.map(r => ({ ...r, input: typeof r.input_json === 'string' ? JSON.parse(r.input_json) : r.input_json }))
    .filter(r => r.input.packageIds.some(id => ids.has(Number(id))));
  if (related.some(r => r.status !== 'pending' || Number(r.id) !== Number(state?.promotion_id)
    || r.input.endAt || Date.parse(r.input.startAt) > Date.now() || r.input.supersedes?.length
    || r.input.packageIds.length !== ids.size || !r.input.packageIds.every(id => ids.has(Number(id))))) {
    throw new Error('This product has a scheduled, overlapping, or previously published promotion. Review its sale separately.');
  }
  const promotion = related.find(r => Number(r.id) === Number(state?.promotion_id));
  const bp = promotion && !promotion.input.channels.includes('localline') ? 0 : Number(state?.discount_bp || 0);
  if (!Number.isSafeInteger(bp) || bp < 0 || bp >= 10000) throw new Error('The saved sale percentage needs review.');
  return { revision: Number(state?.revision || 0), discountBp: bp, promotionId: Number(state?.promotion_id) || null,
    promotionInput: promotion?.input || null };
}
export function priceOnlyLocalLinePayload(regularPayload, remote, sale, listIds = activeLocalLinePriceListIds()) {
  // Reuse the sale builder for regular and discounted prices. It preserves live
  // list limits. Names are taken from the channel; no catalog/inventory edits.
  const selected = regularPayload.packages.map(p => {
    const regularCents = Math.round(Number(p.unit_price) * 100);
    return { localLinePackageId: Number(p.id), regularCents, saleCents: salePrice(regularCents, sale.discountBp) };
  });
  if (remote.packages.length !== selected.length || remote.packages.some(p => !selected.some(s => s.localLinePackageId === Number(p.id)))) {
    throw new Error('Local Line package definitions differ. Review package mappings before publishing prices.');
  }
  const payload = localLineSalePatch(remote, selected, listIds, sale.discountBp > 0);
  payload.vendor = regularPayload.vendor; // Existing verified vendor guard.
  return payload;
}
