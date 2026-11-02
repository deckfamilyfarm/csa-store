import { activeLocalLinePriceListIds, validateActiveLocalLinePriceListIds, enrolledLocalLineLists } from "./localLinePricingLists.js";
import { enterprisePackageCostCents, requireLocalLinePackageCharging } from './enterpriseLocalLineCost.js';
// Convert an already reviewed Local Line update into the enterprise price
// snapshot. The existing builder still owns vendor, product, package, and list
// mapping checks; this function sets vendor Cost and eligible basket retail.
export function applyEnterpriseLocalLinePrices(payload, context, revision, listIds = activeLocalLinePriceListIds(), remote = null) {
  if (!revision || !payload?.packages?.length) throw new Error("A reviewed Local Line payload is required.");
  if (Number(revision.output?.saleBp || 0) > 0) throw new Error("Enterprise sales require the separate promotion publication workflow.");
  validateActiveLocalLinePriceListIds(listIds);
  requireLocalLinePackageCharging(remote);
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
      const cost = enterprisePackageCostCents(revision.output, localPackageId) / 100;
      return {
        ...pkg, unit_price: cost, package_price: cost, package_unit_price: cost,
        price_list_entries: entries.map(entry => ({
          ...entry,
          adjustment: true, adjustment_type: 3, adjustment_value: regular,
          calculated_value: regular, base_price_used: cost,
          on_sale: false, on_sale_toggle: false, strikethrough_display_value: null
        }))
      };
    })
  };
}
