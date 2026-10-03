import React, { useState } from 'react';
import { ProductDescription } from './ProductDescription.jsx';
import { cartLines, sortTurkeyOptions, turkeyLink } from './turkeyCart.js';
import { DEFAULT_TURKEY_INTRO, turkeyPickupIntro, pickupDateLabel } from './turkeyPickup.js';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const dateLabel = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function TurkeyShopping({ view, catalog, cart, onAdd, onCartChange, preview, locked, busy, checking,
  customer, setCustomer, pickupId, setPickupId, onCheckout, onRefresh }) {
  const [type, setType] = useState('');
  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const options = sortTurkeyOptions(catalog.options);
  const product = catalog.product;
  const sale = catalog.sale;
  const defaultAbout = String(product.aboutDescription || '').trim() === DEFAULT_TURKEY_INTRO;
  const selected = options.find(option => String(option.id) === variantId && option.preorderBreed === type);
  const breedOptions = options.filter(option => option.preorderBreed === type);
  const inCart = cart.find(item => item.optionId === selected?.id)?.quantity || 0;
  const remaining = Math.max(0, (selected?.available || 0) - inCart);
  const canAdd = sale.open && selected && Number.isInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= Math.min(1000 - inCart, remaining) && !locked && !busy;
  const lines = cartLines(cart, catalog);
  const total = lines.reduce((sum, line) => sum + line.quantity * (line.option?.priceCents ?? line.expectedPriceCents), 0);
  const updateLine = (id, change) => onCartChange(cart.map(item => item.optionId === id ? { ...item, ...change } : item));
  const unavailable = !sale.open ? sale.status === 'draft' ? 'Preorders are coming soon.' : 'Preorders are currently closed.'
    : !options.some(option => option.available > 0) ? 'Our turkey preorders are sold out.' : '';
  const link = page => turkeyLink(page, preview);
  const field = (key, label, autoComplete, type = 'text', required = true) => <label key={key}>{label}
    <input name={key} type={type} required={required} autoComplete={autoComplete} maxLength={key === 'email' ? 254 : 200}
      value={customer[key]} onChange={event => setCustomer(previous => ({ ...previous, [key]: event.target.value }))} />
  </label>;

  return <>
    <nav className="turkey-shop-nav" aria-label="Turkey shop">
      <a href={link('listing')} aria-current={view === 'listing' ? 'page' : undefined}>Turkey shop</a>
      <a href={link('cart')} aria-current={view === 'cart' ? 'page' : undefined}>Cart ({cart.reduce((sum, item) => sum + item.quantity, 0)})</a>
    </nav>
    {unavailable && <p className="turkey-alert" role="status">{unavailable}</p>}
    {view === 'listing' ? <section className="turkey-listing" aria-label="Turkeys for preorder">
      <article className="turkey-listing-card">
        <a href={link('product')} tabIndex={-1} aria-hidden="true"><img src={product.imageUrl} alt="" className="turkey-product-photo" /></a>
        <div><span className="turkey-eyebrow">Pasture-raised at Deck Family Farm</span><h2>{product.title}</h2>
          <ProductDescription description={turkeyPickupIntro(product.shortDescription, sale.pickupDate)} />
          {options.length > 0 && <p className="turkey-price">From {money(Math.min(...options.map(option => option.priceCents)))}</p>}
          <a className="turkey-button" href={link('product')}>Choose options <span aria-hidden="true">↗</span></a>
        </div>
      </article>
    </section> : view === 'product' ? <article className="turkey-detail">
      <a href={link('listing')} className="turkey-back-link">← Back to turkey shop</a>
      <h1>{product.title}</h1>
      <div className="turkey-detail-intro">
        <img className="turkey-detail-photo" src={selected?.imageUrl || product.imageUrl} alt={selected?.label || product.title} />
        <section><span className="turkey-eyebrow">Raised here. Shared around your table.</span><h2>About our turkeys</h2>
          <ProductDescription description={defaultAbout ? turkeyPickupIntro(product.aboutDescription, sale.pickupDate) : product.aboutDescription} />
          {!defaultAbout && sale.pickupDate && <p className="turkey-detail-pickup">Pickup · {pickupDateLabel(sale.pickupDate)} — the Saturday before Thanksgiving. See below for available pickup locations.</p>}
        </section>
      </div>
      <form className="turkey-card turkey-selections" onSubmit={event => { event.preventDefault(); if (canAdd) onAdd(selected, Number(quantity)); }}>
        <h2>Choose your turkey</h2>
        <div className="turkey-fields">
          <label>Turkey Type<select aria-label="Turkey Type" required value={type} disabled={locked || busy} onChange={event => { setType(event.target.value); setVariantId(''); setQuantity('1'); }}>
            <option value="">Choose a type</option>
            {[['broad-breasted-white','White'],['heritage','Heritage']].map(([value, label]) => {
              const available = options.some(option => option.preorderBreed === value && option.available > 0);
              return <option key={value} value={value} disabled={!available}>{label}{available ? '' : ' — unavailable'}</option>;
            })}
          </select></label>
          <label>Size<select aria-label="Size" required value={variantId} disabled={!type || locked || busy} onChange={event => { setVariantId(event.target.value); setQuantity('1'); }}>
            <option value="">{type ? 'Choose a weight range' : 'Choose a type first'}</option>
            {breedOptions.map(option => <option key={option.id} value={option.id} disabled={option.available <= 0}>{option.sizeLabel}{option.available <= 0 ? ' — sold out' : ''}</option>)}
          </select></label>
          <label>Quantity<input type="number" min="1" max={Math.min(1000 - inCart, remaining)} step="1" required value={quantity}
            disabled={!selected || !remaining || locked || busy} onChange={event => setQuantity(event.target.value)} /></label>
        </div>
        {type && breedOptions[0]?.description && <section className="turkey-breed-description"><h3>{type === 'heritage' ? 'Heritage turkeys' : 'White turkeys'}</h3><ProductDescription description={breedOptions[0].description} /></section>}
        <div className="turkey-selection-price" aria-live="polite">{selected ? <><strong className="turkey-price">{money(selected.priceCents)}<small> per turkey</small></strong>
          <p>{selected.available > 0 ? `${selected.available} available` : 'This combination is sold out.'}{inCart > 0 ? ` · ${inCart} already in your cart` : ''}</p>
        </> : <p>Choose a type and size to see price and availability.</p>}</div>
        <button className="turkey-button" disabled={!canAdd}>Add to cart</button>
      </form>
    </article> : <section className="turkey-cart-page">
      <h1>Your cart</h1><a href={link('product')} className="turkey-back-link">← Continue shopping</a>
      {!cart.length ? <div className="turkey-card"><h2>Your cart is empty.</h2><p>Choose your turkey type and weight range to get started.</p><a className="turkey-button" href={link('product')}>Choose options</a></div>
        : <form onSubmit={onCheckout} className="turkey-order-layout">
          <div>
            <section className="turkey-cart-items" aria-label="Cart items">{lines.map(line => <article className="turkey-card turkey-cart-item" key={line.optionId}>
              {line.option?.imageUrl && <img src={line.option.imageUrl} alt="" />}
              <div><h2>Thanksgiving Turkey</h2><p>{line.option ? `${line.option.typeLabel} · ${line.option.sizeLabel}` : `Unavailable turkey (reference ${line.optionId})`}</p>
                <p>{money(line.option?.priceCents ?? line.expectedPriceCents)} each</p>
                <div className="turkey-cart-controls"><label>Quantity<input aria-label={`Quantity for ${line.option ? `${line.option.typeLabel} ${line.option.sizeLabel}` : line.optionId}`}
                  type="number" min="1" max={Math.min(1000, Math.max(1, line.option?.available || 0))} step="1" value={line.quantity} disabled={locked || busy}
                  onChange={event => updateLine(line.optionId, { quantity: Math.min(1000, Math.max(1, Number(event.target.value) || 1)) })} /></label>
                  <button type="button" disabled={locked || busy} aria-label={`Remove ${line.option ? `${line.option.typeLabel} ${line.option.sizeLabel}` : line.optionId}`} onClick={() => onCartChange(cart.filter(item => item.optionId !== line.optionId))}>Remove</button>
                </div>
                {line.issue && <p role="alert" className="turkey-error">{line.issue}</p>}
                {line.priceChanged && <button type="button" disabled={locked || busy} onClick={() => updateLine(line.optionId, { expectedPriceCents: line.option.priceCents })}>Accept price of {money(line.option.priceCents)}</button>}
              </div><strong>{money(line.quantity * (line.option?.priceCents ?? line.expectedPriceCents))}</strong>
            </article>)}</section>
            <fieldset disabled={locked || busy} className="turkey-customer-form">
              <section className="turkey-card"><h2>Choose your pickup</h2><p>{dateLabel(sale.pickupDate)} · Pacific time</p>
                <div className="turkey-pickups">{catalog.pickupGroups.map(group => <fieldset className="turkey-pickup-group" key={group.id}><legend>{group.name}</legend>
                  {catalog.pickups.filter(pickup => pickup.groupId === group.id).map(pickup => <label key={pickup.id} className="turkey-pickup-option"><input type="radio" name="pickup" value={pickup.id} required checked={String(pickupId) === String(pickup.id)} onChange={event => setPickupId(event.target.value)} />
                    <span><strong>{pickup.name}</strong><span>{pickup.address}</span><span>{pickup.hours}</span><small>{pickup.instructions}</small></span>
                  </label>)}
                </fieldset>)}</div>
              </section>
              <section className="turkey-card"><h2>Your details</h2><p>We’ll email your confirmation and contact you if pickup details change.</p>
                <div className="turkey-fields">{field('name','Full name','name')}{field('email','Email','email','email')}{field('phone','Phone','tel','tel')}
                  {field('addressLine1','Street address','address-line1')}{field('addressLine2','Apartment / suite (optional)','address-line2','text',false)}
                  {field('city','City','address-level2')}{field('state','State / province','address-level1')}{field('postalCode','ZIP / postal code','postal-code')}{field('country','Country code','country')}
                </div>
              </section>
            </fieldset>
          </div>
          <aside className="turkey-card turkey-checkout"><span className="turkey-eyebrow">Your Thanksgiving order</span><h2>Order summary</h2>
            <ul className="turkey-summary">{lines.map(line => <li key={line.optionId}><span>{line.quantity} × {line.option ? `${line.option.typeLabel}, ${line.option.sizeLabel}` : 'Unavailable turkey'}</span><strong>{money(line.quantity * (line.option?.priceCents ?? line.expectedPriceCents))}</strong></li>)}</ul>
            <div className="turkey-total"><span>Total</span><strong>{money(total)}</strong></div>
            <button className="turkey-button" type="submit" disabled={preview || locked || busy || checking || !sale.open || lines.some(line => line.issue)}>{preview ? 'Preview — checkout disabled' : busy || checking ? 'Checking your cart…' : 'Continue to secure payment'}</button>
            <button type="button" className="turkey-refresh" disabled={busy || checking} onClick={onRefresh}>Refresh availability</button>
            <small>Pickup only. Pay securely with Stripe. Your turkeys are reserved when checkout starts.</small>
          </aside>
        </form>}
    </section>}
  </>;
}
