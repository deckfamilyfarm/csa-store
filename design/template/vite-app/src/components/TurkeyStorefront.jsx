import React, { useEffect, useState } from 'react';
import { DeckPageHeader } from './DeckPageHeader.jsx';
import { SubscribeFooter } from './SubscribeFooter.jsx';
import { ProductDescription } from './ProductDescription.jsx';
import { buildSubscribeNavLinks, getSubscribeHostUrl } from './subscribeNavigation.js';
import './turkey.css';

const base = import.meta.env.VITE_API_BASE || '/api';
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const pickupDateLabel = date => date ? new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
async function request(path, { body, token, method } = {}) {
  const response = await fetch(`${base}/storefront/${path}`, {
    method: method || (body ? 'POST' : 'GET'), cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete your request.');
  return data;
}
function storage(key, fallback = null) {
  try { return JSON.parse(sessionStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const emptyCustomer = { name: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '', state: 'OR', postalCode: '', country: 'US' };

export function TurkeyStorefront() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quantities, setQuantities] = useState({});
  const [customer, setCustomer] = useState(emptyCustomer);
  const [pickupId, setPickupId] = useState('');
  const [order, setOrder] = useState(null);
  const [pending, setPending] = useState(() => storage('turkeyPending'));
  const [route, setRoute] = useState(window.location.hash);
  const params = new URLSearchParams(route.split('?')[1] || '');
  const preview = params.get('preview') === '1';
  const orderId = params.get('order');
  const cancelled = params.get('cancelled') === '1';
  const sale = catalog?.sale;
  const items = (catalog?.options || []).filter(option => Number(quantities[option.id]) > 0).map(option => ({ optionId: option.id, quantity: Number(quantities[option.id]) }));
  const total = items.reduce((sum, item) => sum + catalog.options.find(option => option.id === item.optionId).priceCents * item.quantity, 0);
  const soldOut = catalog && catalog.options.every(option => option.available <= 0);
  const token = orderId ? storage(`turkeyOrder:${orderId}`) : null;
  const heroImage = sale?.imageUrl || '/images/turkey-home/turkey-banner.jpg';

  useEffect(() => {
    document.title = 'Thanksgiving turkey preorders | Deck Family Farm';
    const listener = () => { setRoute(window.location.hash); setOrder(null); setError(''); };
    window.addEventListener('hashchange', listener);
    let active = true;
    const load = () => (preview ? fetch(`${base}/admin/storefront/setup`, { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}` } }).then(async response => {
      if (!response.ok) throw new Error('Sign in with Storefront Admin access to preview the sale.');
      const data = await response.json();
      const pickupGroups = data.pickupGroups.filter(group => group.active);
      return { ...data, pickupGroups, pickups: data.pickups.filter(pickup => pickup.active && pickupGroups.some(group => group.id === pickup.groupId)),
        options: data.options.filter(option => option.active && option.productAvailable && option.priceCents != null), sale: { ...data.sale, open: true } };
    }) : request('sale')).then(data => { if (active) setCatalog(data); }).catch(err => { if (active) setError(err.message); });
    load(); const timer = setInterval(load, 30000);
    return () => { active = false; clearInterval(timer); window.removeEventListener('hashchange', listener); };
  }, [preview]);
  useEffect(() => {
    if (!orderId) return undefined;
    if (!token) { setError('Open this order in the browser used for checkout, or contact the farm with your confirmation email.'); return undefined; }
    let active = true;
    const load = () => request(`orders/${orderId}`, { token }).then(data => {
      if (!active) return;
      setOrder(data);
      if (['paid', 'collected', 'refunded', 'expired'].includes(data.status)) {
        sessionStorage.removeItem('turkeyPending'); setPending(null);
      }
    }).catch(err => { if (active) setError(err.message); });
    request(`orders/${orderId}/reconcile`, { token, method: 'POST' }).catch(() => {}).finally(load);
    const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [orderId, token]);

  async function startCheckout(event, retry = false) {
    event?.preventDefault(); if (preview) return; setBusy(true); setError('');
    const body = retry && pending ? pending : { token: newToken(), customer, pickupId: Number(pickupId),
      items: items.map(item => ({ ...item, expectedPriceCents: catalog.options.find(option => option.id === item.optionId).priceCents })) };
    try {
      sessionStorage.setItem('turkeyPending', JSON.stringify(body)); setPending(body);
      const result = await request('checkout', { body });
      sessionStorage.setItem(`turkeyOrder:${result.orderId}`, JSON.stringify(body.token));
      if (result.url) window.location.assign(result.url);
      else window.location.hash = `#/turkeys?order=${result.orderId}`;
    } catch (err) { setError(`${err.message} If you already started checkout, use “Resume checkout” to retry the same order.`); }
    finally { setBusy(false); }
  }
  async function orderAction(action) {
    setBusy(true); setError('');
    try { setOrder(await request(`orders/${orderId}/${action}`, { token, method: 'POST' })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const field = (key, label, type = 'text', required = true, autoComplete = key) => <label key={key}>
    {label}<input name={key} type={type} required={required} autoComplete={autoComplete} maxLength={key === 'email' ? 254 : 200}
      value={customer[key]} onChange={event => setCustomer(prev => ({ ...prev, [key]: event.target.value }))} />
  </label>;
  return <div className="subscribe-page turkey-page">
    <DeckPageHeader navLinks={buildSubscribeNavLinks()} authLabel="Staff login" onAuthAction={() => { window.location.href = '/#/admin'; }} />
    <main>
      <section className="subscribe-hero turkey-banner">
        <img className="turkey-banner-image" src={heroImage} width="1580" height="1053" fetchPriority="high"
          alt="A flock of white and heritage turkeys in the sunshine at Deck Family Farm" />
        <div className="container">
        <div className="subscribe-hero-copy"><span className="eyebrow">Deck Family Farm · Thanksgiving</span><h1 className="subscribe-title">{sale?.title || 'Thanksgiving turkey preorders'}</h1>
          <p className="subscribe-lede">{sale?.description || 'A special gathering starts with something grown close to home.'}</p>
          {sale?.pickupDate && <p className="turkey-date">Pickup · {pickupDateLabel(sale.pickupDate)}</p>}
          {!orderId && sale?.open && !soldOut && <a className="turkey-button" href="#turkey-order" onClick={event => { event.preventDefault(); document.getElementById('turkey-order')?.scrollIntoView({ behavior: 'smooth' }); }}>Reserve your turkey <span aria-hidden="true">↗</span></a>}
        </div>
        </div>
      </section>
      <div className="turkey-content">
        {preview && <div className="turkey-alert" role="status">Staff preview of saved setup. Checkout is disabled.</div>}
        {error && <div className="turkey-alert" role="alert">{error}</div>}
        {!catalog && !error && <p role="status">Loading turkey availability…</p>}
        {orderId ? <section className="turkey-card turkey-confirmation" aria-live="polite">
          {!order ? <h2>Checking your order…</h2> : <>
            <span className="turkey-eyebrow">{order.number}</span>
            <h2>{['paid','collected'].includes(order.status) ? 'Your turkey is reserved.' : order.status === 'refunded' ? 'Your order has been refunded.' : order.status === 'expired' ? 'Your reservation has ended.' : order.status.startsWith('refund') ? 'Your refund is being reviewed.' : cancelled ? 'Checkout was not completed.' : 'Confirming your payment…'}</h2>
            <p>{['paid','collected'].includes(order.status) ? `Thank you, ${order.customer.name}. A confirmation email is on its way to ${order.customer.email}.` : order.status === 'expired' ? 'No payment was completed. You can start a new order if turkeys are still available.' : order.status === 'refunded' ? 'Your cancellation is complete.' : 'Your order is not confirmed until payment has been verified.'}</p>
            <ul className="turkey-summary">{order.items.map(item => <li key={item.optionId}><span>{item.quantity} × {item.label}</span><strong>{money(item.priceCents * item.quantity)}</strong></li>)}</ul>
            <p><strong>Total: {money(order.totalCents)}</strong></p>
            <div className="turkey-pickup-summary"><span className="turkey-eyebrow">{order.pickup.groupName}</span><h3>{order.pickup.name}</h3><p>{pickupDateLabel(order.pickup.date)}<br />{order.pickup.hours} · Pacific time<br />{order.pickup.address}</p><p>{order.pickup.instructions}</p></div>
            {['creating','reserved','review'].includes(order.status) && <div className="turkey-actions">
              {pending && <button className="turkey-button" disabled={busy} onClick={event => startCheckout(event, true)}>Resume checkout</button>}
              <button disabled={busy} onClick={() => orderAction('reconcile')}>Check payment status</button>
              <button disabled={busy} onClick={() => orderAction('cancel')}>Cancel unpaid reservation</button>
            </div>}
            {['expired','refunded'].includes(order.status) && <a className="turkey-button" href="/#/turkeys">Back to turkeys</a>}
          </>}
        </section> : catalog && <>
          {!sale.open || (soldOut && !preview) ? <section className="turkey-card"><h2>{soldOut && sale.status !== 'draft' ? 'Our turkey preorders are sold out.' : sale.status === 'draft' ? 'Preorders are coming soon.' : 'Preorders are currently closed.'}</h2><p>{sale.contactEmail ? <>For questions, email <a href={`mailto:${sale.contactEmail}`}>{sale.contactEmail}</a>.</> : 'Check back here for turkey sizes, prices, and pickup details.'}</p></section> :
            <form id="turkey-order" onSubmit={event => startCheckout(event)} className="turkey-order-layout">
              <div><div className="turkey-section-title"><span className="turkey-eyebrow">01 · Choose your turkeys</span><h2>Make room for something special.</h2><p>Fixed prices. Pay in full today, then pick up on {pickupDateLabel(sale.pickupDate)}.</p></div>
                <div className="turkey-options">{catalog.options.map(option => <article className={`turkey-card ${!option.available ? 'turkey-sold-out' : ''}`} key={option.id}>
                  {option.imageUrl && <img className="turkey-product-photo" src={option.imageUrl} alt={option.label} loading="lazy" />}
                  <h3>{option.label}</h3><ProductDescription description={option.description} /><strong className="turkey-price">{money(option.priceCents)}<small> per turkey</small></strong>
                  <div className="turkey-option-bottom"><span>{option.available > 0 ? `${option.available} available` : 'Sold out'}</span><label>Quantity<input type="number" aria-label={`${option.label} quantity`} min="0" max={Math.min(1000, option.available)} step="1" disabled={!option.available || busy} value={quantities[option.id] || 0} onChange={event => setQuantities(prev => ({ ...prev, [option.id]: event.target.value }))} /></label></div>
                </article>)}</div>
                <section className="turkey-card"><span className="turkey-eyebrow">02 · Choose your pickup</span><h2>We’ll meet you there.</h2>
                  <div className="turkey-pickups">{catalog.pickupGroups?.map(group => <fieldset className="turkey-pickup-group" key={group.id}><legend>{group.name}</legend>{catalog.pickups.filter(pickup => pickup.groupId === group.id).map(pickup => <label key={pickup.id} className="turkey-pickup-option"><input type="radio" name="pickup" value={pickup.id} required checked={String(pickupId) === String(pickup.id)} onChange={event => setPickupId(event.target.value)} /><span><strong>{pickup.name}</strong><span>{pickup.address}</span><span>{pickup.hours} · Pacific time</span><small>{pickup.instructions}</small></span></label>)}</fieldset>)}</div>
                </section>
                <section className="turkey-card"><span className="turkey-eyebrow">03 · Your details</span><h2>Who’s coming to pick up?</h2><p>We’ll email your confirmation and contact you if pickup details change.</p>
                  <div className="turkey-fields">{field('name','Full name','text',true,'name')}{field('email','Email','email',true,'email')}{field('phone','Phone','tel',true,'tel')}{field('addressLine1','Street address','text',true,'address-line1')}{field('addressLine2','Apartment / suite (optional)','text',false,'address-line2')}{field('city','City','text',true,'address-level2')}{field('state','State / province','text',true,'address-level1')}{field('postalCode','ZIP / postal code','text',true,'postal-code')}{field('country','Country code','text',true,'country')}</div>
                </section>
              </div>
              <aside className="turkey-card turkey-checkout"><span className="turkey-eyebrow">Your Thanksgiving order</span><h2>A turkey with your name on it.</h2>
                <ul className="turkey-summary">{items.map(item => <li key={item.optionId}><span>{item.quantity} × {catalog.options.find(option => option.id === item.optionId).label}</span><strong>{money(item.quantity * catalog.options.find(option => option.id === item.optionId).priceCents)}</strong></li>)}</ul>
                {!items.length && <p>Choose a turkey size to get started.</p>}<div className="turkey-total"><span>Total</span><strong>{money(total)}</strong></div>
                <p>Pickup only · {pickupDateLabel(sale.pickupDate)}</p><button className="turkey-button" type="submit" disabled={preview || busy || !items.length}>{preview ? 'Preview — checkout disabled' : busy ? 'Preparing checkout…' : 'Continue to secure payment'}</button><small>Pay securely with Stripe. No account needed. Stock is reserved while you complete payment.</small>
              </aside>
            </form>}
          {pending && <div className="turkey-card"><p>You have a checkout in progress.</p><button className="turkey-button" disabled={busy} onClick={event => startCheckout(event, true)}>Resume checkout</button></div>}
        </>}
        {!orderId && <section className="turkey-farm-story">
          <div><span className="turkey-eyebrow">A Deck Family Farm Thanksgiving</span><h2>A place at your table.</h2><p>Choose your turkey, reserve it online, and collect it at your selected pickup location. Then gather your favorite people around the table.</p></div>
          <figure className="turkey-holiday-photo">
            <img src="/images/turkey-home/holiday-turkey.jpg" loading="lazy"
              width="1500" height="1125" alt="Roasted Thanksgiving turkey on a platter with grapes, apples, and greenery" />
          </figure>
        </section>}
        <section className="turkey-footer-note"><h2>Find your pickup location.</h2><p>{(catalog?.pickups || []).map(pickup => pickup.name).join(' · ')}</p><p>For the rest of the year, explore our <a href={getSubscribeHostUrl()}>Full Farm CSA subscriptions</a>.</p></section>
      </div>
    </main><SubscribeFooter />
  </div>;
}
