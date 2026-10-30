import {BundleSync} from './BundleSync.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { adminGet, adminPost } from '../adminApi.js';
import { ProductEditorDialog } from './ProductEditorDialog.jsx';
import { safeDescription } from './ProductEditorInfo.jsx';
import { useViewportRows } from './useViewportRows.js';
import './EnterpriseBundles.css';
const money = cents => cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

export function EnterpriseBundles({ token, roles = [], active = true, review = false }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState('all'), [selected, setSelected] = useState(null), [refresh, setRefresh] = useState(0);
  const scroll = useViewportRows(35, active && !review);
  const canEdit = roles.some(role => ['admin','pricing_editor','pricing_admin','local_pricelist_admin'].includes(role));
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    adminGet('enterprise-pricing/bundles', token).then(value => { if (!cancelled) { setData(value); setError(''); } })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [token, active, refresh]);
  const rows = (data?.rows || []).filter(row => row.input.name.toLowerCase().includes(search.toLowerCase()) &&
    (visibility === 'all' || row.input.visible === (visibility === 'visible')));
  return <section className={`enterprise-bundles ${review ? 'bundle-review' : 'card enterprise-pricing-page'}`}>
    {review && <h3>Bundles · Local Line</h3>}
    <div className="admin-actions bundle-filters">
      <input className="input" aria-label="Search bundles" placeholder="Search bundles" value={search} onChange={e => setSearch(e.target.value)} />
      <select className="input" aria-label="Bundle visibility" value={visibility} onChange={e => setVisibility(e.target.value)}><option value="all">All bundles</option><option value="visible">Visible</option><option value="hidden">Hidden</option></select>
      <span>{rows.length} bundles</span>{!review && canEdit && <button className="button alt" disabled={!data} onClick={() => setSelected("new")}>+ Add bundle</button>}<button className="button alt" onClick={() => setRefresh(v => v + 1)}>Refresh prices</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading bundles…</p>}
    {data && !data.rows.length && <p>No bundles yet. Add a bundle to choose its contents and discount.</p>}
    <div className="table-wrap bundle-table-scroll" ref={scroll} role="region" aria-label="Bundle pricing" tabIndex={0}>
      <table className="admin-table"><thead><tr><th>Bundle</th><th>Buy Price</th><th>Contents</th><th>Discount</th><th>FF Bundle Price</th><th>Visibility</th><th>{review ? 'Channel price' : 'Availability'}</th><th>Sync</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td><button className="bundle-name" onClick={() => setSelected(row.id)}>{row.input.name}</button><small>{row.vendorName} · bundle</small></td>
        <td>{money(row.output.buyPriceCents)}<small>per bundle</small></td><td>{money(row.output.subtotalCents)}<small>{row.input.components.reduce((n,c)=>n+c.quantity,0)} packages</small></td>
        <td>{row.input.discountPercent}%</td><td><strong>{money(row.output.priceCents)}</strong><small>per bundle</small></td><td>{row.input.visible ? 'Visible' : 'Hidden'}</td>
        <td>{review ? [...new Set(row.remotePrices.map(p=>money(p.priceCents)))].join(' / ') : row.input.inventoryMode === 'untracked' ? 'Not tracked' : row.output.availableBundles ?? 'Unknown'}</td>
        <td><button className={row.status === 'matches' ? 'bundle-matches' : 'bundle-attention'} onClick={() => setSelected(row.id)}>{row.status === 'needs-input' ? 'Needs input' : row.status === 'matches' ? '✓ LL price matches' : 'LL · Needs sync'}</button></td>
      </tr>)}</tbody></table>
    </div>
    {review && <p className="small">Bundle changes are saved locally. Check Local Line and approve publication from the bundle’s Sync section.</p>}
    {selected && data && <BundleEditor key={selected} id={selected} token={token} canEdit={canEdit} roles={roles} localOnly={data.localOnly} catalog={data.catalog} vendors={data.vendors}
      onClose={() => setSelected(null)} onCreated={id => { setSelected(id); setRefresh(v => v + 1); }} onSaved={() => setRefresh(v => v + 1)} />}
  </section>;
}

