import React, { useRef, useState } from 'react';
import { adminGet, adminPost, adminPut } from '../adminApi.js';
import { ProductEditorDialog } from './ProductEditorDialog.jsx';
import { merchandiseProductSummary, merchandiseSaveInput, merchandiseQuickApproval } from './merchandiseAdminView.js';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
const range = values => !values ? 'Unavailable' : values[0] === values[1] ? money(values[0]) : `${money(values[0])} – ${money(values[1])}`;
const sections = [['merch-product-settings', 'Product & artwork'], ['merch-variant-settings', 'Prices & variants']];

function MerchandiseSettings({ product, vendors, token, onSaved, onRefreshed, onClose }) {
  const [draft, setDraft] = useState(product);
  const [priceInputs, setPriceInputs] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [photo, setPhoto] = useState(0);
  const saving = useRef(false);
  const available = draft.variants.filter(variant => variant.canSell);
  const allSelected = available.length > 0 && available.every(variant => variant.enabled);
  const someSelected = available.some(variant => variant.enabled);
  const change = (field, value) => { setDraft(current => ({ ...current, [field]: value })); setDirty(true); setDiscard(false); };
  const selectAll = enabled => change('variants', draft.variants.map(variant => ({ ...variant, enabled: enabled && variant.canSell })));
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose(); } }
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setDiscard(false);
    try {
      const saved = await adminPut(`merchandise/products/${product.id}`, token, merchandiseSaveInput(draft, priceInputs));
      setDraft(saved); setPriceInputs({}); setDirty(false); onSaved(saved);
    } catch (failure) { setError(failure.message); }
    finally { saving.current = false; setBusy(false); }
  }
  async function refresh() {
    if (saving.current || dirty) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await adminPost(`merchandise/products/${product.id}/refresh`, token, {});
      const saved = result.products.find(row => row.id === product.id);
      setDraft(saved); setPriceInputs({}); setPhoto(0); onRefreshed(result.products);
    } catch (failure) { setError(failure.message); }
    finally { saving.current = false; setBusy(false); }
  }
  return <ProductEditorDialog name={product.name} title={product.name} sections={sections} showNeighbors={false}
    backLabel="Back to merchandise" busy={busy} dirty={dirty} onClose={close}
    message={discard ? 'Discard your unsaved merchandise settings?' : undefined}
    footer={discard ? <><button type="button" className="button alt" onClick={() => setDiscard(false)}>Keep editing</button>
      <button type="button" className="button" onClick={onClose}>Discard changes</button></>
      : <><button type="button" className="button alt" disabled={busy} onClick={close}>Close</button>
        <button type="button" className="button" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button></>}>
    <div className="merch-admin merch-settings">
      {error && <p role="alert">{error}</p>}
      <section id="merch-product-settings">
        <h3>Product & artwork</h3>
        <div className="merch-product-heading">
          {draft.images.length > 0 && <div className="merch-settings-photos">
            <a href={draft.images[photo]?.src || draft.images[0].src} target="_blank" rel="noreferrer">
              <img src={draft.images[photo]?.src || draft.images[0].src} alt={`${draft.name}, photo ${photo + 1}`} /></a>
            {draft.images.length > 1 && <label>Review photo<select value={photo} onChange={event => setPhoto(Number(event.target.value))}>
              {draft.images.map((image, index) => <option key={`${image.src}:${index}`} value={index}>Photo {index + 1} of {draft.images.length}</option>)}
            </select></label>}
          </div>}
          <div className="merch-settings-fields">
            <p>{draft.provider || 'Supplier catalog unavailable'} · Shop {draft.shopId} · {draft.externalId}</p>
            {draft.holds.length > 0 && <p className="merch-settings-holds">{draft.holds.join(' ')}</p>}
            {!available.length && <p role="status" className="merch-settings-holds">Disabled: no available supplier variants. This product cannot be listed.</p>}
            <label>Local vendor<select value={draft.vendorId || ''} disabled={busy} onChange={event => change('vendorId', Number(event.target.value))}>
              <option value="">Choose an existing vendor</option>{vendors.map(vendor => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
            </select></label>
            <label><input type="checkbox" disabled={busy} checked={draft.artworkReviewed} onChange={event => change('artworkReviewed', event.target.checked)} /> I reviewed the artwork, placements and generated layers.</label>
            <label><input type="checkbox" disabled={busy} checked={draft.currency === 'USD'} onChange={event => change('currency', event.target.checked ? 'USD' : null)} /> I confirmed supplier money values are USD.</label>
            <label><input type="checkbox" checked={draft.active && available.length > 0} disabled={busy || !available.length} onChange={event => change('active', event.target.checked)} /> Show this product in the merchandise store</label>
            <button type="button" disabled={busy || dirty} onClick={refresh}>Refresh supplier information</button>
            <p className="small">{dirty ? 'Save your settings before refreshing.' : 'Supplier changes disable the product for review and preserve modified prices.'}</p>
          </div>
        </div>
      </section>
      <section id="merch-variant-settings">
        <h3>Prices & variants</h3>
        <p>Default prices add 40% to Printify production cost, with a $10.00 minimum. Leave Modified price blank to use the default.</p>
        <div className="merch-actions">
          <label><input type="checkbox" checked={allSelected} disabled={busy || !available.length}
            ref={input => { if (input) input.indeterminate = someSelected && !allSelected; }}
            onChange={event => selectAll(event.target.checked)} /> Sell all available variants ({available.length})</label>
          <label><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> Show unavailable and disabled supplier variants</label>
          <button type="button" disabled={busy || !draft.variants.some(variant => variant.retailCents != null) && !Object.keys(priceInputs).length}
            onClick={() => { setPriceInputs(Object.fromEntries(draft.variants.map(variant => [variant.id, '']))); setDirty(true); setDiscard(false); }}>Use default prices for every variant</button>
        </div>
        <div className="merch-table-scroll"><table><thead><tr><th scope="col">Variant</th><th scope="col">Supplier</th><th scope="col">Cost</th><th scope="col">Saved channel price</th><th scope="col">Default price</th><th scope="col">Modified price</th><th scope="col">Sell</th></tr></thead>
          <tbody>{draft.variants.filter(variant => showAll || !available.length || variant.canSell || variant.enabled).map(variant => <tr key={variant.id} className={!variant.canSell ? 'merch-variant-unavailable' : undefined}>
            <th scope="row">{variant.title}<small>{variant.sku}</small></th>
            <td>{!variant.sourceEnabled ? 'Supplier disabled' : !variant.available ? 'Unavailable' : variant.canSell ? 'Available' : 'Needs supplier review'}</td>
            <td>{variant.costCents == null ? 'Unknown' : money(variant.costCents)}</td>
            <td>{variant.channelPriceCents == null ? 'Unknown' : money(variant.channelPriceCents)}</td>
            <td>{variant.proposedRetailCents == null ? 'Unavailable' : money(variant.proposedRetailCents)}</td>
            <td><input aria-label={`${variant.title} modified price in dollars`} type="text" inputMode="decimal" placeholder="Default" disabled={busy}
              value={priceInputs[variant.id] ?? (variant.retailCents == null ? '' : (variant.retailCents / 100).toFixed(2))}
              onChange={event => { setPriceInputs(current => ({ ...current, [variant.id]: event.target.value })); setDirty(true); setDiscard(false); }} /></td>
            <td><input aria-label={`Sell ${variant.title}`} type="checkbox" checked={variant.enabled} disabled={busy || !variant.canSell && !variant.enabled}
              onChange={event => change('variants', draft.variants.map(row => row.id === variant.id ? { ...row, enabled: event.target.checked } : row))} /></td>
          </tr>)}</tbody></table></div>
      </section>
    </div>
  </ProductEditorDialog>;
}

export function MerchandiseProductTable({ products, vendors, token, onSaved, onReloaded }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const saving = useRef(false);
  const summaries = products.map(product => ({ product, summary: merchandiseProductSummary(product) }));
  const unavailable = summaries.filter(({ summary }) => summary.status === 'unavailable').length;
  const listed = summaries.filter(({ summary }) => summary.listed).length;
  const shown = summaries.filter(({ product, summary }) =>
    (filter === 'all' || filter === summary.status) && `${product.name} ${product.provider || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = products.find(product => product.id === selectedId);
  async function saveRow(product, approve) {
    if (saving.current) return;
    saving.current = true; setBusyId(product.id); setError(null); setNotice('');
    try {
      const body = approve ? merchandiseQuickApproval(product) : merchandiseSaveInput({ ...product, active: false });
      const saved = await adminPut(`merchandise/products/${product.id}`, token, body);
      onSaved(saved); setNotice(`${saved.name}: ${approve ? 'artwork and USD approved; selling all available variants.' : 'no longer listed.'}`);
    } catch (failure) { setError({ productId: product.id, message: `${product.name}: ${failure.message}` }); }
    finally { saving.current = false; setBusyId(null); }
  }
  async function reload() {
    if (saving.current) return;
    saving.current = true; setBusyId('reload'); setError(null); setNotice('');
    try { const catalog = await adminGet('merchandise/catalog', token); onReloaded(catalog); }
    catch (failure) { setError({ message: failure.message }); }
    finally { saving.current = false; setBusyId(null); }
  }
  return <>
    <div className="merch-catalog-summary"><strong>{products.length} products</strong><span>{listed} listed</span>
      <button type="button" className="merch-inline-link" aria-pressed={filter === 'unavailable'} onClick={() => setFilter(filter === 'unavailable' ? 'all' : 'unavailable')}>{unavailable} with no available variants</button>
    </div>
    <p className="merch-approval-help">Click <strong>Approve & sell all</strong> to confirm that you reviewed the artwork, placements and generated layers, confirm supplier money values are USD, and list all available variants. Default prices apply unless you saved a modified price in Settings.</p>
    <div className="merch-catalog-toolbar">
      <label>Find merchandise<input type="search" value={search} placeholder="Product or supplier" onChange={event => setSearch(event.target.value)} /></label>
      <label>Status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All products</option><option value="listed">Listed</option><option value="draft">Not listed</option><option value="unavailable">No available variants</option></select></label>
      <button type="button" disabled={busyId != null} onClick={reload}>{busyId === 'reload' ? 'Reloading…' : 'Reload catalog'}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error.message}</p>}
    <div className="merch-table-scroll"><table className="merch-catalog-table"><caption>Merchandise products, available supplier variants, prices and approval status</caption>
      <thead><tr><th scope="col">Product</th><th scope="col">Available variants</th><th scope="col">Price</th><th scope="col">Review</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>{shown.map(({ product, summary }) => {
        const vendorValid = vendors.some(vendor => vendor.id === product.vendorId && vendor.name?.trim());
        const issue = summary.approvalIssue || (!vendorValid ? 'Choose an existing local vendor in Settings.' : '');
        return <tr key={product.id} className={summary.status === 'unavailable' ? 'merch-product-unavailable' : undefined} aria-busy={busyId === product.id || undefined}>
          <th scope="row"><button type="button" className="merch-product-open" disabled={busyId != null} onClick={() => setSelectedId(product.id)}>
            {product.images[0] && <img src={product.images[0].src} alt="" loading="lazy" />}<span>{product.name}<small>{product.provider || 'Supplier information unavailable'}</small></span>
          </button></th>
          <td><strong>{summary.available} of {summary.total}</strong><small>{summary.selling} selected and available</small></td>
          <td><strong>{range(summary.priceRange)}</strong><small>Default: {range(summary.defaultRange)}</small><small>{summary.modified ? `${summary.modified} modified ${summary.modified === 1 ? 'price' : 'prices'}` : 'Using default prices'}</small></td>
          <td><span>{product.artworkReviewed ? 'Artwork reviewed' : 'Artwork not reviewed'}</span><small>{product.currency === 'USD' ? 'USD confirmed' : 'Confirm USD'}</small></td>
          <td><span className={`merch-listing-status merch-listing-${summary.status}`}>{summary.status === 'unavailable' ? 'Disabled' : summary.listed ? 'Listed' : 'Not listed'}</span>
            {summary.status === 'unavailable' && <small>No available variants</small>}</td>
          <td><div className="merch-row-actions"><button type="button" disabled={busyId != null || Boolean(issue) || summary.allSelling} title={issue || undefined}
            aria-label={`Approve artwork and USD and sell all available variants for ${product.name}`} onClick={() => saveRow(product, true)}>
            {busyId === product.id ? 'Saving…' : summary.allSelling ? 'Selling all available' : 'Approve & sell all'}</button>
            <button type="button" className="merch-inline-link" disabled={busyId != null} onClick={() => setSelectedId(product.id)}>Settings & prices</button>
            {product.active && <button type="button" className="merch-inline-link" disabled={busyId != null} onClick={() => saveRow(product, false)}>Stop selling</button>}
          </div>{issue && summary.status !== 'unavailable' && <small className="merch-row-issue">{issue}</small>}</td>
        </tr>;
      })}</tbody></table></div>
    {!shown.length && <p>{products.length ? 'No merchandise matches these filters.' : 'No merchandise products have been imported.'}</p>}
    {selected && <MerchandiseSettings key={selected.id} product={selected} vendors={vendors} token={token} onSaved={onSaved}
      onRefreshed={nextProducts => onReloaded({ products: nextProducts })} onClose={() => setSelectedId(null)} />}
  </>;
}
