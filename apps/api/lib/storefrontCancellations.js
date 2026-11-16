import { fail, hash, integer, parse, recordId, text } from './storefrontCore.js';

export const remainingQuantity = item => item.quantity - (item.cancelled_quantity || 0);
export const cancelledValue = row => row.items.reduce((sum, item) => sum + (item.cancelled_quantity || 0) * item.price_cents, 0);
export function canFulfill(row) {
  return row.status === 'paid' && !row.collected_ms &&
    [null, '', 'partial', 'succeeded'].includes(row.refund_status) &&
    row.refunded_cents === cancelledValue(row) && row.items.some(item => remainingQuantity(item) > 0);
}
export function cancellationBaseline(row) {
  return hash(JSON.stringify({ status: row.status, collected: row.collected_ms, payment: row.stripe_payment_id,
    mode: row.stripe_mode, total: row.total_cents, refunded: row.refunded_cents, refundStatus: row.refund_status,
    items: row.items.map(i => [i.option_id, i.quantity, i.cancelled_quantity || 0, i.price_cents]) }));
}
export function cancellationPlan(row, input) {
  if (!canFulfill(row)) fail('Only an uncollected paid order with fully reconciled refunds can be changed.', 409);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > row.items.length) fail('Select the turkeys to cancel.');
  const seen = new Set();
  const items = input.items.map(selection => {
    const optionId = recordId(selection.optionId, 'Turkey option');
    if (seen.has(optionId)) fail('Select each turkey option only once.');
    seen.add(optionId);
    const item = row.items.find(i => i.option_id === optionId);
    if (!item) fail('That turkey is not part of this order.');
    const quantity = integer(selection.quantity, 'Cancellation quantity', 1, remainingQuantity(item));
    return { optionId, quantity, priceCents: item.price_cents, label: item.label, typeLabel: item.turkey_type, sizeLabel: item.size_label };
  }).sort((a, b) => a.optionId - b.optionId);
  const amountCents = items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
  integer(amountCents, 'Refund amount', 1, row.total_cents - row.refunded_cents);
  return { items, amountCents, reason: text(input.reason, 'cancellation reason', 500),
    remainingItems: row.items.map(item => ({ optionId: item.option_id, label: item.label, typeLabel: item.turkey_type,
      sizeLabel: item.size_label, priceCents: item.price_cents,
      quantity: remainingQuantity(item) - (items.find(i => i.optionId === item.option_id)?.quantity || 0) })).filter(i => i.quantity > 0),
    remainingTotalCents: row.total_cents - row.refunded_cents - amountCents };
}
export function cancellationView(row) {
  return { id: row.id, status: row.status, ...parse(row.plan_json), createdMs: Number(row.created_ms),
    attemptedMs: row.attempted_ms && Number(row.attempted_ms), confirmedMs: row.applied_ms && Number(row.applied_ms),
    error: row.last_error || null };
}
