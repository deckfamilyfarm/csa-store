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
  // Store observed channel prices, including missing cache rows. Never alter local
  // pricing inputs, package mappings, basket enrollment, or inventory.
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    // Serialize cache repairs for this product; retries cannot insert duplicates.
    await db.query('SELECT id FROM products WHERE id=? FOR UPDATE', [productId]);
    const [mappings] = await db.query(`SELECT p.id,m.local_line_package_id AS remoteId
      FROM packages p JOIN local_line_package_meta m ON m.package_id=p.id WHERE p.product_id=?`, [productId]);
    const [lists] = await db.query('SELECT id,local_line_price_list_id AS remoteId,name FROM price_lists');
    for (const row of liveLocalLinePriceComparison(remote, payload)) {
      const pkg = remote?.packages?.find(pkg => Number(pkg.id) === row.remotePackageId);
      const entries = (pkg?.price_list_entries || []).filter(entry => Number(entry.price_list_id ?? entry.price_list) === row.remoteListId);
      const entry = entries.length === 1 ? entries[0] : null;
      const observed = [row.currentCents == null ? null : row.currentCents / 100, entry?.calculated_value ?? null,
        entry?.adjustment_type ?? null, entry?.adjustment_value ?? null];
      await db.query(`UPDATE local_line_price_list_entries SET final_price_cache=?,calculated_value=?,adjustment_type=?,adjustment_value=?,last_synced_at=UTC_TIMESTAMP()
        WHERE product_id=? AND local_line_package_id=? AND local_line_price_list_id=? AND package_id IS NOT NULL`,
        [...observed, productId, row.remotePackageId, row.remoteListId]);
      const mapped = mappings.filter(m => Number(m.remoteId) === row.remotePackageId);
      const list = lists.find(l => Number(l.remoteId) === row.remoteListId);
      if (!entry || mapped.length !== 1 || !list) continue;
      await db.query(`INSERT INTO local_line_price_list_entries
        (product_id,local_line_product_id,package_id,local_line_package_id,price_list_id,local_line_price_list_id,
         entry_scope,price_list_name,package_name,final_price_cache,calculated_value,adjustment_type,adjustment_value,
         created_at,updated_at,last_synced_at)
        SELECT ?,?,?,?,?,?,'package',?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP()
        WHERE NOT EXISTS (SELECT 1 FROM local_line_price_list_entries WHERE product_id=?
          AND local_line_package_id=? AND local_line_price_list_id=? AND package_id IS NOT NULL)`,
        [productId, remote.id ?? null, mapped[0].id, row.remotePackageId, list.id, row.remoteListId,
          row.listName || list.name, pkg.name || null, ...observed, productId, row.remotePackageId, row.remoteListId]);
    }
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
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
