import React,{useEffect,useRef,useState} from 'react';
import {DeckPageHeader} from './DeckPageHeader.jsx';
import {SubscribeFooter} from './SubscribeFooter.jsx';
import {ProductDescription} from './ProductDescription.jsx';
import {buildSubscribeNavLinks} from './subscribeNavigation.js';
import {readCart,readPending,cartKey,cartAfterPayment,rememberAccess,orderAccess,MERCH_CART,MERCH_PENDING} from './merchandiseCart.js';
import './merchandise.css';
const base=import.meta.env.VITE_API_BASE || '/api';
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const shippingLabel=status=>({awaiting_payment:'Waiting for payment',held_test_mode:'Test order — production disabled',held_disabled:'Awaiting farm approval',unknown:'Confirming the supplier order',failed:'Fulfillment needs staff attention',held_review:'Awaiting staff review',queued:'Preparing your merchandise order',creating:'Preparing your merchandise order',confirming:'Confirming the supplier order','on-hold':'Awaiting production approval','payment-not-received':'Awaiting supplier payment','sending-to-production':'Preparing for production','in-production':'In production',fulfilled:'Shipped',delivered:'Delivered',canceled:'Canceled',expired:'Checkout expired'})[status] || 'Waiting for a status update';
const newToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
async function request(path,{body,token,admin=false}={}) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch(`${base}/${admin?'admin/merchandise':'merchandise'}/${path}`,{signal:controller.signal,cache:'no-store',method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error || 'Unable to complete your request.'),{checkoutRejected:value.checkoutRejected===true});return value;
  }catch(error){if(error.name==='AbortError')throw new Error('The connection timed out. Recover the same checkout before starting another payment.');throw error;}finally{clearTimeout(timeout);}
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
  const [route,setRoute]=useState(window.location.hash),[catalog,setCatalog]=useState(null),[cart,setCart]=useState(()=>readCart(localStorage)),[pending,setPending]=useState(()=>readPending(localStorage)),[quote,setQuote]=useState(null),[order,setOrder]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [customer,setCustomer]=useState({firstName:'',lastName:'',email:'',phone:'',addressLine1:'',addressLine2:'',city:'',state:'OR',postalCode:'',country:'US'});
  const gate=useRef(false),params=new URLSearchParams(route.split('?')[1] || ''),preview=params.get('preview')==='1',orderId=params.get('order');
  useEffect(()=>{const previous=document.title;document.title='Deck Family Farm Merchandise';return()=>{document.title=previous;};},[]);
  useEffect(()=>{const changed=()=>setRoute(window.location.hash);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  useEffect(()=>{request('catalog',{admin:preview,token:preview?localStorage.getItem('adminToken'):null}).then(setCatalog).catch(e=>setError(e.message));},[preview]);
  useEffect(()=>{try{localStorage.setItem(MERCH_CART,JSON.stringify(cart));}catch{setError('Browser storage is unavailable. Enable it before checkout so order access can be recovered.');}},[cart]);
  useEffect(()=>{
    if(!orderId)return;const token=orderAccess(localStorage,orderId) || (pending?.orderId===orderId?pending.token:null);
    if(!token){setError('Order access is missing. Open this page in the browser used at checkout, or contact the farm with your order number.');return;}
    let active=true;const load=()=>request(`orders/${encodeURIComponent(orderId)}`,{token}).then(value=>{if(!active)return;setOrder(value);setError('');setCart(c=>cartAfterPayment(c,pending,value));if((value.paid||value.status==='expired') && pending?.orderId===value.id){localStorage.removeItem(MERCH_PENDING);setPending(null);}}).catch(e=>{if(active)setError(e.message);});
    load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer);};
  },[orderId,pending?.orderId]);
  function add(v){if(pending)return;setQuote(null);setCart(c=>{const old=c.find(row=>row.variantId===v.id);return old?c.map(row=>row.variantId===v.id?{...row,quantity:Math.min(20,row.quantity+1),expectedPriceCents:v.retailCents}:row):[...c,{variantId:v.id,quantity:1,expectedPriceCents:v.retailCents}];});}
  async function action(fn){if(gate.current)return;gate.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);if(e.checkoutRejected){localStorage.removeItem(MERCH_PENDING);setPending(null);setQuote(null);}}finally{gate.current=false;setBusy(false);}}
  async function pay(){await action(async()=>{
    const attempt=pending || {quoteId:quote.quoteId,token:quote.token,cartKey:cartKey(cart),expiresMs:Date.now()+7*86400000};
    localStorage.setItem(MERCH_PENDING,JSON.stringify(attempt));setPending(attempt);
    const result=await request('checkout',{body:{quoteId:attempt.quoteId,token:attempt.token}});
    const saved={...attempt,orderId:result.orderId};rememberAccess(localStorage,result.orderId,attempt.token);localStorage.setItem(MERCH_PENDING,JSON.stringify(saved));setPending(saved);
    if(result.checkoutUrl)window.location.assign(result.checkoutUrl);else window.location.hash=`#/merchandise/order?order=${result.orderId}`;
  });}
  const allVariants=(catalog?.products || []).flatMap(p=>p.variants.map(v=>({...v,productName:p.name})));
  return <div className="merch-store"><DeckPageHeader navLinks={buildSubscribeNavLinks()}/><main className="container"><p className="merch-eyebrow">Deck Family Farm</p><h1>Branded Merchandise</h1>
    {preview&&<p className="merch-status">Staff preview. Disabled drafts cannot be purchased.</p>}{error&&<p role="alert">{error}</p>}
    {orderId?<section><h2>{order?.number || 'Your merchandise order'}</h2>{order?<><p>{order.mode==='test'?'Test order · ':''}{order.status==='expired'?'Checkout expired. No payment was confirmed.':order.paid?'Payment received.':'We’re confirming your payment.'}</p><p>Total {money(order.totalCents)} · Shipping {money(order.shippingCents)} · Tax {money(order.taxCents)}</p>
      {order.items.map((row,i)=><p key={i}>{row.quantity} × {row.name} · {row.title}</p>)}{order.fulfillments.map(f=><div key={f.id}><h3>Shipping status: {shippingLabel(f.status)}</h3>{f.tracking.map((t,i)=><p key={i}>{t.carrier} {t.url?<a href={t.url} target="_blank" rel="noreferrer">{t.number || 'Track shipment'}</a>:t.number}{t.deliveredAt?' · Delivered':''}</p>)}</div>)}<p>Merchandise ships separately from farm pickup and delivery orders.</p></>:!error?<p>Checking order status…</p>:null}<a href="/#/merchandise">Back to merchandise</a></section>:<>
      {!catalog&&!error&&<p>Loading merchandise…</p>}{catalog&&!catalog.products.length&&<p>Our merchandise collection is coming soon.</p>}
      {catalog?.shipsNationwide?<p>Ships to all 50 states and Washington, D.C. Shipping is calculated at checkout.</p>:catalog?.shippingRegions?.length>0&&<p>Shipping available to {catalog.shippingRegions.map(region=>region==='US:OR'?'Oregon':region.replace('US:','')).join(', ')}.</p>}
      <div className="merch-grid">{catalog?.products.map(p=><ProductCard key={p.id} product={p} add={add} preview={preview} disabled={busy||Boolean(pending)||preview||!catalog.checkoutEnabled}/>)}</div>
      {cart.length>0&&<section className="merch-checkout"><h2>Your merchandise cart</h2>{cart.map(row=>{const variant=allVariants.find(v=>v.id===row.variantId);return <div key={row.variantId} className="merch-cart-row"><span>{variant?`${variant.productName} · ${variant.title}`:'Variant no longer available'} · {money(row.expectedPriceCents)}</span><label>Quantity<input type="number" min="1" max="20" value={row.quantity} disabled={busy||Boolean(pending)} onChange={e=>{const quantity=Number(e.target.value);if(Number.isInteger(quantity)&&quantity>=1&&quantity<=20){setQuote(null);setCart(c=>c.map(r=>r.variantId===row.variantId?{...r,quantity}:r));}}}/></label><button disabled={busy||Boolean(pending)} onClick={()=>{setQuote(null);setCart(c=>c.filter(r=>r.variantId!==row.variantId));}}>Remove</button></div>;})}
        <p>Merchandise ships to your address. Farm delivery discounts do not apply.</p>
        <form onSubmit={e=>{e.preventDefault();action(async()=>{const token=newToken();const value=await request('quote',{body:{token,items:cart,customer}});setQuote({...value,token});});}}>
          <div className="merch-address">{Object.keys(customer).map(key=><label key={key}>{({firstName:'First name',lastName:'Last name',addressLine1:'Street address',addressLine2:'Apartment / suite',postalCode:'ZIP code',state:'State',country:'Country'})[key] || key[0].toUpperCase()+key.slice(1)}<input name={key} type={key==='email'?'email':'text'} required={key!=='addressLine2'} disabled={busy||Boolean(pending)||key==='country'} value={customer[key]} maxLength={['state','country'].includes(key)?2:200} onChange={e=>{setQuote(null);setCustomer(c=>({...c,[key]:e.target.value}));}}/></label>)}</div>
          <button disabled={busy||Boolean(pending)||!catalog?.checkoutEnabled}>Calculate shipping and tax</button>
        </form>
        {quote&&<div><p>Items {money(quote.subtotalCents)} · Shipping {money(quote.shippingCents)} · Tax {money(quote.tax.cents)}</p><strong>Total {money(quote.totalCents)}</strong><p>Quote valid until {new Date(quote.expiresMs).toLocaleTimeString()}.</p><button disabled={busy||!catalog?.checkoutEnabled} onClick={pay}>Continue to Stripe</button></div>}
      </section>}
      {pending&&<section className="merch-checkout"><h2>Recover your checkout</h2><p>A checkout attempt is saved in this browser. Recover it before starting another payment.</p><button disabled={busy} onClick={pay}>Recover the same checkout</button></section>}
    </>}
  </main><SubscribeFooter/></div>;
}
