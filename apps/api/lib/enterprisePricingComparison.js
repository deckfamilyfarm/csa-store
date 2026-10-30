import { ACTIVE_LOCAL_LINE_BASKETS } from "./localLinePricingLists.js";
const baskets = ACTIVE_LOCAL_LINE_BASKETS.map(list => list.name);
// Freeze the actual server selling prices alongside the audited publication payload.
// Unknown server calculations stay unknown rather than becoming guessed prices.
export function liveLocalLinePriceComparison(remote, payload) {
  return (payload.packages || []).flatMap(pkg => {
    const current = remote?.packages?.find(item => Number(item.id) === Number(pkg.id));
    return (pkg.price_list_entries || []).map(entry => {
      const entries = (current?.price_list_entries || []).filter(item => Number(item.price_list_id ?? item.price_list) === Number(entry.price_list));
      const old = entries.length === 1 ? entries[0] : null;
      const amount = old?.calculated_value ?? (Number(old?.adjustment_type) === 3 ? old.adjustment_value : null);
      const currentCents = amount == null || !Number.isFinite(Number(amount)) ? null : Math.round(Number(amount) * 100);
      const proposedAmount = entry.calculated_value ?? (Number(entry.adjustment_type) === 3 ? entry.adjustment_value : null);
      const localCents = proposedAmount == null ? null : Math.round(Number(proposedAmount) * 100);
      return { destination: "Local Line", label: `${pkg.name || current?.name || `Package ${pkg.id}`} · basket ${entry.price_list}`,
        packageName: pkg.name || current?.name || `Package ${pkg.id}`,
        listName: ACTIVE_LOCAL_LINE_BASKETS.find(list => Number(process.env[list.env]) === Number(entry.price_list))?.name || null,
        remotePackageId: Number(pkg.id), remoteListId: Number(entry.price_list),
        currentCents, localCents, status: currentCents == null || localCents == null ? "needs-check" : currentCents === localCents ? "matches" : "different" };
    });
  });
}

export async function refreshEnterprisePriceCache(pool, productId, remote, payload) {
  // Cache observed remote prices only. Do not write products, packages, pricing inputs, or mappings.
  for (const row of liveLocalLinePriceComparison(remote, payload)) {
    const pkg = remote?.packages?.find(pkg => Number(pkg.id) === row.remotePackageId);
    const entry = pkg?.price_list_entries?.find(entry => Number(entry.price_list_id ?? entry.price_list) === row.remoteListId);
    await pool.query(`UPDATE local_line_price_list_entries SET final_price_cache=?,calculated_value=?,adjustment_type=?,adjustment_value=?,last_synced_at=UTC_TIMESTAMP()
      WHERE product_id=? AND local_line_package_id=? AND local_line_price_list_id=? AND package_id IS NOT NULL`,
      [row.currentCents == null ? null : row.currentCents / 100, entry?.calculated_value ?? null, entry?.adjustment_type ?? null, entry?.adjustment_value ?? null,
        productId, row.remotePackageId, row.remoteListId]);
  }
}
export function compareLocalChannelPrices(revision, record) {
  const rows = [];
  const add = (destination, label, current, local, mapped = true) => rows.push({ destination, label,
    currentCents: current == null ? null : Number(current), localCents: local,
    status: !mapped || current == null || local == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(local)) ? "needs-check" : Number(current) === local ? "matches" : "different" });
  for (const pkg of revision.output.packages) {
    const source = record?.packages.find(item => Number(item.id) === pkg.packageId);
    const name = source?.name || `Package ${pkg.packageId}`;
    const enrolled = record?.expectedLocalLineListIds ?? source?.metadata?.localLineListIds;
    const expectedBaskets = enrolled ? ACTIVE_LOCAL_LINE_BASKETS.filter(b => enrolled.includes(Number(process.env[b.env]))).map(b=>b.name) : baskets;
    if (enrolled && !expectedBaskets.length) add('Local Line', `${name} · basket mapping needed`, null, pkg.localLineRegularCents, false);
    for (const basket of expectedBaskets) {
      const prices = (record?.localLinePrices || []).filter(item => Number(item.packageId) === pkg.packageId && item.listName === basket);
      const price = prices.length === 1 ? prices[0].finalPrice : null;
      add("Local Line", `${name} · ${basket}`, price == null ? null : Math.round(Number(price) * 100), pkg.localLineRegularCents,
        Boolean(source?.metadata?.localLinePackageId));
    }
    if (revision.input.squareEnabled) {
      const prices = (record?.squarePrices || []).filter(item => Number(item.packageId) === pkg.packageId);
      if (!prices.length) add("Square", name, null, pkg.squareVariationCents ?? revision.output.squareUnitCents, false);
      for (const price of prices) add("Square", `${name} · per ${revision.input.pricingUnit}`, price.priceCents, pkg.squareVariationCents ?? revision.output.squareUnitCents);
    }
  }
  return rows;
}
