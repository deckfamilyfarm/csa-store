export const reviewMoney = cents => cents == null ? '—' : `$${(Number(cents) / 100).toFixed(2)}`;
export const canReview = roles => roles.some(role => ['admin', 'pricing_admin', 'pricing_publisher'].includes(role));
export function canPublishReview(row, roles) {
  const grant = name => roles.includes('admin') || roles.includes(name);
  return canReview(roles) && grant('localline_push') && (!row.input.squareEnabled || grant('square_push'));
}
export function reviewState(row) {
  const check = row.check;
  const actions = check?.actions || [];
  if (actions.some(a => ['queued', 'running'].includes(a.publicationStatus))) return 'publishing';
  if (check?.status === 'running') return 'checking';
  if (check?.error || check?.status === 'failed' || actions.some(a => ['blocked', 'held', 'review', 'failed'].includes(a.status)
    || ['partial', 'failed', 'held', 'cancelled'].includes(a.publicationStatus))) return 'attention';
  const platforms = row.input.squareEnabled ? ['localline', 'square'] : ['localline'];
  const complete = platforms.every(platform => actions.some(a => a.platform === platform));
  if (check?.status === 'completed' && complete && actions.length && actions.every(a => a.status === 'synced' || a.releaseStatus === 'completed')) return 'synced';
  if (actions.some(a => a.released)) return 'attention';
  if (['approved', 'partial', 'active'].includes(row.status) && check?.status === 'completed'
    && actions.some(a => a.status === 'changed') && actions.every(a => ['changed', 'synced'].includes(a.status))
    && complete) return 'ready';
  return 'unchecked';
}
export function filterReviewRows(rows, { search = '', vendor = '', status = '' } = {}) {
  const term = search.trim().toLowerCase();
  return rows.filter(row => (!vendor || row.vendorName === vendor)
    && (!term || `${row.productName} ${row.vendorName} ${row.productId}`.toLowerCase().includes(term))
    && (!status || reviewState(row) === status));
}
// Always intersect selection with the displayed filter and exact current revision.
export function selectedReviewRows(rows, selected) { return rows.filter(row => selected.includes(row.id)); }
export function reviewComparisons(row) {
  const live = (row.check?.actions || []).flatMap(action => {
    if (action.platform === 'localline') return (action.display?.pricingComparison || []).map(item =>
      action.releaseStatus === 'completed' ? { ...item, currentCents: item.localCents } : item);
    if (!action.display) return [];
    const cents = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
    return [{ destination: 'Square', label: `${action.packageName || 'Product'} · per ${action.display.proposed?.sellingUnit || row.input.pricingUnit}`,
      currentCents: cents(action.releaseStatus === 'completed' ? action.display.proposed?.price : action.display.current?.price), localCents: cents(action.display.proposed?.price) }];
  });
  return [...(row.comparison || []).filter(item => !live.some(current => current.destination === item.destination)), ...live];
}
export function reviewPriceSummary(row, destination, field) {
  const values = reviewComparisons(row).filter(item => item.destination === destination).map(item => item[field]);
  if (!values.length || values.some(value => value == null)) return 'Needs check';
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length === 1 ? reviewMoney(unique[0]) : `${reviewMoney(unique[0])}–${reviewMoney(unique.at(-1))}`;
}
export function reviewWarnings(row) {
  return [...new Set([row.check?.error, ...(row.check?.actions || []).flatMap(a =>
    [a.message, ...(a.warnings || []), a.releaseMessage, a.result?.message])].filter(Boolean))];
}
export async function publishReviewedRevision(row, { get, post }) {
  if (reviewState(row) !== 'ready') throw new Error('Check and review this product before publishing.');
  const check = row.check;
  const action = check.actions.find(a => a.status === 'changed');
  const receiptPath = `product-sync/audits/${check.auditId}/actions/${action.id}/release`;
  // A lost response must resume its original release, never submit new work.
  const existing = await get(receiptPath);
  if (existing) return existing;
  try {
    return await post('product-sync/releases', { auditId: check.auditId, actionIds: check.actions.map(a => a.id),
      name: `Enterprise pricing · ${row.productName} · revision ${row.id}`, background: true });
  } catch (error) {
    const recovered = await get(receiptPath).catch(() => null);
    if (recovered) return recovered;
    throw error;
  }
}
