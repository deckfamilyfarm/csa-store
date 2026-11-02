import { roundRatio } from './enterprisePricingEngine.js';

export const ENTERPRISE_LOCAL_LINE_COST_POLICY = 'vendor-cost-base-v1';

// Local Line's base price becomes order.package_unit_price for vendor reports.
// Retail and sales belong on the basket entries, never in this Cost field.
export function enterprisePackageCostCents(output, packageId) {
  const pkg = output?.packages?.find(p => Number(p.packageId) === Number(packageId));
  if (!pkg) throw new Error('The approved package Cost is missing. Review pricing again.');
  if (pkg.packageBuyPriceCents != null) {
    if (!Number.isSafeInteger(pkg.packageBuyPriceCents) || pkg.packageBuyPriceCents <= 0) throw new Error('Package Cost is invalid.');
    return pkg.packageBuyPriceCents;
  }
  const cost = output.buyFromTenThousandths;
  const factor = output.pricingUnit === 'lb' ? pkg.averageWeightMilliPounds : output.pricingUnit === 'each' ? pkg.quantity : null;
  if (!Number.isSafeInteger(cost) || cost <= 0 || !Number.isSafeInteger(factor) || factor <= 0) {
    throw new Error('The approved Cost, pricing unit, or package weight/quantity is missing. Review pricing again.');
  }
  return roundRatio(BigInt(cost) * BigInt(factor), output.pricingUnit === 'lb' ? 100000n : 100n);
}

export function requireLocalLinePackageCharging(remote) {
  if (remote?.charge_type && remote.charge_type !== 'package') {
    throw new Error('Local Line charges this product by weight. Review its charge unit and package Cost before publishing package prices.');
  }
}

export function requireEnterpriseCostPolicy(action) {
  if (action.platform === 'localline' && action.enterpriseRevisionId && action.enterpriseCostPolicy !== ENTERPRISE_LOCAL_LINE_COST_POLICY) {
    throw Object.assign(new Error('This approval predates the vendor Cost correction. Check prices and approve again before publishing.'), { hold: true });
  }
}
