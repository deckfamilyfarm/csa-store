import React, { useEffect, useRef, useState } from 'react';
import { adminPost } from '../adminApi.js';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const label = item => item.typeLabel && item.sizeLabel ? `${item.typeLabel}, ${item.sizeLabel}` : item.label;

export function TurkeyCancellationDialog({ order, token, onClose, onUpdated }) {
  const [quantities, setQuantities] = useState({});
  const [reason, setReason] = useState('Customer requested cancellation');
  const [review, setReview] = useState(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => { if (review) dialog.current?.focus(); }, [review]);
  async function preview(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      setReview(await adminPost(`storefront/orders/${order.id}/cancellations/review`, token, {
        reason, items: order.items.filter(i => Number(quantities[i.optionId]) > 0).map(i => ({ optionId: i.optionId, quantity: Number(quantities[i.optionId]) }))
      }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setAttempted(true); setError('');
    try {
      const updated = await adminPost(`storefront/orders/${order.id}/cancellations/${review.id}/confirm`, token, {});
      await onUpdated(updated); onClose();
    } catch (err) {
      setError(`${err.message} Use “Check this cancellation” to recover this same request, or close and refresh Orders. Do not start another refund.`);
    } finally { setBusy(false); }
  }
  function keyboard(event) {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
    if (!controls.length) return;
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="turkey-cancellation-overlay no-print">
    <section className="turkey-card turkey-cancellation-dialog" role="dialog" aria-modal="true" aria-labelledby="turkey-cancellation-title" tabIndex={-1} ref={dialog} onKeyDown={keyboard}>
      <div className="turkey-actions"><h3 id="turkey-cancellation-title">Cancel turkey items</h3><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
      <p><strong>{order.customer.name}</strong> · {order.number}<br />{order.pickup.name} · {order.pickup.date}</p>
      {error && <p role="alert" className="turkey-error">{error}</p>}
      {!review ? <form onSubmit={preview}>
        <p>Choose how many birds to cancel. Refunds use the prices paid on this order.</p>
        {order.items.filter(i => i.remainingQuantity > 0).map(item => <label className="turkey-cancellation-item" key={item.optionId}>
          <span>{label(item)} · {money(item.priceCents)} each<br /><small>{item.remainingQuantity} currently reserved for pickup</small></span>
          <span>Quantity to cancel<input type="number" min="0" max={item.remainingQuantity} step="1" required disabled={busy}
            aria-label={`Quantity to cancel: ${label(item)}`} value={quantities[item.optionId] ?? '0'} onChange={e => setQuantities(prev => ({ ...prev, [item.optionId]: e.target.value }))} /></span>
        </label>)}
        <label>Reason<textarea required maxLength={500} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button type="submit" disabled={busy || !order.items.some(i => Number(quantities[i.optionId]) > 0)}>{busy ? 'Checking order…' : 'Review cancellation'}</button>
      </form> : <>
        <h4>Cancel and refund</h4>
        <ul>{review.items.map(item => <li key={item.optionId}>{item.quantity} × {label(item)} · {money(item.quantity * item.priceCents)}</li>)}</ul>
        <p><strong>Refund: {money(review.amountCents)}</strong></p>
        <h4>Remaining for pickup</h4>
        {review.remainingItems.length ? <ul>{review.remainingItems.map(item => <li key={item.optionId}>{item.quantity} × {label(item)}</li>)}</ul> : <p>None. This will cancel the entire remaining order.</p>}
        <p>Remaining paid: <strong>{money(review.remainingTotalCents)}</strong></p>
        <p>The cancelled birds return to preorder inventory after the refund succeeds. An updated confirmation will be emailed to {order.customer.email}.</p>
        <div className="turkey-actions">
          {!attempted && <button type="button" disabled={busy} onClick={() => setReview(null)}>Edit selection</button>}
          <button type="button" disabled={busy} onClick={confirm}>{busy ? 'Checking refund…' : attempted ? 'Check this cancellation' : `Confirm cancellation & refund ${money(review.amountCents)}`}</button>
        </div>
      </>}
    </section>
  </div>;
}
