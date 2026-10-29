import { remoteEntryCents } from './catalogReconciliationPlan.mjs';
import { roundRatio, scaledInteger } from '../../apps/api/lib/enterprisePricingEngine.js';

export const discountPrice = (cents, percent) => roundRatio(BigInt(cents) * BigInt(100 - percent), 100n);
export function inspectSale(pkg, listIds) {
  const baskets = listIds.map(listId => {
    const matches = (pkg.price_list_entries || []).filter(e => Number(e.price_list_id ?? e.price_list) === listId);
    if (matches.length !== 1) return { listId, missing: true };
    const entry = matches[0];
    return { listId, priceCents: remoteEntryCents(pkg, entry), sale: Boolean(entry.on_sale || entry.on_sale_toggle),
      crossedOutCents: entry.strikethrough_display_value == null ? null : scaledInteger(entry.strikethrough_display_value, 2) };
  });
  const first = baskets[0];
  const consistent = baskets.length === 4 && new Set(listIds).size === 4 && baskets.every(b => !b.missing && Number.isSafeInteger(b.priceCents) && b.priceCents === first.priceCents && b.sale === first.sale && b.crossedOutCents === first.crossedOutCents);
  if (!consistent) return { baskets, discountPercent: null, issue: 'Basket prices or sale displays differ; choose the intended sale explicitly.' };
  if (!first.sale) return { baskets, discountPercent: null, issue: 'No current channel sale; do not carry the old local flag forward.' };
  if (!(first.crossedOutCents > first.priceCents)) return { baskets, discountPercent: null, issue: 'Crossed-out price is not greater than the selling price.' };
  const candidates = Array.from({ length: 99 }, (_, i) => i + 1).filter(p => Math.abs(discountPrice(first.crossedOutCents, p) - first.priceCents) <= 1);
  return candidates.length === 1 ? { baskets, discountPercent: candidates[0], issue: null }
    : { baskets, discountPercent: null, issue: 'A unique whole-percent discount cannot be inferred.' };
}

export function buildPricingSalesReview(local, channels) {
  const t = local.tables;
  const remotePackage = id => {
    const mappings = t.local_line_package_meta.filter(m => Number(m.package_id) === Number(id));
    if (mappings.length !== 1) return null;
    const mapping = mappings[0], products = t.local_line_product_meta.filter(m => Number(m.product_id) === Number(mapping.product_id));
    if (products.length !== 1) return null;
    return channels.products.find(p => Number(p.id) === Number(products[0].local_line_product_id))?.packages?.find(p => Number(p.id) === Number(mapping.local_line_package_id));
  };
  const catalog = t.packages.map(pkg => {
    const revision = t.enterprise_pricing_revisions.find(r => r.product_id === pkg.product_id);
    const output = revision ? JSON.parse(revision.output_json) : null;
    const price = output?.packages?.find(p => Number(p.packageId) === pkg.id);
    const remote = remotePackage(pkg.id);
    return { packageId: pkg.id, productId: pkg.product_id, name: t.products.find(p => p.id === pkg.product_id)?.name,
      packageName: pkg.name, regularCents: price?.localLineRegularCents ?? null,
      squareCents: price?.squareVariationCents ?? null, pricingUnit: output?.pricingUnit,
      remote, sale: remote ? inspectSale(remote, channels.basketIds) : null };
  });
  const variations = channels.square.flatMap(o => o.type === 'ITEM' ? o.item_data?.variations || [] : o.type === 'ITEM_VARIATION' ? [o] : []);
  const sales = catalog.filter(c => channels.saleProductIds.includes(c.productId)).map(c => {
    const links = t.square_variation_links.filter(l => l.package_id === c.packageId && l.approved_at);
    const variation = links.length === 1 ? variations.find(v => v.id === links[0].square_variation_id) : null;
    const data = variation?.item_variation_data;
    const remoteProduct = channels.products.find(p => p.packages?.some(k => Number(k.id) === Number(c.remote?.id)));
    return { ...c, visible: Boolean(remoteProduct?.visible), remoteProductId: remoteProduct?.id ?? null, remote: undefined, proposedSaleCents: c.regularCents == null || c.sale?.discountPercent == null ? null : discountPrice(c.regularCents, c.sale.discountPercent),
      squareCatalogCents: data?.price_money?.currency === 'USD' ? Number(data.price_money.amount) : null,
      squareLocationOverrides: data?.location_overrides || [],
      squareNote: 'Catalog base price only; checkout discounts, selling units and location overrides require separate verification.' };
  });
  const bundles = t.enterprise_bundles.map(b => {
    const input = JSON.parse(b.input_json), remote = channels.boxes.find(box => Number(box.id) === Number(b.remote_box_id));
    const components = input.components.map(component => {
      const c = catalog.find(p => p.packageId === component.packageId);
      const percent = c?.sale?.discountPercent;
      return { ...component, name: c?.name, regularCents: c?.regularCents ?? null, baskets: c?.sale?.baskets || [],
        salePercent: percent ?? null, retainedSaleCents: c?.regularCents == null ? null : percent == null ? c.regularCents : discountPrice(c.regularCents, percent),
        unresolvedSale: Boolean(c?.sale?.issue && c.sale.baskets.some(b => b.sale)) };
    });
    const price = key => components.some(c => !Number.isSafeInteger(c[key])) ? null :
      roundRatio(BigInt(components.reduce((sum, c) => sum + c[key] * c.quantity, 0)) * BigInt(10000 - scaledInteger(input.discountPercent, 2)), 10000n);
    return { id: b.id, remoteBoxId: b.remote_box_id, name: input.name, visible: input.visible, buyPrice: input.buyPrice, discountPercent: input.discountPercent,
      regularScenarioCents: price('regularCents'), retainedSalesScenarioCents: components.some(c => c.unresolvedSale) ? null : price('retainedSaleCents'), components,
      remoteBaskets: (remote?.product_price_list_entries || []).map(row => ({ listId: Number(row.price_list), priceCents: remoteEntryCents({ unit_price: remote.price }, row.box_package_entry) })) };
  });
  return { capturedAt: channels.capturedAt, localCapturedAt: local.capturedAt, database: local.database,
    decision: 'Review only: sale percentages are inferred, not approved. No dates, promotions or publications have been created.', sales, bundles,
    unmappedRemoteSales: channels.products.filter(p => p.packages?.some(k => k.price_list_entries?.some(e => e.on_sale || e.on_sale_toggle)) &&
      !t.local_line_product_meta.some(m => Number(m.local_line_product_id) === Number(p.id))).map(p => ({id:p.id,name:p.name,visible:p.visible})) };
}
