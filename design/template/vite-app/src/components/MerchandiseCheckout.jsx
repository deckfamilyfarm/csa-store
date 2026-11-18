import React from 'react';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const merchandiseMoney = cents => currency.format(cents / 100);
export const merchandiseLink = (page = '') => `/#/merchandise${page ? `/${page}` : ''}`;

const states = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming']
];
const stateNames = new Map(states);

function Progress({ view, review }) {
  return <nav className="merch-progress" aria-label="Checkout progress">
    <ol>
      <li>{view === 'cart' ? <span aria-current="step">Cart</span> : <a href={merchandiseLink('cart')}>Cart</a>}</li>
      <li><span aria-current={view === 'checkout' && !review ? 'step' : undefined}>Shipping details</span></li>
      <li><span aria-current={review ? 'step' : undefined}>Review &amp; pay</span></li>
    </ol>
  </nav>;
}

function ItemPhoto({ src }) {
  return <span className="merch-item-photo" aria-hidden="true">{src && <img src={src} alt="" />}</span>;
}

function CartLine({ line, locked, onChange }) {
  const { variant, quantity, expectedPriceCents } = line;
  const name = variant?.productName || 'Unavailable item';
  const description = variant ? `${name}, ${variant.title}` : name;
  return <li className="merch-cart-line">
    <ItemPhoto src={variant?.imageUrl} />
    <div className="merch-cart-line-details">
      <h2>{name}</h2>
      {variant && <p>{variant.title}</p>}
      <p>{merchandiseMoney(expectedPriceCents)} each</p>
      {line.unavailable && <p className="merch-item-issue">Remove this item to check out.</p>}
      {line.issue === 'supplier_review' && <p className="merch-item-issue">This item needs a stock or design review. Remove it to continue.</p>}
      {line.issue === 'verification_unavailable' && <p className="merch-item-issue">Availability couldn’t be confirmed. Recheck or remove this item.</p>}
      {line.priceChanged && <p className="merch-item-issue">
        Price changed. <button className="merch-text-button" type="button" disabled={locked}
          onClick={() => onChange({ expectedPriceCents: line.currentPriceCents })}>
          Update to {merchandiseMoney(line.currentPriceCents)}
        </button>
      </p>}
      <div className="merch-quantity-row">
        <div className="merch-quantity" role="group" aria-label={`Quantity for ${description}`}>
          <button type="button" disabled={locked || quantity <= 1} aria-label={`Decrease quantity for ${description}`} onClick={() => onChange({ quantity: quantity - 1 })}>−</button>
          <span aria-live="polite">{quantity}</span>
          <button type="button" disabled={locked || quantity >= 20 || line.unavailable} aria-label={`Increase quantity for ${description}`} onClick={() => onChange({ quantity: quantity + 1 })}>+</button>
        </div>
        <button className="merch-text-button" type="button" disabled={locked} aria-label={`Remove ${description}`} onClick={() => onChange(null)}>Remove</button>
      </div>
    </div>
    <strong className="merch-cart-line-total">{merchandiseMoney(expectedPriceCents * quantity)}</strong>
  </li>;
}

