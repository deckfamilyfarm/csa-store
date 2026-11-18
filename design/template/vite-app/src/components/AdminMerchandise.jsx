import React,{useEffect,useState} from 'react';
import {adminGet,adminPut,adminPost} from '../adminApi.js';
import './merchandise.css';
const money=value=>value==null?'Not recorded':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
function Editor({product,vendors,token,onSaved,onAction}) {
  const [draft,setDraft]=useState(product),[showAll,setShowAll]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [priceInputs,setPriceInputs]=useState({});
  const [dirty,setDirty]=useState(false);
  useEffect(()=>{setDraft(product);setDirty(false);},[product]);
  const change=(key,value)=>{setDraft(d=>({...d,[key]:value}));setDirty(true);};
  const variant=(id,values)=>{setDraft(d=>({...d,variants:d.variants.map(v=>v.id===id?{...v,...values}:v)}));setDirty(true);};
  const availableVariants = draft.variants.filter(v=>v.canSell);
  const allAvailableSelected = availableVariants.length>0 && availableVariants.every(v=>v.enabled);
  const someAvailableSelected = availableVariants.some(v=>v.enabled);
  function sellAllVariants(enabled) {
    setDraft(d=>({...d,variants:d.variants.map(v=>({...v,enabled:enabled && v.canSell}))}));
    setDirty(true);
  }
  async function save(){setBusy(true);setError('');try{
    const prices=Object.fromEntries(Object.entries(priceInputs).map(([id,value])=>{
      if(value!==''&&!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Enter retail prices with at most two decimal places.');
      return [id,value===''?null:Math.round(Number(value)*100)];
    }));
    const saved=await adminPut(`merchandise/products/${product.id}`,token,{version:draft.version,vendorId:draft.vendorId,active:draft.active,artworkReviewed:draft.artworkReviewed,currency:draft.currency,
      variants:draft.variants.map(v=>({id:v.id,enabled:v.enabled,retailCents:Object.hasOwn(prices,v.id)?prices[v.id]:v.retailCents}))});onSaved(saved);
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  return <details className="merch-editor"><summary>{product.name} · {product.active?'Listed':'Draft'} · {product.variants.filter(v=>v.sourceEnabled).length} supplier-enabled variants</summary>
    {error&&<p role="alert">{error}</p>}
    <div className="merch-product-heading">{product.images[0]&&<img src={product.images[0].src} alt={product.name} loading="lazy"/>}
      <div><p>{product.provider || 'Supplier catalog unavailable'} · Shop {product.shopId} · {product.externalId}</p><p>{product.holds.join(' ')}</p>
      <label>Local vendor<select value={draft.vendorId || ''} onChange={e=>change('vendorId',Number(e.target.value))}><option value="">Choose an existing vendor</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <p>Supplier visibility: {product.sourceVisible?'Visible':'Hidden'}. Default prices add 40% to Printify production cost, with a $10.00 minimum.</p>
      <label><input type="checkbox" checked={draft.artworkReviewed} onChange={e=>change('artworkReviewed',e.target.checked)}/> I reviewed the artwork, placements and any generated layers for these existing supplier products.</label>
      <label><input type="checkbox" checked={draft.currency==='USD'} onChange={e=>change('currency',e.target.checked?'USD':null)}/> I confirmed the supplier money values are USD.</label>
      <label><input type="checkbox" checked={draft.active} onChange={e=>change('active',e.target.checked)}/> Show this product in the CSA Store</label></div></div>
    <div className="merch-actions">
      <label><input type="checkbox" checked={allAvailableSelected} disabled={!availableVariants.length || busy}
        ref={input=>{if(input)input.indeterminate=someAvailableSelected && !allAvailableSelected;}}
        onChange={e=>sellAllVariants(e.target.checked)}/> Sell all available variants ({availableVariants.length})</label>
      <label><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/> Show all source variants, including disabled options</label>
    </div>
    <p>Leave Modified Price blank to use the Default price.</p>
    <div className="merch-table-scroll"><table><thead><tr><th>Variant</th><th>Supplier</th><th>Cost</th><th>Saved channel price</th><th>Default</th><th>Modified Price</th><th>Sell this variant</th></tr></thead>
      <tbody>{draft.variants.filter(v=>showAll||v.sourceEnabled||v.enabled).map(v=><tr key={v.id}>
        <td>{v.title}<small>{v.sku}</small></td>
        <td>{!v.sourceEnabled?'Not enabled':!v.available?'Unavailable':v.canSell?'Available':'Needs supplier review'}</td>
        <td>{money(v.costCents)}</td><td>{money(v.channelPriceCents)}</td><td>{money(v.proposedRetailCents)}</td>
        <td><input aria-label={`${v.title} modified price in dollars`} type="text" inputMode="decimal"
          value={priceInputs[v.id]??(v.retailCents==null?'':(v.retailCents/100).toFixed(2))}
          onChange={e=>{setPriceInputs(inputs=>({...inputs,[v.id]:e.target.value}));setDirty(true);}}/></td>
        <td><input aria-label={`Sell ${v.title} in the CSA Store`} type="checkbox" disabled={(!v.canSell && !v.enabled) || busy}
          checked={v.enabled} onChange={e=>variant(v.id,{enabled:e.target.checked})}/></td>
      </tr>)}</tbody></table></div>
    <div className="merch-actions"><button type="button" disabled={busy} onClick={save}>{busy?'Saving…':'Save merchandise settings'}</button>
      <button type="button" disabled={busy||dirty} onClick={()=>onAction(()=>adminPost(`merchandise/products/${product.id}/refresh`,token,{}))}>Refresh supplier information</button><span>{dirty?'Save local edits before refreshing.':'A supplier change disables the product for review and preserves modified prices.'}</span></div>
  </details>;
}
export function AdminMerchandise({token}) {
  const [catalog,setCatalog]=useState(null),[data,setData]=useState({orders:[],report:[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[review,setReview]=useState(null),[notice,setNotice]=useState('');
  async function load(){const [c,o]=await Promise.all([adminGet('merchandise/catalog',token),adminGet('merchandise/orders',token)]);setCatalog(c);setData(o);}
  useEffect(()=>{load().catch(e=>setError(e.message));},[token]);
  async function action(fn){setBusy(true);setError('');setNotice('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function reviewOperation(order,kind){await action(async()=>setReview({order,...await adminPost(`merchandise/orders/${order.id}/operations/review`,token,{kind})}));}
  return <section className="admin-section merch-admin"><h2>Branded Merchandise</h2><p>Printify fulfillment ships separately from farm orders. Product saves affect CSA Store only.</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!catalog?<p>Merchandise setup is loading. If a migration is required, run the explicit merchandise migration documented in the repository.</p>:<>
      <p className="merch-status">Stripe mode: {catalog.mode}. Checkout: {catalog.checkoutEnabled?'Enabled':'Disabled'}. Live checkout: {catalog.controls.liveCheckout?'Enabled':'Disabled'}. Printify orders: {catalog.controls.supplierOrders?'Enabled':'Disabled'}. Production: {catalog.controls.production?'Enabled':'Disabled'}.</p>
      <p><a href="/#/merchandise?preview=1" target="_blank" rel="noreferrer">Preview merchandise catalog</a></p>
      {catalog.products.map(product=><Editor key={`${product.id}:${product.version}`} product={product} vendors={catalog.vendors} token={token} onSaved={saved=>setCatalog(c=>({...c,products:c.products.map(p=>p.id===saved.id?saved:p)}))} onAction={action}/>)}
      <h3>Financial reporting</h3><p>Test and live orders are reported separately. Profit is estimated until supplier costs and Stripe fees are confirmed.</p>
      <div className="merch-table-scroll"><table><thead><tr><th>Mode</th><th>Paid orders</th><th>Gross sales</th><th>Shipping charged</th><th>Tax collected</th><th>Production cost</th><th>Shipping cost</th><th>Supplier tax</th><th>Known Stripe fees</th><th>Refunds</th><th>Estimated gross profit</th></tr></thead><tbody>{data.report.map(r=><tr key={r.mode}><td>{r.mode}</td><td>{r.paidOrders}</td><td>{money(r.grossSalesCents)}</td><td>{money(r.shippingChargedCents)}</td><td>{money(r.taxCollectedCents)}</td><td>{money(r.productionCostCents)}</td><td>{money(r.shippingCostCents)}</td><td>{money(r.supplierTaxCents)}</td><td>{money(r.knownStripeFeesCents)} ({r.missingStripeFees} missing)</td><td>{money(r.refundsCents)}</td><td>{money(r.estimatedGrossProfitCents)} ({r.estimatedCostOrders} estimated costs)</td></tr>)}</tbody></table></div>
      <h3>Merchandise orders</h3>{!data.orders.length&&<p>No merchandise orders yet.</p>}
      {data.orders.map(order=><details key={order.id} className="merch-editor"><summary>{order.number} · {order.mode} · {order.status} · {money(order.totalCents)}</summary>
        {!order.stripeSessionId&&<form onSubmit={e=>{e.preventDefault();const sessionId=new FormData(e.currentTarget).get('sessionId');action(()=>adminPost(`merchandise/orders/${order.id}/stripe-session`,token,{sessionId}));}}><label>Recover the original Stripe Checkout Session ID <input name="sessionId" required placeholder="cs_test_…"/></label><button disabled={busy}>Verify and attach original session</button></form>}
        <p>{order.address.first_name} {order.address.last_name} · {order.address.email}</p><p>{order.address.address1}, {order.address.city}, {order.address.region} {order.address.zip}</p>
        <p>Payment: {order.stripePaymentId || 'Not received'} · Refunds: {money(order.refundedCents)} · Fee: {money(order.stripeFeeCents)}</p>{order.financialHold&&<p role="alert">Financial review holds new supplier submissions.</p>}
        {order.fulfillments.map(f=><div key={f.id}><p>Printify: {f.status} · {f.remoteId || 'No supplier order'} · {f.lastError}</p><p>Actual production: {money(f.actualCostCents)}; shipping: {money(f.actualShippingCents)}; supplier tax: {money(f.actualTaxCents)}</p>
          {f.tracking.map((t,i)=><p key={i}>{t.carrier} {t.url?<a href={t.url} target="_blank" rel="noreferrer">{t.number || 'Track shipment'}</a>:t.number}{t.deliveredAt?' · Delivered':''}</p>)}
          <button disabled={busy||!order.paid} onClick={()=>action(()=>adminPost(`merchandise/fulfillments/${f.id}/retry`,token,{}))}>Reconcile / retry fulfillment</button></div>)}
        <div className="merch-actions"><button disabled={busy||!order.paid} onClick={()=>reviewOperation(order,'refund')}>Review remaining payment refund</button><button disabled={busy||!order.paid} onClick={()=>reviewOperation(order,'cancel')}>Review supplier cancellation</button><button disabled={busy||!order.paid} onClick={()=>reviewOperation(order,'production')}>Review production release</button><button disabled={busy||!order.paid} onClick={()=>action(()=>adminPost(`merchandise/orders/${order.id}/fees`,token,{}))}>Refresh Stripe fee</button>
          <button disabled={busy||!order.paid} onClick={()=>action(async()=>{const result=await adminPost(`merchandise/orders/${order.id}/refunds/reconcile`,token,{});setNotice(JSON.stringify(result));})}>Check Stripe refund receipts</button>
          {order.financialHold&&<button disabled={busy} onClick={()=>action(()=>adminPost(`merchandise/orders/${order.id}/refunds/reconcile`,token,{acknowledgeExternal:true}))}>Acknowledge reviewed external refund receipts</button>}
        </div><p>{order.lastError}</p>{order.operations.map(op=><p key={op.id}>{op.kind}: {op.status} {op.lastError}</p>)}</details>)}
      {review&&<div role="dialog" aria-modal="true" aria-label="Review merchandise operation" className="merch-review"><h3>Review {review.kind}: {review.order.number}</h3><p>{review.kind==='refund'?`Refund the remaining ${money(review.amountCents)}. This does not cancel Printify production.`:review.kind==='cancel'?'Request supplier cancellation. This does not refund the customer.':'Send the supplier order to production. This can cause real charges when production controls are enabled.'}</p><pre>{JSON.stringify(review.request,null,2)}</pre><p>Status: {review.status}. An uncertain retry reconciles the original request.</p><button disabled={busy} onClick={()=>action(async()=>{await adminPost(`merchandise/orders/${review.order.id}/operations/${review.id}/confirm`,token,{});setReview(null);})}>Confirm reviewed operation</button><button onClick={()=>setReview(null)}>Close</button></div>}
    </>}
  </section>;
}
