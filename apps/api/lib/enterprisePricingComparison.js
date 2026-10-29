const baskets = ["Guest Basket", "CSA Members", "Herd Share Members", "SNAP"];
export function compareLocalChannelPrices(revision, record) {
  const rows = [];
  const add = (destination, label, current, local, mapped = true) => rows.push({ destination, label,
    currentCents: current == null ? null : Number(current), localCents: local,
    status: !mapped || current == null ? "needs-check" : Number(current) === local ? "matches" : "different" });
  for (const pkg of revision.output.packages) {
    const source = record?.packages.find(item => Number(item.id) === pkg.packageId);
    const name = source?.name || `Package ${pkg.packageId}`;
    for (const basket of baskets) {
      const prices = (record?.localLinePrices || []).filter(item => Number(item.packageId) === pkg.packageId && item.listName === basket);
      const price = prices.length === 1 ? prices[0].finalPrice : null;
      add("Local Line", `${name} · ${basket}`, price == null ? null : Math.round(Number(price) * 100), pkg.localLineRegularCents,
        Boolean(source?.metadata?.localLinePackageId));
    }
    if (revision.input.squareEnabled) {
      const prices = (record?.squarePrices || []).filter(item => Number(item.packageId) === pkg.packageId);
      if (!prices.length) add("Square", name, null, revision.output.squareUnitCents, false);
      for (const price of prices) add("Square", `${name} · per ${revision.input.pricingUnit}`, price.priceCents, revision.output.squareUnitCents);
    }
  }
  return rows;
}
