import { activeLocalLinePriceListIds, validateActiveLocalLinePriceListIds, enrolledLocalLineLists } from "./localLinePricingLists.js";
// Convert an already reviewed Local Line update into the enterprise price
// snapshot. The existing builder still owns vendor, product, package, and list
// mapping checks; this function only replaces eligible basket selling prices.
export function applyEnterpriseLocalLinePrices(payload, context, revision, listIds = activeLocalLinePriceListIds()) {
  if (!revision || !payload?.packages?.length) throw new Error("A reviewed Local Line payload is required.");
  if (Number(revision.output?.saleBp || 0) > 0) throw new Error("Enterprise sales require the separate promotion publication workflow.");
  validateActiveLocalLinePriceListIds(listIds);
  const packageByRemoteId = new Map(context.packages.map(pkg => {
    const meta = context.packageMeta.find(row => Number(row.packageId) === Number(pkg.id));
    return [Number(meta?.localLinePackageId || pkg.id), Number(pkg.id)];
  }));
  const expected = new Map(revision.output.packages.map(row => [Number(row.packageId), row]));
  if (payload.packages.length !== expected.size) throw new Error("Local Line package count changed since pricing review.");
  return {
    ...payload,
    packages: payload.packages.map(pkg => {
      const localPackageId = packageByRemoteId.get(Number(pkg.id));
      const price = expected.get(localPackageId);
      if (!price || price.localLineRegularCents === null) throw new Error(`Package ${pkg.name || pkg.id} has no approved calculated price.`);
      const entries = pkg.price_list_entries || [];
      const enrolled = enrolledLocalLineLists(pkg, listIds);
      if (entries.length !== enrolled.length) throw new Error('Price publication contains an unconfigured basket. Review its mapping.');
      const regular = price.localLineRegularCents / 100;
      return {
        ...pkg, unit_price: regular, package_price: regular, package_unit_price: regular,
        price_list_entries: entries.map(entry => ({
          ...entry,
          adjustment: true, adjustment_type: 3, adjustment_value: regular,
          calculated_value: regular, base_price_used: regular,
          on_sale: false, on_sale_toggle: false, strikethrough_display_value: null
        }))
      };
    })
  };
}
