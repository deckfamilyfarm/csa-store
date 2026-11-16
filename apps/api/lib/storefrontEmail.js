const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const itemLine = (item, quantity) => `${quantity} × ${item.typeLabel && item.sizeLabel ? `Thanksgiving Turkey — ${item.typeLabel}, ${item.sizeLabel}` : item.label} — ${money(item.priceCents)} each`;
export function storefrontEmailContent(order) {
  const refunded = order.kind === 'refund';
  const changed = order.kind === 'cancellation';
  const remaining = order.items.filter(i => (i.remainingQuantity ?? i.quantity) > 0);
  const title = changed ? `Turkey preorder updated — ${order.number}` : refunded ? `Turkey preorder refunded — ${order.number}` : `Your turkey preorder — ${order.number}`;
  const lines = [`Hello ${order.customer.name},`, '',
    changed ? `${money(order.cancellation.amountCents)} has been refunded for the cancelled turkey items below.` :
      refunded ? `Your payment of ${money(order.totalCents)} has been refunded.${order.collectedMs ? '' : ' Your preorder is cancelled.'}` :
        'Thank you! Your turkey preorder is paid and confirmed.',
    `Order: ${order.number}`,
    ...(changed ? ['Cancelled:', ...order.cancellation.items.map(i => itemLine(i, i.quantity)), '',
      remaining.length ? 'Still reserved for pickup:' : 'No turkeys remain on this order. Your preorder is cancelled.'] : []),
    ...(refunded ? order.items.map(i => itemLine(i, i.quantity)) : remaining.map(i => itemLine(i, i.remainingQuantity ?? i.quantity))),
    `Total paid originally: ${money(order.totalCents)}`,
    ...(order.refundedCents ? [`Total refunded: ${money(order.refundedCents)}`, `Remaining paid: ${money(order.remainingTotalCents)}`] : []), '',
    ...(!refunded && remaining.length ? [
      `Pickup: ${[order.pickup.groupName, order.pickup.name].filter(Boolean).join(' — ')}`, `Date: ${order.pickup.date}`, `Hours: ${order.pickup.hours} (Pacific time)`,
      `Address: ${order.pickup.address}`, order.pickup.instructions, 'Bring your order number when you pick up your turkey.'
    ] : []), '', `Questions or changes? Contact ${order.contactEmail}.`, '',
    `Customer: ${order.customer.name}`, `Phone: ${order.customer.phone}`];
  return { title, lines };
}