function Description({ value, resetKey, disabled, onChange }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.innerHTML = safeDescription(value); }, [resetKey]);
  return <div ref={ref} role="textbox" aria-label="Bundle description" aria-multiline="true" className="product-editor-description"
    contentEditable={!disabled} suppressContentEditableWarning onInput={e => onChange(safeDescription(e.currentTarget.innerHTML))} />;
}

function BundleEditor({ id, token, catalog, vendors, canEdit, roles, localOnly, onClose, onSaved, onCreated }) {
  const [detail, setDetail] = useState(null), [draft, setDraft] = useState(null), [baseline, setBaseline] = useState(null);
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [reload, setReload] = useState(0), [refreshPreview, setRefreshPreview] = useState(0), [componentSearch, setComponentSearch] = useState('');
  const [adding, setAdding] = useState(false), [imageUrl, setImageUrl] = useState('');
  const [creationKey] = useState(() => crypto.randomUUID());
  const isNew = id === "new";
  const dirty = draft && (isNew || JSON.stringify(draft) !== JSON.stringify(baseline));
  useEffect(() => {
    if (isNew) {
      const input = { name: '', description: '', vendorId: '', buyPrice: '', discountPercent: 5,
        visible: false, inventoryMode: 'untracked', stock: null, images: [], components: [] };
      setDraft(input); setBaseline(input); setDetail({ input, remoteBoxId: null, remotePrices: [] });
      return;
    }
    let cancelled = false;
    adminGet(`enterprise-pricing/bundles/${id}`, token).then(value => { if (!cancelled) { setDetail(value); setDraft(value.input); setBaseline(value.input); setMessage(''); } })
      .catch(e => { if (!cancelled) setMessage(e.message); });
    return () => { cancelled = true; };
  }, [id, token, reload]);
  useEffect(() => {
    if (!draft || !canEdit || (isNew && (!draft.name.trim() || !draft.vendorId || draft.buyPrice === '' || !draft.components.length))) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => adminPost('enterprise-pricing/bundles/preview', token, { input: draft })
      .then(value => { if (!cancelled) setPreview(value); })
      .catch(e => { if (!cancelled) { setPreview(null); setMessage(e.message); } }), 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft, token, canEdit, refreshPreview]);
  const update = patch => { setPreview(null); setMessage(''); setDraft(d => ({ ...d, ...patch })); };
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved bundle changes?'))) onClose(); };
  async function save(goBack) {
    if (!preview || busy) return;
    setBusy(true); setMessage('');
    try {
      const saved = await adminPost(isNew ? "enterprise-pricing/bundles" : `enterprise-pricing/bundles/${id}`, token, { input: draft, expectedRevision: detail.revision, pricingHash: preview.pricingHash, ...(isNew ? { creationKey } : {}) });
      if (isNew) { onCreated(saved.id); if (goBack) onClose(); return; }
      setDetail(old => ({ ...old, revision: saved.revision, input: saved.input, output: saved.output }));
      setDraft(saved.input); setBaseline(saved.input); setPreview(saved); setMessage('Saved locally.'); onSaved();
      if (goBack) onClose();
    } catch (e) { setMessage(e.message); setPreview(null); setRefreshPreview(v=>v+1); }
    finally { setBusy(false); }
  }
  const output = preview?.output || (!dirty ? detail?.output : null);
  const available = catalog.filter(p => !p.blocker && !draft?.components.some(c => c.packageId === p.packageId) &&
    `${p.name} ${p.packageName} ${p.vendorName}`.toLowerCase().includes(componentSearch.toLowerCase()));
  const editComponent = (index, patch) => update({ components: draft.components.map((c,i) => i===index ? {...c,...patch} : c) });
  return <ProductEditorDialog name={draft?.name || 'new bundle'} title={isNew ? 'Add bundle' : undefined} backLabel="Back to bundles" showNeighbors={false} busy={busy} dirty={dirty} message={message}
    onClose={close} sections={[["bundle-info","Bundle info"],["bundle-inventory","Inventory"],["bundle-contents","Contents & price"],["bundle-sync","Sync"]]}
    footer={<><button className="button alt" disabled={busy} onClick={close}>Cancel</button>{canEdit && <>
      <button className="button alt" disabled={busy || !dirty || !preview || !!preview?.output?.blockers?.length} onClick={() => save(false)}>{isNew ? 'Create bundle' : 'Save'}</button>
      <button className="button" disabled={busy || !dirty || !preview || !!preview?.output?.blockers?.length} onClick={() => save(true)}>{isNew ? 'Create and go back' : 'Save and go back'}</button></>}</>}>
    {!draft ? <p role="status">{message || 'Loading bundle…'}</p> : <>
    <section className="product-editor-section bundle-form" id="bundle-info"><h3>Bundle info</h3>
      <fieldset disabled={!canEdit || busy}><label>Bundle name<input className="input" value={draft.name} onChange={e=>update({name:e.target.value})} /></label>
      <label>Vendor<select aria-label="Bundle vendor" className="input" value={draft.vendorId} onChange={e=>update({vendorId:Number(e.target.value)})}><option value="">Choose vendor</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="bundle-check"><input type="checkbox" checked={draft.visible} onChange={e=>update({visible:e.target.checked})} /> Visible in Local Line after publication</label>
      <span>Description</span><Description resetKey={`${id}:${reload}:${detail.revision}`} value={draft.description} disabled={!canEdit || busy} onChange={description=>update({description})} />
      <span>Images</span><div className="bundle-images">{draft.images.map((url,i)=><div key={`${i}:${url}`}><img src={url} alt={`${draft.name} ${i+1}`} /><button className="button alt" aria-label={`Remove image ${i+1}`} onClick={()=>update({images:draft.images.filter((_,n)=>n!==i)})}>Remove</button></div>)}</div>
      {draft.images.length<5 && <div className="admin-actions"><input className="input" aria-label="Image URL" placeholder="https://… image URL" value={imageUrl} onChange={e=>setImageUrl(e.target.value)} /><button className="button alt" disabled={!imageUrl.trim()} onClick={()=>{update({images:[...draft.images,imageUrl.trim()]});setImageUrl('');}}>Add image</button></div>}
      </fieldset></section>
    <section className="product-editor-section bundle-form" id="bundle-inventory"><h3>Inventory</h3><fieldset disabled={!canEdit || busy}>
      <label>Track inventory<select className="input" value={draft.inventoryMode} onChange={e=>update({inventoryMode:e.target.value})}><option value="untracked">Not tracked</option><option value="components">Calculate from component availability</option><option value="separate">Track this bundle separately</option></select></label>
      {draft.inventoryMode==='separate' && <label>Bundle inventory<input className="input" type="number" min="0" step="1" value={draft.stock??''} onChange={e=>update({stock:e.target.value})} /></label>}
      {draft.inventoryMode==='components' && <p>Available bundles: <strong>{output?.componentCapacity ?? 'Unknown — some components are not tracked'}</strong></p>}
      <p className="small">These settings are local. Local Line continues handling live order inventory. Stock and inventory-mode changes require separate review. On-farm inventory is separate.</p>
    </fieldset></section>
    <section className="product-editor-section bundle-form" id="bundle-contents"><h3>Contents &amp; price</h3>
      <div className="bundle-price-summary"><span>Purchased separately<strong>{money(output?.subtotalCents)}</strong></span><span>Member savings<strong>{money(output?.savingsCents)}</strong></span><span>FF Bundle Price<strong>{money(output?.priceCents)}</strong></span></div>
      <div className="table-wrap"><table className="admin-table"><thead><tr><th>Product / package</th><th>FF price</th><th>Quantity</th><th>Total</th><th></th></tr></thead><tbody>{draft.components.map((c,i)=>{
        const p = catalog.find(p=>p.packageId===c.packageId), priced=output?.components.find(p=>p.packageId===c.packageId);
        return <tr key={c.packageId}><td>{p?.name || `Package ${c.packageId}`}<small>{p?.packageName}</small></td><td>{money(priced?.priceCents)}</td><td><input className="input bundle-quantity" type="number" min="1" step="1" aria-label={`Quantity for ${p?.name || c.packageId}`} disabled={!canEdit||busy} value={c.quantity} onChange={e=>editComponent(i,{quantity:e.target.value})} /></td><td>{money(priced?.totalCents)}</td><td><button className="button alt" aria-label={`Remove ${p?.name || c.packageId}`} disabled={!canEdit||busy} onClick={()=>update({components:draft.components.filter((_,n)=>n!==i)})}>×</button></td></tr>;
      })}</tbody></table></div>
      {canEdit && <button className="button alt" disabled={busy} onClick={()=>setAdding(v=>!v)}>{adding?'Close product search':'Add contents'}</button>}
      {adding && <div className="bundle-add-contents"><input autoFocus className="input" aria-label="Search component packages" placeholder="Search product, package or vendor" value={componentSearch} onChange={e=>setComponentSearch(e.target.value)} />
        <div role="region" aria-label="Available component packages">{available.slice(0,40).map(p=><button key={p.packageId} disabled={busy} onClick={()=>{update({components:[...draft.components,{packageId:p.packageId,quantity:1}]});setComponentSearch('');}}>{p.name} · {p.packageName}<small>{p.vendorName} · {money(p.priceCents)}</small></button>)}{!available.length && <p>No priced packages match.</p>}</div></div>}
      <fieldset disabled={!canEdit||busy} className="bundle-pricing-inputs"><label>Bundle Buy Price<input className="input" type="number" min="0" step="0.01" value={draft.buyPrice} onChange={e=>update({buyPrice:e.target.value})} /></label>
      <label>Bundle discount %<input className="input" type="number" min="0" max="99.99" step="0.01" value={draft.discountPercent} onChange={e=>update({discountPercent:e.target.value})} /></label></fieldset>
      <p className="small">Component FF package prices × quantities, less {draft.discountPercent}%. All three active FF baskets use this price. The discount does not change the Buy Price.</p>
      {output?.blockers.map((text,i)=><p role="alert" key={i}>{text}</p>)}
    </section>
    <section className="product-editor-section" id="bundle-sync"><h3>Sync</h3><p>{detail.remoteBoxId ? `Local Line box #${detail.remoteBoxId}` : "Saved locally; Local Line listing not linked"} · {draft.visible?'Visible':'Hidden'}</p>
      <table className="admin-table"><thead><tr><th>Basket</th><th>Channel price</th><th>Local bundle price</th></tr></thead><tbody>{detail.remotePrices.map(p=><tr key={p.listId}><td>{p.name}</td><td>{money(p.priceCents)}</td><td>{money(output?.priceCents)}</td></tr>)}</tbody></table>
      {detail.remoteBoxId ? <BundleSync id={id} token={token} roles={roles} localOnly={localOnly} dirty={dirty} publicationId={detail.latestPublicationId} onPublished={()=>{setReload(v=>v+1);onSaved();}} /> : <p>Create and link the Local Line bundle before publishing. Saving here does not create a channel listing.</p>}
      {!isNew && <button className="button alt" disabled={busy} onClick={()=>{if(!dirty||window.confirm('Discard your draft and reload the saved bundle?')){setPreview(null);setReload(v=>v+1);}}}>Reload saved bundle</button>}
    </section></>}
  </ProductEditorDialog>;
}
