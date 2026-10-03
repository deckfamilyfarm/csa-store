import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DeckPageHeader } from './DeckPageHeader.jsx';
import { SubscribeFooter } from './SubscribeFooter.jsx';
import { TurkeyShopping } from './TurkeyShopping.jsx';
import { TurkeyPickupInfo } from './TurkeyPickupInfo.jsx';
import { pickupDateLabel, turkeyPickupIntro } from './turkeyPickup.js';
import { CART_KEY, readCart, saveCart, cartLines, addToCart, turkeyRoute, turkeyLink, rememberCheckoutCart, settleCheckoutCart } from './turkeyCart.js';
import { buildSubscribeNavLinks } from './subscribeNavigation.js';
import { readOrderAccess, rememberOrderAccess } from './turkeyOrderAccess.js';
import './turkey.css';

const base = import.meta.env.VITE_API_BASE || '/api';
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
async function request(path, { body, token, method } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}/storefront/${path}`, {
      signal: controller.signal,
      method: method || (body ? 'POST' : 'GET'), cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Unable to complete your request.'), { status: response.status, checkoutRejected: data.checkoutRejected === true });
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection timed out. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); }
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
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cart, setCart] = useState(() => readCart());
  const [checking, setChecking] = useState(false);
  const checkoutBusy = useRef(false);
  const catalogVersion = useRef(0);
  const [customer, setCustomer] = useState(() => ({ ...emptyCustomer, ...storage('turkeyPending')?.customer }));
  const [pickupId, setPickupId] = useState(() => storage('turkeyPending')?.pickupId || '');
  const [order, setOrder] = useState(null);
  const [orderState, setOrderState] = useState('checking');
  const [orderRefresh, setOrderRefresh] = useState(0);
  const [pending, setPending] = useState(() => storage('turkeyPending'));
  const [route, setRoute] = useState(window.location.hash);
  const params = new URLSearchParams(route.split('?')[1] || '');
  const preview = params.get('preview') === '1';
  const orderId = params.get('order');
  const cancelled = params.get('cancelled') === '1';
  const view = turkeyRoute(route);
  const sale = catalog?.sale;
  const saleTitle = !sale?.title || sale.title.toLowerCase() === 'thanksgiving turkey preorders'
    ? 'Thanksgiving Turkey Preorders' : sale.title;
  const soldOut = catalog && catalog.options.every(option => option.available <= 0);
  const token = readOrderAccess(orderId);
  const heroImage = sale?.imageUrl || '/images/turkey-home/turkey-banner.jpg';

  const refreshCatalog = useCallback(async () => {
    const version = ++catalogVersion.current;
    setChecking(true);
    try {
      const data = await (preview ? fetch(`${base}/admin/storefront/setup`, { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}` } }).then(async response => {
      if (!response.ok) throw new Error('Sign in with Storefront Admin access to preview the sale.');
      const data = await response.json();
      const pickupGroups = data.pickupGroups.filter(group => group.active);
      return { ...data, pickupGroups, pickups: data.pickups.filter(pickup => pickup.active && pickupGroups.some(group => group.id === pickup.groupId)),
        options: data.options.filter(option => option.active && option.productAvailable && option.priceCents != null && !option.variantError), sale: { ...data.sale, open: true } };
      }) : request('sale'));
      if (version === catalogVersion.current) { setCatalog(data); setCatalogError(''); }
      return data;
    } catch (err) { if (version === catalogVersion.current) setCatalogError(err.message); throw err; }
    finally { if (version === catalogVersion.current) setChecking(false); }
  }, [preview]);
  useEffect(() => {
    const listener = () => { setRoute(window.location.hash); setOrder(null); setError(''); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    document.title = `${orderId ? 'Your turkey order' : view === 'cart' ? 'Your cart' : view === 'product' ? 'Thanksgiving Turkey' : 'Thanksgiving Turkey Preorders'} | Deck Family Farm`;
    refreshCatalog().catch(() => {});
    const timer = setInterval(() => refreshCatalog().catch(() => {}), 30000);
    return () => { ++catalogVersion.current; clearInterval(timer); };
  }, [refreshCatalog, view, orderId]);
  useEffect(() => { saveCart(cart); }, [cart]);
  useEffect(() => {
    const listener = event => { if (event.key === CART_KEY && !pending) setCart(readCart()); };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, [pending]);
  function clearPending() {
    try { sessionStorage.removeItem('turkeyPending'); } catch { /* Keep the current tab usable. */ }
    setPending(null);
  }
  function receiveOrder(data) {
    setOrder(data); setOrderState('ready');
    if (settleCheckoutCart(data)) setCart([]);
    if (['paid', 'collected', 'refunded', 'expired'].includes(data.status) && storage('turkeyPending')?.token === readOrderAccess(data.id)) clearPending();
  }
  useEffect(() => {
    if (!orderId) return undefined;
    if (!token) { setOrderState('missing'); return undefined; }
    let active = true;
    let timer;
    let requestVersion = 0;
    setOrderState('checking');
    async function load() {
      const version = ++requestVersion;
      clearTimeout(timer);
      try {
        const data = await request(`orders/${orderId}`, { token });
        if (!active || version !== requestVersion) return;
        receiveOrder(data);
        if (!['paid', 'collected', 'refunded', 'expired'].includes(data.status)) timer = setTimeout(load, 5000);
      } catch (err) {
        if (active && version === requestVersion) setOrderState([401, 403, 404].includes(err.status) ? 'missing' : 'error');
      }
    }
    // Read the receipt immediately; Stripe reconciliation must not hold up the page.
    load();
    request(`orders/${orderId}/reconcile`, { token, method: 'POST' }).then(() => {
      if (active) { clearTimeout(timer); load(); }
    }).catch(() => {});
    return () => { active = false; clearTimeout(timer); };
  }, [orderId, token, orderRefresh]);

  async function startCheckout(event, retry = false) {
    event?.preventDefault(); if (preview || checkoutBusy.current) return;
    checkoutBusy.current = true; setBusy(true); setError('');
    let body;
    try {
      if (pending && !retry) throw new Error('Resume or cancel your existing checkout before changing this order.');
      if (retry && pending) body = pending;
      else {
        const current = await refreshCatalog();
        if (!current.sale.open) throw new Error('Turkey preorders are currently closed.');
        if (!cart.length || cartLines(cart, current).some(line => line.issue)) throw new Error('Your cart has changed. Review its prices and available quantities before checkout.');
        if (!current.pickups.some(pickup => pickup.id === Number(pickupId))) throw new Error('Choose an available pickup location.');
        body = { token: newToken(), customer, pickupId: Number(pickupId), items: cart };
      }
      sessionStorage.setItem('turkeyPending', JSON.stringify(body)); setPending(body);
      const result = await request('checkout', { body });
      if (!rememberOrderAccess(result.orderId, body.token)) throw new Error('This browser could not save your checkout. Enable browser storage and resume this order.');
      rememberCheckoutCart(result.orderId, body.items);
      if (result.url) window.location.assign(result.url);
      else window.location.hash = `#/turkeys?order=${result.orderId}`;
    } catch (err) {
      if (err.checkoutRejected) { clearPending(); refreshCatalog().catch(() => {}); }
      setError(`${err.message}${body && !err.checkoutRejected ? ' Use “Resume checkout” to retry the same order.' : ''}`);
    }
    finally { checkoutBusy.current = false; setBusy(false); }
  }
  async function orderAction(action) {
    setBusy(true); setError('');
    try { receiveOrder(await request(`orders/${orderId}/${action}`, { token, method: 'POST' })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  function add(option, quantity) {
    if (pending || busy) return;
    try { setCart(addToCart(cart, option, quantity)); setError(''); window.location.hash = turkeyLink('cart', preview); }
    catch (err) { setError(err.message); }
  }
  return <div className="subscribe-page turkey-page">
    <DeckPageHeader navLinks={buildSubscribeNavLinks()} />
    <main>
      {view === 'listing' && !orderId && <section className="subscribe-hero turkey-banner">
        <img className="turkey-banner-image" src={heroImage} width="1580" height="1053" fetchPriority="high"
          alt="A flock of white and heritage turkeys in the sunshine at Deck Family Farm" />
        <div className="container">
        <div className="subscribe-hero-copy"><span className="eyebrow">Deck Family Farm · Thanksgiving</span><h1 className="subscribe-title">{saleTitle}</h1>
          <p className="subscribe-lede">{turkeyPickupIntro(sale?.description, sale?.pickupDate)}</p>
          {!orderId && sale?.open && !soldOut && <a className="turkey-button" href={turkeyLink('product', preview)}>Reserve your turkey <span aria-hidden="true">↗</span></a>}
        </div>
        </div>
      </section>}
      <div className="turkey-content">
        {preview && <div className="turkey-alert" role="status">Staff preview of saved setup. Checkout is disabled.</div>}
        {(error || (!orderId && catalogError)) && <div className="turkey-alert" role="alert">{error || catalogError}</div>}
        {!orderId && !catalog && !catalogError && <p role="status">Loading turkey availability…</p>}
        {orderId ? <section className="turkey-card turkey-confirmation" aria-live="polite">
          {(!token || ['missing', 'error'].includes(orderState)) ? <>
            <h2>We couldn’t display your order details.</h2>
            <p>{!token || orderState === 'missing' ? 'We couldn’t reconnect this page to your checkout.' : 'We couldn’t reach the store to load your order.'} This does not mean your payment failed.</p>
            <p>Check your confirmation email or contact the farm before placing another order.</p>
            <p className="turkey-order-reference">Order reference: <strong>{orderId}</strong></p>
            <div className="turkey-actions">
              <button type="button" className="turkey-button" onClick={() => setOrderRefresh(value => value + 1)}>Try again</button>
              {sale?.contactEmail && <a className="turkey-button" href={`mailto:${sale.contactEmail}?subject=${encodeURIComponent(`Turkey order ${orderId}`)}`}>Contact the farm</a>}
            </div>
          </> : !order ? <><h2>Loading your order…</h2><p>Please wait while we retrieve your confirmation.</p></> : <>
            <span className="turkey-eyebrow">{order.number}</span>
            <h2>{['paid','collected'].includes(order.status) ? 'Your turkey is reserved.' : order.status === 'refunded' ? 'Your order has been refunded.' : order.status === 'expired' ? 'Your reservation has ended.' : order.status.startsWith('refund') ? 'Your refund is being reviewed.' : cancelled ? 'Checkout was not completed.' : 'Confirming your payment…'}</h2>
            <p>{['paid','collected'].includes(order.status) ? `Thank you, ${order.customer.name}. A confirmation email is on its way to ${order.customer.email}.` : order.status === 'expired' ? 'No payment was completed. You can start a new order if turkeys are still available.' : order.status === 'refunded' ? 'Your cancellation is complete.' : 'Your order is not confirmed until payment has been verified.'}</p>
            <ul className="turkey-summary">{order.items.map(item => <li key={item.optionId}><span>{item.quantity} × {item.typeLabel && item.sizeLabel ? `${item.typeLabel}, ${item.sizeLabel}` : item.label}</span><strong>{money(item.priceCents * item.quantity)}</strong></li>)}</ul>
            <p><strong>Total: {money(order.totalCents)}</strong></p>
            <div className="turkey-pickup-summary"><span className="turkey-eyebrow">{order.pickup.groupName}</span><h3>{order.pickup.name}</h3><p>{pickupDateLabel(order.pickup.date)}<br />{order.pickup.hours} · Pacific time<br />{order.pickup.address}</p><p>{order.pickup.instructions}</p></div>
            {['creating','reserved','review'].includes(order.status) && <div className="turkey-actions">
              {pending && <button className="turkey-button" disabled={busy} onClick={event => startCheckout(event, true)}>Resume checkout</button>}
              <button disabled={busy} onClick={() => orderAction('reconcile')}>Check payment status</button>
              <button disabled={busy} onClick={() => orderAction('cancel')}>Cancel unpaid reservation</button>
            </div>}
            {['expired','refunded'].includes(order.status) && <a className="turkey-button" href={turkeyLink('cart')}>Return to cart</a>}
          </>}
        </section> : catalog && <>
          {pending && <div className="turkey-alert" role="status"><p>You have a checkout in progress. Its items are held until payment or cancellation is confirmed.</p><button className="turkey-button" disabled={busy || preview} onClick={event => startCheckout(event, true)}>Resume checkout</button></div>}
          <TurkeyShopping view={view} catalog={catalog} cart={cart} onAdd={add}
            onCartChange={next => { if (!pending && !busy) setCart(next); }} preview={preview} locked={Boolean(pending)} busy={busy}
            checking={checking || Boolean(catalogError)} customer={customer} setCustomer={setCustomer} pickupId={pickupId} setPickupId={setPickupId}
            onCheckout={startCheckout} onRefresh={() => refreshCatalog().catch(() => {})} />
        </>}
        {!orderId && view !== 'cart' && catalog && <TurkeyPickupInfo catalog={catalog} />}
      </div>
    </main><SubscribeFooter />
  </div>;
}
