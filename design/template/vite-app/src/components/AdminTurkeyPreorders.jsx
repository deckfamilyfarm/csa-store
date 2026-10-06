import React, { useEffect, useState } from 'react';
import { adminGet, adminPut, adminPost, adminDownload } from '../adminApi.js';
import { ProductDescription } from './ProductDescription.jsx';
import './turkey.css';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const pacific = ms => ms ? new Date(Number(ms)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : '—';
const initialFilters = { status: '', pickupId: '', search: '' };
export function AdminTurkeyPreorders({ token }) {
  const [tab, setTab] = useState('setup');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [orders, setOrders] = useState([]);
  const [emailRetries, setEmailRetries] = useState([]);
  const [filters, setFilters] = useState(initialFilters);
  const [adjustments, setAdjustments] = useState({});
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [productChoice, setProductChoice] = useState('');
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  function applyData(next) {
    setData(next);
    setDraft({ ...next.sale, options: next.options.map(option => ({ ...option, inventoryCount: String(option.onHand) })), pickupGroups: next.pickupGroups, pickups: next.pickups });
  }
  function refreshInventory(next) {
    setData(next);
    setDraft(prev => ({ ...prev, options: prev.options.map(option => {
      const current = next.options.find(item => item.id === option.id);
      if (!current || String(option.inventoryCount) !== String(option.onHand)) return option;
      return { ...option, onHand: current.onHand, reserved: current.reserved, inventoryCount: String(current.onHand) };
    }) }));
  }
  async function loadSetup() { applyData(await adminGet('storefront/setup', token)); }
  async function loadOrders() {
    const result = await adminGet(`storefront/orders?${query}`, token);
    setOrders(result.orders); setEmailRetries(result.emailRetries);
  }
  useEffect(() => { loadSetup().catch(err => setError(err.message)); }, [token]);
  useEffect(() => { if (tab === 'orders') loadOrders().catch(err => setError(err.message)); }, [tab, query, token]);
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    const status = event.nativeEvent.submitter?.value === 'draft' ? 'draft' : draft.status;
    await run(async () => {
      if (status === 'open') {
        const missing = [
          !data.readiness.checkoutEnabled && 'enable turkey checkout on the server',
          !data.readiness.stripeConfigured && 'configure Stripe',
          !data.readiness.webhookConfigured && 'configure the turkey Stripe webhook',
          !data.readiness.emailConfigured && 'configure confirmation email delivery'
        ].filter(Boolean);
        if (missing.length) throw new Error(`Publishing was not saved: ${missing.join('; ')}. Your edits are still on this page. Use Save as draft to save inventory, then Preview saved setup to see your turkeys.`);
      }
      const options = draft.options.map(({ inventoryCount, ...option }) => ({ ...option,
        ...(!option.id || String(inventoryCount) !== String(option.onHand) ? {
          inventory: { onHand: inventoryCount, expectedOnHand: option.onHand, expectedReserved: option.reserved }
        } : {})
      }));
      try {
        applyData(await adminPut('storefront/setup', token, { ...draft, options, status }));
        setMessage(status === 'draft' ? 'Draft saved, including pre-order inventory. Use Preview saved setup to see your turkeys. The public store still shows Coming soon.' : status === 'open' ? 'Preorder setup saved. Turkeys are published on the store.' : 'Preorder setup saved. The sale is closed.');
      } catch (err) {
        throw new Error(`Changes were not saved: ${err.message} Your edits are still on this page.`);
      }
    });
  }
  async function adjust(id) {
    await run(async () => {
      const option = data.options.find(item => item.id === id);
      const adjustment = adjustments[id] || {};
      if (adjustment.onHand === undefined || adjustment.onHand === '') throw new Error('Enter the new pre-order inventory count.');
      refreshInventory(await adminPost(`storefront/stock/${id}`, token, { onHand: Number(adjustment.onHand),
        expectedOnHand: option.onHand, expectedReserved: option.reserved, reason: adjustment.reason }));
      setAdjustments(prev => ({ ...prev, [id]: {} })); setMessage('Pre-order inventory saved.');
    });
  }
  async function orderAction(order, action) {
    if (action === 'refund' && !window.confirm(`Cancel order ${order.number} and refund ${money(order.totalCents)}? Its uncollected turkeys will return to preorder stock after the refund succeeds.`)) return;
    await run(async () => {
      await adminPost(`storefront/orders/${order.id}/${action}`, token, {});
      await Promise.all([loadOrders(), loadSetup()]);
      setMessage(action === 'refund' ? 'Refund requested. Pending refunds retain stock until Stripe confirms success.' : 'Order updated.');
    });
  }
  async function attachReceipt(order) {
    const sessionId = window.prompt('Enter the Checkout Session ID from Stripe for this order. The store will verify its order reference and total before reconciling it.');
    if (!sessionId) return;
    await run(async () => {
      await adminPost(`storefront/orders/${order.id}/stripe-receipt`, token, { sessionId });
      await Promise.all([loadOrders(), loadSetup()]); setMessage('Stripe checkout receipt verified.');
    });
  }
  async function download() {
    await run(async () => {
      const { blob, filename } = await adminDownload(`storefront/orders.csv?${query}`, token);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const update = (field, value) => setDraft(prev => ({ ...prev, [field]: value }));
  const updateOption = (index, field, value) => setDraft(prev => ({ ...prev, options: prev.options.map((option, i) => i === index ? { ...option, [field]: value } : option) }));
  const updatePickup = (index, field, value) => setDraft(prev => ({ ...prev, pickups: prev.pickups.map((pickup, i) => i === index ? { ...pickup, [field]: value } : pickup) }));
  const groupKey = group => group.id || group.key;
  const newLocation = groupId => ({ key: `new-${crypto.randomUUID()}`, groupId, name: '', address: '', hours: '', instructions: '', active: true });
  function addGroup() {
    const key = `new-${crypto.randomUUID()}`;
    setDraft(prev => ({ ...prev, pickupGroups: [...prev.pickupGroups, { key, name: '', active: true }], pickups: [...prev.pickups, newLocation(key)] }));
  }
  function addProducts(products) {
    setDraft(prev => ({ ...prev, options: [...prev.options, ...products.filter(product => !prev.options.some(option => option.productId === product.id)).map(product => ({
      productId: product.id, label: product.name, preorderBreed: product.preorderBreed, imageUrl: product.imageUrl, priceCents: product.retailPriceCents, active: true,
      onHand: 0, reserved: 0, inventoryCount: '0'
    }))] }));
    setProductChoice('');
  }
  const availableProducts = (data?.catalogProducts || []).filter(product => !draft?.options.some(option => option.productId === product.id));
  const retailProduct = option => data?.catalogProducts.find(product => product.id === option.productId);
  function optionDescription(option) {
    const breed = retailProduct(option)?.preorderBreed || option.preorderBreed;
    if (breed === 'heritage') return draft.heritageDescription;
    if (breed === 'broad-breasted-white') return draft.broadBreastedDescription;
    return option.description;
  }
  const totals = (data?.options || []).reduce((sum, option) => ({ sold: sum.sold + option.purchased, onHand: sum.onHand + option.onHand,
    reserved: sum.reserved + option.reserved, available: sum.available + option.available }), { sold: 0, onHand: 0, reserved: 0, available: 0 });
  return <section className="admin-section turkey-admin">
    <h3>Turkey Preorders</h3><p>Retail prices come from Store → Products. Pre-order inventory is managed here, separately from Local Line inventory.</p>
    <div className="turkey-admin-tabs no-print" role="tablist" aria-label="Turkey preorder workspace">{['setup','inventory','orders'].map(key => <button role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} key={key} onClick={() => { setTab(key); setMessage(''); }}>{key === 'inventory' ? 'Pre-order inventory' : key[0].toUpperCase() + key.slice(1)}</button>)}</div>
    {error && <div className="turkey-alert" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    {!draft ? <p>Loading preorder setup…</p> : <>
      {tab === 'setup' && <form onSubmit={save}>
        <div className="turkey-card turkey-saved-status"><strong>Saved status: {{ draft: 'Draft — hidden from the public store', open: 'Published', closed: 'Closed' }[data.sale.status]}</strong><p>{data.options.length} turkey products saved · {totals.onHand} birds in pre-order inventory.</p>{draft.status !== data.sale.status && <p>The selected sale status has not been saved yet.</p>}</div>
        <div className="turkey-card"><h4>Launch readiness</h4><ul>{Object.entries(data.readiness).map(([key, value]) => <li key={key}>{value ? '✓' : '○'} {{ checkoutEnabled: 'Checkout enabled on server', stripeConfigured: 'Stripe key configured', webhookConfigured: 'Storefront webhook secret configured', emailConfigured: 'Email configured' }[key]}</li>)}</ul><p>Review catalog retail prices and set pre-order inventory before publishing. Confirm Stripe test/live mode and delivery in the launch checklist.</p><a href="/?experience=turkeys#/turkeys?preview=1" target="_blank" rel="noreferrer">Preview saved setup (checkout disabled)</a></div>
        <div className="turkey-card turkey-fields">
          <label>Sale title<input required value={draft.title} onChange={e => update('title', e.target.value)} /></label>
          <label>Sale status<select value={draft.status} onChange={e => update('status', e.target.value)}><option value="draft">Draft / coming soon</option><option value="open">Published / accepting orders</option><option value="closed">Closed</option></select></label>
          <label className="turkey-wide">Short listing description<textarea required rows="4" value={draft.description} onChange={e => update('description', e.target.value)} /></label>
          <label className="turkey-wide">Banner photo URL<input placeholder="https://… or /images/…" value={draft.imageUrl} onChange={e => update('imageUrl', e.target.value)} /></label>
          <label>Pickup date<input required type="date" value={draft.pickupDate} onChange={e => update('pickupDate', e.target.value)} /></label>
          <label>Sales cutoff (Pacific time)<input type="datetime-local" value={draft.closesPacific} onChange={e => update('closesPacific', e.target.value)} /></label>
          <label>Customer contact email<input type="email" value={draft.contactEmail} onChange={e => update('contactEmail', e.target.value)} /></label>
          <label>Staff order notification email<input type="email" value={draft.notifyEmail} onChange={e => update('notifyEmail', e.target.value)} /></label>
        </div>
        <div className="turkey-card"><h4>Thanksgiving Turkey product</h4>
          <p>Shared content for the turkey product page. Catalog and Local Line descriptions stay separate.</p>
          <div className="turkey-fields">
            <label className="turkey-wide">About our turkeys<textarea aria-label="About our turkeys" required rows="8" maxLength="10000" value={draft.aboutDescription ?? draft.description} onChange={e => update('aboutDescription', e.target.value)} aria-describedby="turkey-about-help" /></label>
            <p id="turkey-about-help" className="small turkey-wide">Separate paragraphs with a blank line. Start each bullet with “- ”. Supported existing HTML formatting is also preserved.</p>
            <label className="turkey-wide">Product photo<select aria-label="Product photo" value={draft.productImageUrl || ''} onChange={e => update('productImageUrl', e.target.value)}>
              <option value="">Use the first available catalog turkey photo</option>
              {[...new Set([draft.productImageUrl, ...(data.catalogProducts || []).flatMap(product => product.images || [])].filter(Boolean))].map(url => <option key={url} value={url}>{data.catalogProducts.find(product => product.images?.includes(url))?.name || 'Saved product photo'} — {url.split('/').pop()}</option>)}
            </select></label>
          </div>
          <h4>About our turkeys preview</h4><ProductDescription description={draft.aboutDescription ?? draft.description} />
        </div>
        <h4>Local preorder descriptions</h4><p>These descriptions appear when a turkey type is selected. Save them with preorder setup. Product and Local Line descriptions stay separate.</p>
        <div className="turkey-card turkey-fields">
          <label>Heritage Black description<textarea required rows="10" maxLength="10000" value={draft.heritageDescription ?? ''} onChange={e => update('heritageDescription', e.target.value)} /></label>
          <label>Broad Breasted White description<textarea required rows="10" maxLength="10000" value={draft.broadBreastedDescription ?? ''} onChange={e => update('broadBreastedDescription', e.target.value)} /></label>
        </div>
        <h4>Turkeys from the product list</h4><p>Names, photos, and retail prices come from Products. Descriptions use the local preorder copy above. Set each turkey’s Pre-order inventory here, then Save preorder setup.</p>
        <div className="turkey-catalog-picker turkey-card">
          <label>Catalog turkey<select aria-label="Catalog turkey" value={productChoice} onChange={e => setProductChoice(e.target.value)}><option value="">Choose a turkey product…</option>{availableProducts.map(product => <option value={product.id} key={product.id}>{product.name} · {product.vendor}</option>)}</select></label>
          <button type="button" disabled={!productChoice} onClick={() => addProducts(availableProducts.filter(product => product.id === Number(productChoice)))}>Add selected turkey</button>
          <button type="button" disabled={!availableProducts.some(product => product.wholeTurkey)} onClick={() => addProducts(availableProducts.filter(product => product.wholeTurkey))}>Add all whole turkeys</button>
        </div>
        {draft.options.map((option, index) => <div className="turkey-card turkey-fields" key={option.id || `new-${index}`}>
          <div className="turkey-admin-product turkey-wide">{option.imageUrl && <img src={option.imageUrl} alt={option.label} loading="lazy" />}<div><strong>{option.label}</strong><p>{option.productId ? `Catalog product #${option.productId}` : 'Link this existing offering to a catalog turkey.'}</p>{option.productAvailable === false && option.productId && <p className="turkey-error">The linked product is unavailable. Deactivate this offering or restore the product in Products.</p>}</div></div>
          {!option.productId && <label>Catalog turkey<select required={option.active} value="" onChange={e => {
            const product = data.catalogProducts.find(item => item.id === Number(e.target.value));
            if (product) setDraft(prev => ({ ...prev, options: prev.options.map((item, i) => i === index ? { ...item, productId: product.id, label: product.name, imageUrl: product.imageUrl } : item) }));
          }}><option value="">Choose a turkey…</option>{availableProducts.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>}
          <div><span>Retail price (from Products)</span><output className="turkey-retail-price">{retailProduct(option)?.retailPriceCents != null ? `${money(retailProduct(option).retailPriceCents)} per turkey` : 'Price unavailable'}</output><small>{retailProduct(option)?.priceError || 'Edit Retail Price in Store → Products.'}</small></div>
          <label>Pre-order inventory<input aria-label={`${option.label} setup pre-order inventory`} type="number" required min={option.reserved} max="1000000" step="1" value={option.inventoryCount} onChange={e => updateOption(index, 'inventoryCount', e.target.value)} /><small>Birds on hand for preorders, including reservations. Separate from Local Line inventory.</small></label>
          <div className="turkey-wide turkey-option-stock">
            {(() => {
              const current = data.options.find(item => item.id === option.id);
              const stale = current && (current.onHand !== option.onHand || current.reserved !== option.reserved);
              return <><span>Sold: {current?.purchased ?? 0} · Reserved: {current?.reserved ?? 0} · Available: {current?.available ?? 0}{!option.id && ' (not saved yet)'}</span>
                {stale && <p role="status">Inventory changed since you edited this count. <button type="button" onClick={() => setDraft(prev => ({ ...prev, options: prev.options.map((item, i) => i === index ? { ...item, onHand: current.onHand, reserved: current.reserved, inventoryCount: String(current.onHand) } : item) }))}>Use current inventory</button></p>}</>;
            })()}
          </div>
          <div className="turkey-wide"><strong>Variant: {retailProduct(option)?.typeLabel || option.typeLabel || 'Unknown type'} · {retailProduct(option)?.sizeLabel || option.sizeLabel || 'Missing weight range'}</strong>
            {(retailProduct(option)?.variantError || option.variantError) && <p className="turkey-error">{retailProduct(option)?.variantError || option.variantError}</p>}
            <p><strong>Local preorder description</strong></p><ProductDescription description={optionDescription(option)} /><small>Edit the shared description for this breed above.</small></div>
          <label><span><input type="checkbox" checked={option.active} onChange={e => updateOption(index, 'active', e.target.checked)} /> Offer this size</span></label>
          {!option.id && <button type="button" onClick={() => setDraft(prev => ({ ...prev, options: prev.options.filter((_, i) => i !== index) }))}>Remove unsaved size</button>}
        </div>)}
        <h4>Pickup location groups</h4><p>Name a group, then add one or more pickup locations with their own details. Times are Pacific; all use the sale’s pickup date. Existing orders retain their original pickup details.</p>
        {draft.pickupGroups.map((group, groupIndex) => <fieldset className="turkey-card turkey-location-group" key={groupKey(group)}><legend>{group.name || 'New pickup group'}</legend>
          <div className="turkey-fields"><label>Location group name<input required value={group.name} placeholder="For example, Portland" onChange={e => setDraft(prev => ({ ...prev, pickupGroups: prev.pickupGroups.map((item, i) => i === groupIndex ? { ...item, name: e.target.value } : item) }))} /></label>
          <label><span><input type="checkbox" checked={group.active} onChange={e => setDraft(prev => ({ ...prev, pickupGroups: prev.pickupGroups.map((item, i) => i === groupIndex ? { ...item, active: e.target.checked } : item) }))} /> Offer this pickup group</span></label></div>
          {draft.pickups.map((pickup, index) => String(pickup.groupId) === String(groupKey(group)) && <div className="turkey-card turkey-fields turkey-location-editor" key={pickup.id || pickup.key}>
            <label>Location title<input required value={pickup.name} onChange={e => updatePickup(index, 'name', e.target.value)} /></label>
            <label>Address<input value={pickup.address} onChange={e => updatePickup(index, 'address', e.target.value)} /></label>
            <label>Hours (Pacific)<input placeholder="For example, 9:00 AM–1:00 PM" value={pickup.hours} onChange={e => updatePickup(index, 'hours', e.target.value)} /></label>
            <label><span><input type="checkbox" checked={pickup.active} onChange={e => updatePickup(index, 'active', e.target.checked)} /> Offer this location</span></label>
            <label className="turkey-wide">Instructions<textarea rows="2" value={pickup.instructions} onChange={e => updatePickup(index, 'instructions', e.target.value)} /></label>
            {!pickup.id && <button type="button" onClick={() => setDraft(prev => ({ ...prev, pickups: prev.pickups.filter((_, i) => i !== index) }))}>Remove unsaved location</button>}
          </div>)}
          <div className="turkey-actions"><button type="button" onClick={() => setDraft(prev => ({ ...prev, pickups: [...prev.pickups, newLocation(groupKey(group))] }))}>Add location to {group.name || 'group'}</button>
          {!group.id && <button type="button" onClick={() => setDraft(prev => ({ ...prev, pickupGroups: prev.pickupGroups.filter((_, i) => i !== groupIndex), pickups: prev.pickups.filter(pickup => pickup.groupId !== group.key) }))}>Remove unsaved group</button>}</div>
        </fieldset>)}
        <div className="turkey-actions"><button type="button" onClick={addGroup}>Add pickup group</button><button type="submit" className="button" disabled={busy}>{busy ? 'Saving…' : 'Save preorder setup'}</button><button type="submit" value="draft" disabled={busy}>Save as draft</button><a href="/?experience=turkeys#/turkeys?preview=1" target="_blank" rel="noreferrer">Preview saved setup (checkout disabled)</a></div>
        {error && <div className="turkey-alert" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
      </form>}
      {['setup','inventory'].includes(tab) && <section className="turkey-inventory-section">
        <h4>Pre-order inventory</h4>
        <div className="turkey-stock-totals">{[['Sold',totals.sold],['Pre-order inventory (on hand)',totals.onHand],['Reserved',totals.reserved],['Available',totals.available]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <p>Set the birds allocated to preorders, including active reservations. This inventory is separate from Local Line inventory. Available = pre-order inventory − reserved. Sold excludes fully refunded orders. Changes in this table save immediately; counts entered on turkey cards save with Setup.</p>
        <button disabled={busy} onClick={() => run(async () => { refreshInventory(await adminGet('storefront/setup', token)); setAdjustments({}); })}>Refresh pre-order inventory</button>
        {!data.options.length && <p>Add catalog turkeys and their Pre-order inventory above, then save Setup to see the totals here.</p>}
        <div className="turkey-table-wrap"><table><thead><tr><th>Turkey</th><th>Sold</th><th>Pre-order inventory</th><th>Reserved</th><th>Available</th><th>Set pre-order inventory</th></tr></thead><tbody>{data.options.map(option => <tr key={option.id}>
          <td><div className="turkey-admin-product">{option.imageUrl && <img src={option.imageUrl} alt="" loading="lazy" />}<span>{option.label}{!option.active && ' (inactive)'}</span></div></td><td>{option.purchased}</td><td>{option.onHand}</td><td>{option.reserved}</td><td>{option.available}</td>
          <td><div className="turkey-stock-adjust"><input aria-label={`${option.label} pre-order inventory`} type="number" min={option.reserved} step="1" placeholder={String(option.onHand)} value={adjustments[option.id]?.onHand ?? ''} onChange={e => setAdjustments(prev => ({ ...prev, [option.id]: { ...prev[option.id], onHand: e.target.value } }))} /><input aria-label={`${option.label} adjustment reason`} placeholder="Reason" value={adjustments[option.id]?.reason || ''} onChange={e => setAdjustments(prev => ({ ...prev, [option.id]: { ...prev[option.id], reason: e.target.value } }))} /><button disabled={busy} onClick={() => adjust(option.id)}>Set pre-order inventory</button><button onClick={() => run(async () => setHistory({ label: option.label, rows: await adminGet(`storefront/stock/${option.id}/history`, token) }))}>History</button></div></td>
        </tr>)}</tbody></table></div>
        {history && <div className="turkey-card"><h4>{history.label} · stock history</h4><button onClick={() => setHistory(null)}>Close history</button><ul>{history.rows.map(row => <li key={row.id}>{pacific(row.created_ms)} PT · On hand {row.delta_on_hand >= 0 ? '+' : ''}{row.delta_on_hand}, reserved {row.delta_reserved >= 0 ? '+' : ''}{row.delta_reserved} · {row.reason}{row.actor_id ? ` · Staff #${row.actor_id}` : ''}</li>)}</ul></div>}
      </section>}
      {tab === 'orders' && <>
        <div className="turkey-actions no-print"><input aria-label="Search turkey orders" placeholder="Name, email, or order number" value={filters.search} onChange={e => setFilters(prev => ({ ...prev, search: e.target.value }))} />
          <select aria-label="Pickup location filter" value={filters.pickupId} onChange={e => setFilters(prev => ({ ...prev, pickupId: e.target.value }))}><option value="">All pickup locations</option>{data.pickups.map(pickup => <option key={pickup.id} value={pickup.id}>{data.pickupGroups.find(group => group.id === pickup.groupId)?.name} · {pickup.name}{!pickup.active ? ' (inactive)' : ''}</option>)}</select>
          <select aria-label="Order status filter" value={filters.status} onChange={e => setFilters(prev => ({ ...prev, status: e.target.value }))}><option value="">All statuses</option>{['paid','collected','creating','reserved','expired','refund_pending','refund_failed','refunded','review'].map(status => <option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select>
          <button disabled={busy} onClick={() => run(loadOrders)}>Refresh</button><button disabled={busy} onClick={download}>Export CSV</button><button onClick={() => window.print()}>Print pickup list</button>
        </div>
        <p>{orders.length} orders shown{orders.length === 5000 ? ' (limit reached; filter by status or pickup location)' : ''}. Filter to Paid for the remaining pickup list.</p>
        {emailRetries.length > 0 && <details className="no-print"><summary>{emailRetries.length} emails awaiting delivery</summary><ul>{emailRetries.map((item, i) => <li key={i}>{item.orderId} · {item.kind} · {item.attempts} attempts · {item.lastError || 'Queued for delivery'}</li>)}</ul></details>}
        <div className="turkey-table-wrap turkey-print-orders"><table><thead><tr><th>Order / status</th><th>Customer</th><th>Turkeys / total</th><th>Pickup</th><th className="no-print">Actions</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}>
          <td><strong>{order.number}</strong><div>{order.status.replaceAll('_',' ')}</div>{order.stripeMode && <div>{order.stripeMode === 'test' ? 'Stripe test mode' : 'Stripe live mode'}</div>}<small>{pacific(order.createdMs)} PT</small>{order.refundStatus && <p>Refund: {order.refundStatus} ({money(order.refundedCents)})</p>}{order.lastError && <p className="turkey-error no-print">{order.lastError}</p>}</td>
          <td><strong>{order.customer.name}</strong><div>{order.customer.email}</div><div>{order.customer.phone}</div><details className="no-print"><summary>Address</summary><p>{[order.customer.addressLine1,order.customer.addressLine2,order.customer.city,order.customer.state,order.customer.postalCode,order.customer.country].filter(Boolean).join(', ')}</p></details></td>
          <td>{order.items.map(item => <div key={item.optionId}>{item.quantity} × {item.typeLabel && item.sizeLabel ? `${item.typeLabel}, ${item.sizeLabel}` : item.label}</div>)}<strong>{money(order.totalCents)}</strong></td>
          <td><small>{order.pickup.groupName}</small><div>{order.pickup.name}</div><div>{order.pickup.date}</div><small>{order.pickup.hours}</small>{order.collectedMs && <div>Collected {pacific(order.collectedMs)} PT</div>}</td>
          <td className="no-print"><div className="turkey-order-actions">{order.status === 'paid' && !order.refundedCents && !order.refundStatus && <button disabled={busy} onClick={() => orderAction(order, 'collect')}>Mark collected</button>}{['paid','refund_pending'].includes(order.status) && !order.collectedMs && <button disabled={busy} onClick={() => orderAction(order, 'refund')}>{order.status === 'refund_pending' ? 'Check refund' : 'Cancel & refund'}</button>}<button disabled={busy} onClick={() => orderAction(order, 'reconcile')}>Reconcile payment</button>{order.status === 'review' && !order.stripeSessionId && <button disabled={busy} onClick={() => attachReceipt(order)}>Link Stripe receipt</button>}</div></td>
        </tr>)}</tbody></table></div>
      </>}
    </>}
  </section>;
}