function DetailsForm({ customer, onChange, regions, busy }) {
  function field(name, label, autoComplete, options = {}) {
    return <label className={`merch-field${options.wide ? ' merch-field-wide' : ''}`}>
      <span>{label}</span>
      <input name={name} value={customer[name]} onChange={event => onChange(name, event.target.value)}
        required={options.required !== false} type={options.type || 'text'} autoComplete={autoComplete}
        maxLength={options.maxLength || 200} pattern={options.pattern} inputMode={options.inputMode} />
    </label>;
  }
  const choices = regions?.length ? regions.map(region => {
    const code = region.replace('US:', '');
    return [code, stateNames.get(code) || code];
  }).sort((a, b) => a[1].localeCompare(b[1])) : states;
  return <fieldset disabled={busy} className="merch-form-fields" aria-label="Contact and shipping details">
    <section className="merch-panel" aria-labelledby="merch-contact-heading">
      <h2 id="merch-contact-heading">Contact</h2>
      <p className="merch-panel-note">We’ll send your order confirmation and shipping updates by email.</p>
      <div className="merch-fields">
        {field('email', 'Email address', 'email', { type: 'email', maxLength: 254 })}
        {field('phone', 'Phone number', 'tel', { type: 'tel', maxLength: 40 })}
      </div>
    </section>
    <section className="merch-panel" aria-labelledby="merch-address-heading">
      <h2 id="merch-address-heading">Shipping address</h2>
      <div className="merch-fields">
        <label className="merch-field merch-field-wide"><span>Country</span><input value="United States" readOnly autoComplete="country-name" /></label>
        {field('firstName', 'First name', 'shipping given-name', { maxLength: 80 })}
        {field('lastName', 'Last name', 'shipping family-name', { maxLength: 80 })}
        {field('addressLine1', 'Street address', 'shipping address-line1', { wide: true })}
        {field('addressLine2', 'Apartment or suite (optional)', 'shipping address-line2', { wide: true, required: false })}
        {field('city', 'City', 'shipping address-level2', { maxLength: 100 })}
        <div className="merch-state-zip">
          <label className="merch-field"><span>State</span><select required name="state" value={customer.state} autoComplete="shipping address-level1"
            onChange={event => onChange('state', event.target.value)}>
            <option value="">Select state</option>
            {choices.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select></label>
          {field('postalCode', 'ZIP code', 'shipping postal-code', { maxLength: 10, inputMode: 'numeric', pattern: '[0-9]{5}(-[0-9]{4})?' })}
        </div>
      </div>
    </section>
  </fieldset>;
}

function OrderSummary({ lines, quote, showItems, children }) {
  const subtotal = quote?.subtotalCents ?? lines.reduce((sum, line) => sum + line.expectedPriceCents * line.quantity, 0);
  return <aside className="merch-panel merch-summary" aria-labelledby="merch-summary-heading">
    <h2 id="merch-summary-heading">Order summary</h2>
    {showItems && <ul className="merch-summary-items">
      {lines.map(line => <li key={line.variantId}>
        <ItemPhoto src={line.variant?.imageUrl} />
        <div><strong>{line.variant?.productName || 'Unavailable item'}</strong><small>{line.variant?.title} · Qty {line.quantity}</small></div>
        <span>{merchandiseMoney(line.expectedPriceCents * line.quantity)}</span>
      </li>)}
    </ul>}
    <dl className="merch-totals" aria-live="polite">
      <div><dt>Subtotal</dt><dd>{merchandiseMoney(subtotal)}</dd></div>
      <div><dt>Shipping</dt><dd>{quote ? merchandiseMoney(quote.shippingCents) : 'Calculated at checkout'}</dd></div>
      <div><dt>Tax</dt><dd>{quote ? merchandiseMoney(quote.tax.cents) : 'Calculated at checkout'}</dd></div>
      <div className="merch-grand-total"><dt>{quote ? 'Total' : 'Estimated total'}</dt><dd>{merchandiseMoney(quote?.totalCents ?? subtotal)}</dd></div>
    </dl>
    {children}
  </aside>;
}

export function CheckoutRecovery({ busy, onResume }) {
  return <section className="merch-panel merch-recovery">
    <h2>Resume checkout</h2>
    <p>Return to your saved checkout to pay or see its status.</p>
    <button className="merch-primary" type="button" disabled={busy} onClick={onResume}>{busy ? 'Reopening checkout…' : 'Resume checkout'}</button>
  </section>;
}

export function MerchandiseCheckout({ view, lines, customer, regions, quote, checkoutEnabled, busy, pending,
  reviewState, reviewMessage, onRecheck, onChangeLine, onChangeCustomer, onQuote, onEdit, onPay, headingRef }) {
  const review = view === 'checkout' && Boolean(quote) && (!pending || busy);
  const needsReview = lines.some(line => line.unavailable || line.priceChanged || line.issue);
  const canContinue = checkoutEnabled && lines.length > 0 && !needsReview && reviewState === 'ready';
  const checking = reviewState === 'checking';
  const canRecheck = reviewState === 'error' || lines.some(line => line.issue === 'verification_unavailable');
  const title = view === 'cart' ? 'Your cart' : review ? 'Review your order' : 'Checkout';
  return <>
    <Progress view={view} review={review} />
    <div className="merch-flow-heading">
      <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
      <a className="merch-back-link" href={merchandiseLink(view === 'cart' ? '' : 'cart')}>← {view === 'cart' ? 'Continue shopping' : 'Back to cart'}</a>
    </div>
    {pending && !review && <CheckoutRecovery busy={busy} onResume={onPay} />}
    {lines.length === 0 ? <section className="merch-panel merch-empty">
      <h2>Your cart is empty</h2>
      <a className="merch-primary" href={merchandiseLink()}>Shop merchandise</a>
    </section> : view === 'cart' ? <div className="merch-order-layout">
      <section className="merch-panel" aria-label="Cart items"><ul className="merch-cart-items">
        {lines.map(line => <CartLine key={line.variantId} line={line} locked={busy || Boolean(pending)} onChange={change => onChangeLine(line.variantId, change)} />)}
      </ul></section>
      <OrderSummary lines={lines}>
        {!pending && (canContinue && !busy ? <a className="merch-primary merch-fullwidth" href={merchandiseLink('checkout')}>Continue to checkout</a>
          : <button className="merch-primary merch-fullwidth" disabled>{checking ? 'Checking availability…' : 'Continue to checkout'}</button>)}
        {needsReview && <p className="merch-panel-note">Review the items in your cart before checking out.</p>}
        {reviewMessage && <p className="merch-panel-note" role="alert">{reviewMessage}</p>}
        {canRecheck && <button className="merch-text-button" type="button" onClick={onRecheck}>Recheck availability</button>}
        {!checkoutEnabled && <p className="merch-panel-note">Checkout is currently unavailable.</p>}
      </OrderSummary>
    </div> : pending && !review ? null : checking && !review ? <section className="merch-panel" role="status">Checking cart availability…</section>
    : !canContinue && !review ? <section className="merch-panel">
      <h2>Review your cart</h2><p>Confirm item availability and prices before entering your shipping details.</p><a className="merch-primary" href={merchandiseLink('cart')}>Return to cart</a>
    </section> : <form className="merch-order-layout" onSubmit={event => { event.preventDefault(); if (canContinue && !busy) (review ? onPay : onQuote)(); }}>
      {review ? <div className="merch-review-details">
        <section className="merch-panel">
          <div className="merch-panel-heading"><h2>Contact</h2><button className="merch-text-button" type="button" disabled={busy} onClick={onEdit}>Edit details</button></div>
          <p>{quote.address.email}<br />{quote.address.phone}</p>
        </section>
        <section className="merch-panel">
          <h2>Ship to</h2>
          <address>{quote.address.first_name} {quote.address.last_name}<br />{quote.address.address1}<br />
            {quote.address.address2 && <>{quote.address.address2}<br /></>}{quote.address.city}, {quote.address.region} {quote.address.zip}<br />United States</address>
          <div className="merch-shipping-method"><strong>Standard shipping</strong><span>{merchandiseMoney(quote.shippingCents)}</span></div>
        </section>
      </div> : <DetailsForm customer={customer} onChange={onChangeCustomer} regions={regions} busy={busy || !checkoutEnabled} />}
      <OrderSummary lines={lines} quote={quote} showItems>
        <button className="merch-primary merch-fullwidth" disabled={busy || !canContinue} type="submit">
          {review ? (busy ? 'Opening payment…' : 'Continue to payment') : (busy ? 'Calculating shipping…' : 'Review order')}
        </button>
        {review && <p className="merch-payment-note">Secure payment with Stripe</p>}
        {!checkoutEnabled && <p className="merch-panel-note">Checkout is currently unavailable.</p>}
      </OrderSummary>
    </form>}
  </>;
}

const fulfillmentLabels = {
  awaiting_payment: 'Waiting for payment', held_test_mode: 'Test order', held_disabled: 'Awaiting farm approval',
  unknown: 'Confirming the supplier order', failed: 'Fulfillment needs staff attention', held_review: 'Awaiting staff review',
  queued: 'Preparing your order', creating: 'Preparing your order', confirming: 'Confirming the supplier order',
  'on-hold': 'Awaiting production approval', 'payment-not-received': 'Awaiting supplier payment',
  'sending-to-production': 'Preparing for production', 'in-production': 'In production',
  fulfilled: 'Shipped', delivered: 'Delivered', canceled: 'Canceled', expired: 'Checkout expired'
};

export function MerchandiseConfirmation({ order, orderId, cancelled, error, pending, busy, onResume, onRefresh, headingRef }) {
  const expired = order?.status === 'expired';
  const refunded = order?.paid && order.refundedCents >= order.totalCents;
  const canResume = pending?.orderId === orderId && !order?.paid && !expired;
  const title = expired ? 'Checkout expired' : refunded ? 'Order refunded' : order?.paid ? 'Order confirmed'
    : cancelled ? 'Checkout was interrupted' : order ? 'Confirming your payment' : error ? 'Order details unavailable' : 'Loading your order';
  return <section className="merch-panel merch-confirmation">
    {order?.number && <p className="merch-order-number">{order.number}{order.mode === 'test' ? ' · Test order' : ''}</p>}
    <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
    {order && <>
      {order.paid && !refunded && <p>Thank you for your order. Shipping updates will appear here.</p>}
      {expired && <p>No payment was confirmed. You can return to your cart to try again.</p>}
      {cancelled && !expired && !order.paid && <p>Resume this checkout to complete payment or see its latest status.</p>}
      <ul className="merch-receipt-items">{order.items.map((line, index) => <li key={index}>
        <div><strong>{line.name}</strong><small>{line.title} · Qty {line.quantity}</small></div><span>{merchandiseMoney(line.quantity * line.retailCents)}</span>
      </li>)}</ul>
      <dl className="merch-totals">
        <div><dt>Subtotal</dt><dd>{merchandiseMoney(order.subtotalCents)}</dd></div>
        <div><dt>Shipping</dt><dd>{merchandiseMoney(order.shippingCents)}</dd></div>
        <div><dt>Tax</dt><dd>{merchandiseMoney(order.taxCents)}</dd></div>
        <div className="merch-grand-total"><dt>Total</dt><dd>{merchandiseMoney(order.totalCents)}</dd></div>
        {order.refundedCents > 0 && <div><dt>Refunded</dt><dd>{merchandiseMoney(order.refundedCents)}</dd></div>}
      </dl>
      {order.paid && order.fulfillments.map(fulfillment => <section className="merch-tracking" key={fulfillment.id}>
        <h2>Shipping status</h2><p>{fulfillmentLabels[fulfillment.status] || 'Waiting for a status update'}</p>
        {fulfillment.tracking.map((tracking, index) => <p key={index}>{tracking.carrier} {tracking.url ?
          <a className="merch-back-link" href={tracking.url} target="_blank" rel="noreferrer">{tracking.number || 'Track package'}</a> : tracking.number}</p>)}
      </section>)}
    </>}
    <div className="merch-confirmation-actions">
      {canResume && <button className="merch-primary" type="button" disabled={busy} onClick={onResume}>{busy ? 'Reopening checkout…' : 'Resume checkout'}</button>}
      {error && <button type="button" onClick={onRefresh}>Check order status</button>}
      <a className="merch-back-link" href={merchandiseLink(expired ? 'cart' : '')}>← {expired ? 'Return to cart' : 'Back to merchandise'}</a>
    </div>
  </section>;
}
