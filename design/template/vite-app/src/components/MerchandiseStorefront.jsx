import React, { useEffect, useRef, useState } from 'react';
import {DeckPageHeader} from './DeckPageHeader.jsx';
import {SubscribeFooter} from './SubscribeFooter.jsx';
import {ProductDescription} from './ProductDescription.jsx';
import {buildSubscribeNavLinks} from './subscribeNavigation.js';
import { readCart, readPending, cartKey, cartAfterPayment, rememberAccess, orderAccess, merchandiseCartLines, MERCH_CART, MERCH_PENDING } from './merchandiseCart.js';
import { CheckoutRecovery, MerchandiseCheckout, MerchandiseConfirmation, merchandiseLink, merchandiseMoney as money } from './MerchandiseCheckout.jsx';
import './merchandise.css';
const base=import.meta.env.VITE_API_BASE || '/api';
const newToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
async function request(path,{body,token,admin=false}={}) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch(`${base}/${admin?'admin/merchandise':'merchandise'}/${path}`,{signal:controller.signal,cache:'no-store',method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error || 'Unable to complete your request.'),{checkoutRejected:value.checkoutRejected===true});return value;
  } catch (error) {
    if (error.name === 'AbortError') {
      if (path === 'checkout') throw new Error('Checkout timed out. Resume the same checkout to see its status.');
      if (path === 'quote') throw new Error('Shipping took too long to calculate. Try reviewing your order again.');
      throw new Error('The store took too long to respond. Please try again.');
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
function ProductCard({product,add,disabled,preview}) {
  const [variantId,setVariantId]=useState(''),[photo,setPhoto]=useState(0);
  const variants=preview?product.variants.filter(v=>v.sourceEnabled):product.variants.filter(v=>v.retailCents!=null && (v.available!==false) && (v.enabled!==false));
  const selected=variants.find(v=>String(v.id)===(variantId || String(variants[0]?.id)));
  const matching=product.images.filter(image=>image.variantIds?.includes(selected?.id)||image.variant_ids?.includes(selected?.externalId));
  const images=matching.length?matching:product.images;
  const currentPhoto=images.length?photo%images.length:0;
  const movePhoto=direction=>setPhoto(p=>(p+direction+images.length)%images.length);
  useEffect(()=>setPhoto(0),[selected?.id]);
  return <article className="merch-card">{images.length>0&&<div className="merch-gallery" role="group" aria-roledescription="carousel" aria-label={`${product.name} photos`}
    onKeyDown={event=>{if(images.length>1&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();movePhoto(event.key==='ArrowLeft'?-1:1);}}}>
    <img src={images[currentPhoto].src} alt={`${product.name}${selected?` — ${selected.title}`:''}`} loading="lazy"/>
    {images.length>1&&<>
      <div className="merch-gallery-dots" role="group" aria-label="Choose a photo">{images.map((image,index)=><button key={`${image.src}:${index}`} type="button" aria-label={`Show photo ${index+1} of ${images.length} of ${product.name}`} aria-current={index===currentPhoto?'true':undefined} onClick={()=>setPhoto(index)}/>)}</div>
      <span className="merch-gallery-announcement" aria-live="polite" aria-atomic="true">Photo {currentPhoto+1} of {images.length}</span>
    </>}
  </div>}<h2>{product.name}</h2><div className="merch-description"><ProductDescription description={product.description}/></div>
    {variants.length?<><label>Size / color<select value={selected?.id || ''} onChange={e=>setVariantId(e.target.value)}>{variants.map(v=>{
      const price=preview?v.sellingPriceCents:v.retailCents;
      return <option key={v.id} value={v.id}>{v.title} — {price==null?'Price unavailable':money(price)}{v.available===false?' — Unavailable':''}</option>;
    })}</select></label>{preview?<p>Draft preview — not available for purchase</p>:<button disabled={disabled||!selected} onClick={()=>add(selected)}>Add to cart</button>}</>:<p>Draft — not available for purchase</p>}</article>;
}
export function MerchandiseStorefront() {
  const [route, setRoute] = useState(window.location.hash);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [cart, setCart] = useState(() => readCart(localStorage));
  const [pending, setPending] = useState(() => readPending(localStorage));
  const [quote, setQuote] = useState(null);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [orderError, setOrderError] = useState('');
  const [orderRefresh, setOrderRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [customer, setCustomer] = useState({ firstName: '', lastName: '', email: '', phone: '', addressLine1: '',
    addressLine2: '', city: '', state: '', postalCode: '', country: 'US' });
  const gate = useRef(false);
  const heading = useRef(null);
  const feedback = useRef(null);
  const previousPage = useRef(null);
  const [hashPath, search] = route.split('?');
  const params = new URLSearchParams(search);
  const preview = params.get('preview') === '1';
  const orderId = params.get('order');
  const path = (hashPath.replace(/^#/, '') || window.location.pathname).replace(/\/$/, '');
  const view = orderId ? 'order' : !preview && path === '/merchandise/cart' ? 'cart'
    : !preview && path === '/merchandise/checkout' ? 'checkout' : 'shop';
  const currentQuote = quote?.cartKey === cartKey(cart) ? quote : null;
  const isReview = view === 'checkout' && Boolean(currentQuote) && (!pending || busy);
  const title = view === 'checkout' ? isReview ? 'Review your order' : 'Checkout' : view === 'cart' ? 'Your cart'
    : view === 'order' ? 'Your order' : 'Merchandise';

  useEffect(() => {
    const changed = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | Deck Family Farm`;
    const nextPage = `${view}:${isReview}`;
    if (previousPage.current && previousPage.current !== nextPage) {
      window.scrollTo(0, 0);
      heading.current?.focus({ preventScroll: true });
    }
    previousPage.current = nextPage;
    return () => { document.title = previousTitle; };
  }, [title, view, isReview]);
  useEffect(() => {
    if (error) feedback.current?.focus();
  }, [error]);

  const catalogRequest = useRef(0);
  async function refreshCatalog() {
    const current = ++catalogRequest.current;
    try {
      const result = await request('catalog', { admin: preview, token: preview ? localStorage.getItem('adminToken') : null });
      if (catalogRequest.current === current) { setCatalog(result); setCatalogError(''); }
    } catch (failure) {
      if (catalogRequest.current === current) setCatalogError(failure.message);
    }
  }
  useEffect(() => {
    setCatalog(null);
    setCatalogError('');
    return () => { catalogRequest.current++; };
  }, [preview]);
  useEffect(() => {
    if (view !== 'order') refreshCatalog();
  }, [view, preview]);
  useEffect(() => {
    try { localStorage.setItem(MERCH_CART, JSON.stringify(cart)); }
    catch { setError('Enable browser storage to save your cart and recover your checkout.'); }
  }, [cart]);
  useEffect(() => {
    function sync(event) {
      if (event.key === MERCH_PENDING) setPending(readPending(localStorage));
      if (event.key === MERCH_CART && !readPending(localStorage)) {
        setCart(current => {
          const next = readCart(localStorage);
          return cartKey(current) === cartKey(next) ? current : next;
        });
        setQuote(null);
      }
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    if (!quote) return;
    const timeout = window.setTimeout(() => {
      setQuote(null);
      if (view === 'checkout' && !pending) setError('Your shipping quote expired. Review your order again for an updated total.');
    }, Math.max(0, quote.expiresMs - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [quote, view, pending]);
  useEffect(() => {
    setOrder(null);
    setOrderError('');
  }, [orderId]);
  useEffect(() => {
    if (!orderId) return;
    const token = orderAccess(localStorage, orderId) || (pending?.orderId === orderId ? pending.token : null);
    if (!token) {
      setOrderError('Open this page in the browser used at checkout, or contact the farm for order help.');
      return;
    }
    let active = true;
    let checking = false;
    const load = async () => {
      if (checking) return;
      checking = true;
      try {
        const value = await request(`orders/${encodeURIComponent(orderId)}`, { token });
        if (!active) return;
        setOrder(value);
        setOrderError('');
        setCart(current => cartAfterPayment(current, pending, value));
        if ((value.paid || value.status === 'expired') && pending?.orderId === value.id) {
          if (readPending(localStorage)?.token === pending.token) localStorage.removeItem(MERCH_PENDING);
          setPending(null);
        }
      } catch (failure) {
        if (active) setOrderError(failure.message);
      } finally { checking = false; }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [orderId, pending?.orderId, orderRefresh]);

  function changeLine(id, change) {
    if (pending || gate.current) return;
    setQuote(null);
    setError('');
    setCart(current => change ? current.map(row => row.variantId === id ? { ...row, ...change } : row)
      : current.filter(row => row.variantId !== id));
  }
  function add(variant, productName) {
    if (pending || gate.current || !catalog?.checkoutEnabled) return;
    const existing = cart.find(row => row.variantId === variant.id);
    if (existing?.quantity >= 20 || (!existing && cart.length >= 30)) {
      setNotice(existing ? 'You can order up to 20 of each option.' : 'Your cart holds up to 30 different options.');
      return;
    }
    setQuote(null);
    setError('');
    setCart(current => existing ? current.map(row => row.variantId === variant.id ? { ...row, quantity: row.quantity + 1 } : row)
      : [...current, { variantId: variant.id, quantity: 1, expectedPriceCents: variant.retailCents }]);
    setNotice(`${productName} added to your cart.`);
  }
  function changeCustomer(name, value) {
    setQuote(null);
    setError('');
    setCustomer(current => ({ ...current, [name]: value }));
  }
  async function action(fn) {
    if (gate.current || preview) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try { await fn(); }
    catch (failure) {
      setError(failure.message);
      if (failure.checkoutRejected) {
        const saved = readPending(localStorage);
        if (saved && saved.token === (pending?.token || quote?.token)) localStorage.removeItem(MERCH_PENDING);
        setPending(null);
        setQuote(null);
        refreshCatalog();
      }
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function calculateQuote() {
    await action(async () => {
      const token = newToken();
      const value = await request('quote', { body: { token, items: cart, customer } });
      setQuote({ ...value, token, cartKey: cartKey(cart) });
    });
  }
  async function pay() {
    await action(async () => {
      const savedCheckout = readPending(localStorage);
      if (savedCheckout && savedCheckout.token !== pending?.token) {
        setPending(savedCheckout);
        setQuote(null);
        throw new Error('A checkout is already in progress. Resume it to continue.');
      }
      if (!pending && (!quote || quote.expiresMs <= Date.now() || quote.cartKey !== cartKey(cart))) {
        setQuote(null);
        throw new Error('Review your order again to get an updated total.');
      }
      const attempt = pending || { quoteId: quote.quoteId, token: quote.token, cartKey: quote.cartKey, expiresMs: Date.now() + 7 * 86400000 };
      localStorage.setItem(MERCH_PENDING, JSON.stringify(attempt));
      setPending(attempt);
      const result = await request('checkout', { body: { quoteId: attempt.quoteId, token: attempt.token } });
      const saved = { ...attempt, orderId: result.orderId };
      rememberAccess(localStorage, result.orderId, attempt.token);
      localStorage.setItem(MERCH_PENDING, JSON.stringify(saved));
      setPending(saved);
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else {
        setQuote(null);
        window.location.hash = `#/merchandise/order?order=${encodeURIComponent(result.orderId)}`;
        setOrderRefresh(value => value + 1);
      }
    });
  }

  const lines = merchandiseCartLines(cart, catalog);
  const count = cart.reduce((sum, row) => sum + row.quantity, 0);
  return <div className="merch-store">
    <DeckPageHeader navLinks={buildSubscribeNavLinks()} />
    <main className={`container${view === 'shop' ? '' : ' merch-flow'}`}>
      {(error || orderError || (view !== 'order' && catalogError)) && <div className="merch-feedback" ref={feedback} tabIndex={-1} role="alert">{error || orderError || catalogError}</div>}
      {view === 'order' ? <MerchandiseConfirmation order={order} orderId={orderId} cancelled={params.get('cancelled') === '1'}
        error={orderError} pending={pending} busy={busy} onResume={pay} headingRef={heading} onRefresh={() => setOrderRefresh(value => value + 1)} />
        : view !== 'shop' ? (!catalog && !catalogError ? <p role="status">Loading your cart…</p>
          : !catalog ? <button type="button" onClick={refreshCatalog}>Retry loading the catalog</button>
            : <MerchandiseCheckout view={view} lines={lines} quote={currentQuote} customer={customer} regions={catalog.shippingRegions}
              checkoutEnabled={catalog.checkoutEnabled && !catalogError} busy={busy} pending={pending} headingRef={heading}
              onChangeLine={changeLine} onChangeCustomer={changeCustomer} onQuote={calculateQuote}
              onEdit={() => { setQuote(null); setError(''); }} onPay={pay} />)
          : <>
            <div className="merch-shop-heading">
              <div><p className="merch-eyebrow">Deck Family Farm</p><h1 ref={heading} tabIndex={-1}>Branded Merchandise</h1></div>
              {!preview && <a className="merch-cart-link" href={merchandiseLink('cart')}>Cart <span>{count}</span></a>}
            </div>
            {preview && <p className="merch-status">Staff preview. Disabled drafts cannot be purchased.</p>}
            {!preview && pending && <CheckoutRecovery busy={busy} onResume={pay} />}
            {!catalog && !catalogError && <p role="status">Loading merchandise…</p>}
            {catalog && !catalog.products.length && <p>Our merchandise collection is coming soon.</p>}
            {catalog?.shipsNationwide ? <p>Ships to all 50 states and Washington, D.C. Shipping is calculated at checkout.</p>
              : catalog?.shippingRegions?.length > 0 && <p>Shipping available to {catalog.shippingRegions.map(region => region === 'US:OR' ? 'Oregon' : region.replace('US:', '')).join(', ')}.</p>}
            <p className="merch-cart-notice" role="status">{!preview && notice}</p>
            <div className="merch-grid">{catalog?.products.map(product => <ProductCard key={product.id} product={product}
              add={variant => add(variant, product.name)} preview={preview}
              disabled={busy || Boolean(pending) || preview || !catalog.checkoutEnabled} />)}</div>
          </>}
    </main>
    <SubscribeFooter />
  </div>;
}
