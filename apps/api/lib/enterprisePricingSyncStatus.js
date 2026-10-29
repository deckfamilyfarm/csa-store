import { compareLocalChannelPrices } from './enterprisePricingComparison.js';

const parse = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
};

export function matchesPricingSyncFilter(row, filter) {
  if (filter === 'inputs') return !row.output && !row.fixedDeposit;
  if (filter === 'synced') return row.sync?.allMatched === true;
  if (['localline', 'square'].includes(filter)) return row.sync?.channels?.some(channel => channel.platform === filter && channel.state === 'attention') === true;
  return true;
}

// Read only the current page's cached channel prices; never contact either platform.
export async function readPricingChannelRecords(pool, productIds) {
  const records = new Map(productIds.map(id => [Number(id), { packages: [], localLinePrices: [], squarePrices: [] }]));
  if (!productIds.length) return records;
  const [[packages], [prices], [square]] = await Promise.all([
    pool.query(`SELECT p.id,p.product_id AS productId,p.name,p.price,m.local_line_package_id AS remoteId
      FROM packages p LEFT JOIN local_line_package_meta m ON m.package_id=p.id WHERE p.product_id IN (?)`, [productIds]),
    pool.query(`SELECT product_id AS productId,package_id AS packageId,price_list_name AS listName,
      final_price_cache AS finalPrice,adjustment_type AS adjustmentType,adjustment_value AS adjustmentValue
      FROM local_line_price_list_entries WHERE product_id IN (?)`, [productIds]),
    pool.query(`SELECT l.product_id AS productId,l.package_id AS packageId,v.price_amount AS priceCents,
      v.is_deleted AS isDeleted,v.raw_json AS rawJson
      FROM square_variation_links l LEFT JOIN square_catalog_variations v ON v.square_variation_id=l.square_variation_id
      WHERE l.product_id IN (?) AND l.approved_at IS NOT NULL`, [productIds])
  ]);
  for (const row of packages) records.get(Number(row.productId))?.packages.push({ ...row, metadata: { localLinePackageId: row.remoteId } });
  for (const row of prices) records.get(Number(row.productId))?.localLinePrices.push(row);
  for (const row of square) records.get(Number(row.productId))?.squarePrices.push({ ...row, priceCents: Number(row.isDeleted) ? null : row.priceCents });
  return records;
}

export function pricingSyncStatus({ input, output, publications = [], promotions = [], localOnly = false }, record, now = Date.now()) {
  const enabled = input?.squareEnabled === true;
  const channels = [{ platform: 'localline', label: 'LL' }, ...(enabled ? [{ platform: 'square', label: 'Sq' }] : [])];
  // A running sale changes LL package prices, but Square's base rate stays unchanged.
  const expected = output ? structuredClone(output) : null;
  for (const sale of promotions) {
    if (sale.input?.channels?.includes('localline') && Date.parse(sale.input.startAt) <= now && now < Date.parse(sale.input.endAt)) {
      for (const price of sale.output?.localLinePrices || []) {
        const pkg = expected?.packages?.find(pkg => Number(pkg.packageId) === Number(price.packageId));
        if (pkg) pkg.localLineRegularCents = price.saleCents;
      }
    }
  }
  const comparisons = expected ? compareLocalChannelPrices({ input, output: expected }, record) : [];
  for (const channel of channels) {
    const destination = channel.platform === 'square' ? 'Square' : 'Local Line';
    const rows = comparisons.filter(row => row.destination === destination);
    const publication = publications.find(item => item.platform === channel.platform);
    const reasons = [];
    if (!expected || !rows.length) reasons.push('Pricing inputs or packages need review');
    if (expected && record && (record.packages.length !== expected.packages.length || record.packages.some(pkg => !expected.packages.some(item => Number(item.packageId) === Number(pkg.id))))) reasons.push('Package definitions changed');
    if (rows.some(row => row.status === 'different')) reasons.push('Price update needed');
    if (rows.some(row => row.status === 'needs-check')) reasons.push('Channel price or mapping needs checking');
    if (publication && publication.status !== 'verified') reasons.push(`Publication ${publication.status}`);
    if (channel.platform === 'square') {
      for (const price of record?.squarePrices || []) {
        const data = parse(price.rawJson)?.item_variation_data;
        if (data && !data.measurement_unit_id && input.pricingUnit === 'lb') reasons.push('Square selling unit needs updating');
        else if ((!data || data.measurement_unit_id) && publication?.status !== 'verified') reasons.push('Square selling unit needs checking');
        if (data?.location_overrides?.some(location => location.price_money)) reasons.push('Square location price needs checking');
      }
    } else {
      if ((record?.localLinePrices || []).some(price => Number(price.adjustmentType) === 3 && price.adjustmentValue != null && price.finalPrice != null
        && Math.round(Number(price.adjustmentValue) * 100) !== Math.round(Number(price.finalPrice) * 100))) reasons.push('Local Line fixed price needs checking');
    }
    for (const sale of promotions.filter(sale => sale.input?.channels?.includes(channel.platform))) {
      const channelStatus = channel.platform === 'square' ? sale.squareStatus : sale.localLineStatus;
      const saleActive = Date.parse(sale.input.startAt) <= now && now < Date.parse(sale.input.endAt);
      const complete = channel.platform === 'square' ? channelStatus === 'verified' && now < Date.parse(sale.input.endAt)
        : saleActive ? channelStatus === 'active' : channelStatus === 'restored';
      if (!complete || ['pending', 'cancelling'].includes(sale.status)) reasons.push(`Sale ${sale.status || 'needs checking'}`);
    }
    channel.state = reasons.length ? 'attention' : 'matched';
    channel.reason = [...new Set(reasons)].join('; ') || (localOnly ? 'Prices match imported channel data' : 'Prices match the latest channel check');
  }
  return { channels, allMatched: channels.every(channel => channel.state === 'matched'), basis: localOnly ? 'imported' : 'cached' };
}
