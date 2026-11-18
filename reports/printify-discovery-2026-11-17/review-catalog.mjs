// Offline review of the captured API data; no credentials or network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
process.umask(0o077);
const root = path.dirname(new URL(import.meta.url).pathname);
const inventory = JSON.parse(await fs.readFile(path.join(root, 'catalog-inventory.json'), 'utf8'));
const snapshot = JSON.parse(await fs.readFile(path.join(root, inventory.rawSnapshotDirectory, 'complete-catalog.json'), 'utf8'));
const { mappings } = JSON.parse(await fs.readFile(path.join(root, 'variant-migration-mapping.json'), 'utf8'));
assert.equal(inventory.productCount, snapshot.products.length);
assert.equal(inventory.variantCount, mappings.length);
assert.equal(new Set(mappings.map(v => `${v.sourceShopId}/${v.sourceProductId}/${v.sourceVariantId}`)).size, mappings.length);
const missingArtwork = new Set(snapshot.artworks.filter(a => !a.upload).map(a => a.id));
const holds = [];
const comparisons = [];
const csvRows = [];
for (const { shopId, product: p } of snapshot.products) {
  const pair = snapshot.catalogPairs[`${p.blueprint_id}/${p.print_provider_id}`];
  const catalogIds = pair.variants ? new Set(pair.variants.variants.map(v => v.id)) : null;
  const enabled = p.variants.filter(v => v.is_enabled);
  const missingEnabled = catalogIds ? enabled.filter(v => !catalogIds.has(v.id)) : [];
  const belowCost = enabled.filter(v => Number.isInteger(v.price) && Number.isInteger(v.cost) && v.price < v.cost);
  const unresolved = p.print_areas.flatMap(area => area.placeholders.flatMap(holder => holder.images.filter(image => missingArtwork.has(image.id)).map(image => ({
    artworkId: image.id, layerName: image.name, type: image.type, position: holder.position,
    enabledVariantIds: enabled.filter(v => area.variant_ids.includes(v.id)).map(v => v.id)
  }))));
  const reasons = [];
  if (!enabled.length) reasons.push('no_enabled_variants');
  if (!catalogIds || !pair.shipping) reasons.push('supplier_catalog_or_shipping_unavailable');
  if (missingEnabled.length) reasons.push('enabled_variant_missing_from_supplier_catalog');
  if (unresolved.length) reasons.push('non_media_or_unresolved_artwork_reference_requires_copy_review');
  if (belowCost.length) reasons.push('saved_retail_below_reported_production_cost');
  if (enabled.some(v => v.is_available !== true)) reasons.push('enabled_availability_requires_review');
  if (!p.visible) reasons.push('source_product_hidden_preserve_until_review');
  if (reasons.length) holds.push({ productId: p.id, title: p.title, reasons, belowCostVariantIds: belowCost.map(v => v.id), unresolvedLayers: unresolved });
  comparisons.push({ productId: p.id, title: p.title, enabledVariants: enabled.length,
    enabledAvailableVariants: enabled.filter(v => v.is_available === true).length,
    enabledMissingFromCatalog: catalogIds ? missingEnabled.length : null,
    disabledMissingFromCatalog: catalogIds ? p.variants.filter(v => !v.is_enabled && !catalogIds.has(v.id)).length : null,
    belowReportedCostVariants: belowCost.length, unresolvedArtworkReferenceCount: unresolved.length,
    currencyVerified: false });
  for (const v of p.variants) {
    const mapped = mappings.find(m => m.sourceShopId === shopId && m.sourceProductId === p.id && m.sourceVariantId === v.id);
    assert(mapped);
    assert.equal(mapped.supplierCostCents, v.cost ?? null);
    assert.equal(mapped.existingChannelRetailCents, v.price ?? null);
    assert.equal(mapped.enabled, v.is_enabled ?? null);
    assert.equal(mapped.available, v.is_available ?? null);
    assert(mapped.options.every(option => option.type || option.name), 'Unresolved variant option');
    csvRows.push({ shopId, productId: p.id, product: p.title, visible: p.visible,
      variantId: v.id, variant: v.title, sku: v.sku,
      options: mapped.options.map(o => `${o.type || o.name}: ${o.title}`).join('; '),
      enabled: v.is_enabled, available: v.is_available,
      blueprintId: p.blueprint_id, printProviderId: p.print_provider_id,
      supplierCostCents: v.cost, savedRetailCents: v.price, currency: mapped.currency,
      belowReportedCost: Number.isInteger(v.price) && Number.isInteger(v.cost) ? v.price < v.cost : null,
      targetShopId: null, targetProductId: null, targetVariantId: null, localProductId: null, localVariantId: null });
  }
}
const columns = Object.keys(csvRows[0] || {});
const csv = value => {
  let text = value == null ? '' : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
await fs.writeFile(path.join(root, 'variants.csv'), [columns.map(csv).join(','), ...csvRows.map(row => columns.map(c => csv(row[c])).join(','))].join('\n') + '\n', { mode: 0o600 });
const review = {
  reviewedAt: new Date().toISOString(), sourceCapturedAt: inventory.capturedAt,
  visibleProductCount: inventory.products.filter(p => p.visible).length,
  hiddenProductCount: inventory.products.filter(p => !p.visible).length,
  productsWithEnabledVariants: comparisons.filter(p => p.enabledVariants > 0).length,
  enabledVariants: comparisons.reduce((sum, p) => sum + p.enabledVariants, 0),
  enabledAvailableVariants: comparisons.reduce((sum, p) => sum + p.enabledAvailableVariants, 0),
  enabledVariantsMissingFromCatalog: comparisons.reduce((sum, p) => sum + (p.enabledMissingFromCatalog || 0), 0),
  variantsBelowReportedProductionCost: comparisons.reduce((sum, p) => sum + p.belowReportedCostVariants, 0),
  productImageReferenceCount: snapshot.products.reduce((sum, p) => sum + p.product.images.length, 0),
  artworkReferenceCount: snapshot.artworks.length, retrievableUploadMetadataCount: snapshot.artworks.filter(a => a.upload).length,
  artworkVisualVerification: 'not_performed', binaryImagesArchived: false,
  productPriceCurrency: 'not_explicit_in_product_or_shop_response; verify before importing money values',
  shippingRateCurrencies: [...new Set(Object.values(snapshot.catalogPairs).flatMap(pair => (pair.shipping?.profiles || []).flatMap(p => [p.first_item?.currency, p.additional_items?.currency]).filter(Boolean)))],
  fulfillmentShopRecommendation: 'Existing Wix shop is an API reuse candidate. Do not copy automatically; review approval policy, test isolation, non-media layers and legacy provider gaps first.',
  productionApprovalSettings: 'not_exposed_by_retrieved_shop_list; verify in Printify before any order creation',
  integrationPermissionCheck: 'Read-only GET access verified; no order creation, production submission or write-permission probe performed.',
  comparisons, holds,
  validation: { mappingCountMatches: true, mappingKeysUnique: true, capturedVariantFieldsMatch: true, variantOptionsResolve: true },
  remoteWritesPerformed: false, csaDatabaseWritesPerformed: false
};
assert.equal(review.enabledVariants, inventory.enabledVariantCount);
await fs.writeFile(path.join(root, 'catalog-review.json'), JSON.stringify(review, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ products: comparisons.length, variants: mappings.length,
  enabledVariants: review.enabledVariants, enabledAvailableVariants: review.enabledAvailableVariants,
  mappingValidated: true, productsRequiringReview: holds.map(p => ({ title: p.title, reasons: p.reasons })) }, null, 2));
