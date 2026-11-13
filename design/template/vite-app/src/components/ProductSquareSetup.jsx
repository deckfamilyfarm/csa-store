import React, { useEffect, useRef, useState } from 'react';
import { adminGet, adminPost } from '../adminApi.js';
import { squareMatchChoices } from './squareMatchPublication.js';
import { canReadSquareSetup, canLinkSquare, canCreateSquare, availableSquareLink, squareSetupReady,
  recoverableSquareCreation, previewProductSquareCreation, approveProductSquareLink, finishProductSquareCreation } from './productSquareSetupFlow.js';

const money = (amount, currency = 'USD') => amount == null ? 'Not available' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
const label = row => [row.itemName, row.variationName].filter(Boolean).join(' / ') || row.squareVariationId;

export function ProductSquareSetup({ productId, token, roles = [], data, dirty, busy = false, refreshVersion = 0, onSetup, onBusy, onChanged }) {
  const [setup, setSetup] = useState(null), [loading, setLoading] = useState(true), [search, setSearch] = useState('');
  const [selections, setSelections] = useState({}), [creation, setCreation] = useState(null);
  const [categoryChoice, setCategoryChoice] = useState('');
  const [request, setRequest] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(false), sequence = useRef(0), requestLock = useRef(false);
  const creationReview = useRef(null);
  const callbacks = useRef({ onSetup, onBusy, onChanged });
  callbacks.current = { onSetup, onBusy, onChanged };
  const canRead = canReadSquareSetup(roles), canLink = canLinkSquare(roles), canCreate = canCreateSquare(roles);
  const get = path => adminGet(path, token), post = (path, body) => adminPost(path, token, body);
  async function load(query = search) {
    const version = ++sequence.current;
    const result = await get(`enterprise-pricing/products/${productId}/square-setup${query.trim() ? `?search=${encodeURIComponent(query.trim())}` : ''}`);
    if (mounted.current && version === sequence.current) {
      setSetup(result); callbacks.current.onSetup?.(result);
      setCategoryChoice(result.categoryMapping?.override ? result.categoryMapping.assignment?.categoryIds?.[0] || '' : 'inherit');
      if (recoverableSquareCreation(result.creation)) setCreation(result.creation);
    }
    return result;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; callbacks.current.onBusy?.(false); };
  }, [productId, token]);
  useEffect(() => {
    if (!canRead) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      load().then(() => { if (!cancelled) setError(''); }).catch(e => {
        if (!cancelled) { setError(e.message); callbacks.current.onSetup?.(null); }
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timer); sequence.current++; };
  }, [productId, token, search, refreshVersion, canRead]);
  useEffect(() => {
    if (!creation?.id) return;
    creationReview.current?.scrollIntoView({ block: 'nearest' });
    creationReview.current?.focus({ preventScroll: true });
  }, [creation?.id]);

  const disabled = busy || !!request || loading || dirty || data?.localOnly;
  async function run(text, action) {
    if (disabled || requestLock.current) return;
    requestLock.current = true;
    setRequest(text); setError(''); setMessage(''); callbacks.current.onBusy?.(true);
    try { await action(); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally {
      requestLock.current = false;
      if (mounted.current) { setRequest(''); callbacks.current.onBusy?.(false); }
    }
  }
  async function changed() {
    await load();
    await callbacks.current.onChanged?.();
  }
  const approveLink = (row, candidate) => run('Saving the Square match…', async () => {
    await approveProductSquareLink({ productId, roles, row, candidate, post });
    if (!mounted.current) return;
    setSelections({}); setMessage('Square link saved. Use Sync Square or Sync Both below to check and publish your saved prices.');
    await changed();
  });
  const previewCreation = () => run('Preparing the Square creation preview…', async () => {
    const preview = await previewProductSquareCreation({ productId, roles, get, post });
    if (!mounted.current) return;
    if (preview.status === 'completed') {
      setMessage('This item was already created in Square. Review its existing links below.');
      await changed();
    } else setCreation(preview);
  });
  const create = () => run('Creating the Square item and confirming its links…', async () => {
    try {
      const result = await finishProductSquareCreation({ productId, roles, creation, post });
      if (!mounted.current) return;
      if (result.status !== 'completed') throw new Error('Square creation is awaiting confirmation. Continue this same request.');
      setCreation(null);
      setMessage(`Created ${result.productName} in Square and linked every package. You can sync either destination or both below.`);
      await changed();
    } catch (e) {
      // The server retains the request and any remote receipt. Reopening or
      // retrying always resumes that same creation, including after local edits.
      await load().catch(() => {});
      throw e;
    }
  });
  const refreshCatalog = () => run('Refreshing the Square catalog…', async () => {
    await post('square/cache-sync', {});
    await load();
    setMessage('Square catalog refreshed. Review the available variations below.');
  });
  const missing = setup?.rows?.filter(row => !availableSquareLink(row)) || [];
  const anyLinked = setup?.rows?.some(row => row.linked);
  const creationSaved = setup?.creation;
  return <section className="product-square-setup" aria-label="Square product setup">
    <h4>Square links and creation</h4>
    {!canRead ? <p>Square Pull access is required to review matches and create this item. A publisher with Square Push can sync existing links.</p> : <>
      {loading && <p role="status">Loading this product’s Square links…</p>}
      {setup && <>
        {!setup.enabled ? <p role="alert">The Square connection is not configured.</p>
          : squareSetupReady(setup) ? <p>All packages have a Square link. Use Sync Square or Sync Both below to check and publish saved prices.</p>
          : <p>{missing.length} package{missing.length === 1 ? ' needs' : 's need'} a Square link. Approve an existing variation or review creating this product here.</p>}
        <div className="product-square-setup-tools">
          <label>Search Square items, variations or SKU<input className="input" value={search} onChange={e => setSearch(e.target.value)} disabled={busy || !!request}
            placeholder="Search the existing Square catalog" /></label>
          <button type="button" className="button alt" onClick={refreshCatalog} disabled={disabled || !canLink || !setup.enabled}>Refresh Square catalog</button>
        </div>
        {setup.categoryMapping && <div className="product-square-package">
          <label htmlFor={`square-category-${productId}`}>Square category mapping</label>
          <p>{setup.categoryMapping.categoryNames.length ? setup.categoryMapping.categoryNames.join(', ') : 'Choose a category before creating this product in Square.'}
            {setup.categoryMapping.source === 'category' ? ' (local category default)' : ''}</p>
          <select id={`square-category-${productId}`} className="input" value={categoryChoice} onChange={e => setCategoryChoice(e.target.value)} disabled={disabled || !canLink}>
            <option value="inherit">Use saved item mapping or local category default</option>
            {setup.categoryMapping.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button type="button" className="button alt" disabled={disabled || !canLink || !categoryChoice} onClick={() => run('Saving the category mapping…', async () => {
            await post(`enterprise-pricing/products/${productId}/square-category`, { categoryId: categoryChoice === 'inherit' ? null : categoryChoice, expectedRevision: setup.categoryMapping.revision });
            if (mounted.current) { if (!recoverableSquareCreation(creation)) setCreation(null); setMessage('Square category mapping saved locally. New item creation will include it.'); }
            await load();
          })}>Save category mapping</button>
          <button type="button" className="button alt" disabled={disabled || !canLink} onClick={() => run('Refreshing Square category names…', async () => {
            await post('enterprise-pricing/square-categories/refresh', {}); await load();
            if (mounted.current) setMessage('Square category names refreshed. Saved product assignments are preserved.');
          })}>Refresh category names</button>
          <p className="small">Used when creating a new Square item. Saving this mapping does not move an existing Square item or change its price.</p>
          {setup.categoryMapping.issue && <p role="alert">{setup.categoryMapping.issue}</p>}
        </div>}
        {!setup.rows.length && <p>Add a local package before matching or creating this product in Square.</p>}
        {setup.rows.map(row => {
          const choices = squareMatchChoices(row);
          const selected = selections[row.packageId] ?? row.linked?.squareVariationId ?? '';
          const candidate = choices.find(choice => choice.squareVariationId === selected);
          const savedPrice = data?.output?.packages?.find(pkg => Number(pkg.packageId) === Number(row.packageId));
          const sameLink = Boolean(candidate && row.linked && candidate.squareVariationId === row.linked.squareVariationId);
          return <div className="product-square-package" key={row.packageId}>
            <strong>{row.packageName || 'Package'}</strong>
            <p>Saved Square price: {money(savedPrice?.squareVariationCents)}{data?.input?.pricingUnit ? ` / ${data.input.pricingUnit}` : ''}</p>
            <p>{availableSquareLink(row) ? `Linked: ${label(row.linked)}` : row.linked ? 'The linked Square variation is unavailable. Refresh the catalog and review a replacement.' : 'Not linked to Square.'}</p>
            <div className="product-square-variation-choice"><label htmlFor={`product-square-variation-${productId}-${row.packageId}`}>Square variation for {row.packageName || 'this package'}</label>
              <select id={`product-square-variation-${productId}-${row.packageId}`} className="input" value={selected} onChange={e => setSelections(value => ({ ...value, [row.packageId]: e.target.value }))} disabled={disabled || !canLink}>
                <option value="">Choose an existing Square variation</option>
                {choices.map(choice => <option key={choice.squareVariationId} value={choice.squareVariationId}>{label(choice)} · {money(choice.priceAmount, choice.currency || 'USD')}</option>)}
              </select>
            </div>
            {candidate && <p className="small">Last known Square price: {money(candidate.priceAmount, candidate.currency || 'USD')}. Sync checks the live price and selling unit before publishing.</p>}
            <button type="button" className="button alt" onClick={() => approveLink(row, candidate)} disabled={disabled || !canLink || !candidate || sameLink || !setup.enabled}>
              {sameLink ? 'Link confirmed' : row.linked ? 'Approve replacement link' : 'Approve Square link'}
            </button>
            {!choices.length && <p className="small">No matching variations found. Try another search, refresh the catalog, or review creating a new item.</p>}
          </div>;
        })}
        {!creation && missing.length > 0 && <div className="admin-actions">
          <button type="button" className="button" onClick={previewCreation}
            disabled={disabled || !canCreate || !setup.enabled || anyLinked || !data?.revisionId || creationSaved?.status === 'completed'}>Review Create in Square</button>
          {anyLinked && <p className="small">This product already has a Square item. Add any missing variations in Square, refresh the catalog, then approve their links here.</p>}
          {creationSaved?.status === 'completed' && <p className="small">This item was previously created in Square. Match its existing variations above.</p>}
          {!canCreate && <p className="small">Creating an item requires both Square Pull and Square Push access.</p>}
        </div>}
      </>}
      {creation && <section ref={creationReview} tabIndex={-1} className="product-square-creation-review" aria-label="Review Square creation">
        <h5>{recoverableSquareCreation(creation) ? 'Finish Square creation' : 'Review Create in Square'}</h5>
        <p>Create <strong>{creation.productName}</strong> in Square ({creation.environment}) and link these packages.</p>
        {creation.presentAtAllLocations && <p className="small">The item and variations will be available at all Square locations.</p>}
        {creation.squareCategory && <p>Square category: {creation.squareCategory.categories.map(row => row.name).join(', ')}</p>}
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Package</th><th>Square price</th><th>Selling unit</th></tr></thead><tbody>
          {creation.variations.map(row => <tr key={row.packageId}><td>{row.name}</td><td>{money(row.amount, row.currency)}</td><td>{row.unit || row.sellingUnit?.unit || 'each/package'}</td></tr>)}
        </tbody></table></div>
        {recoverableSquareCreation(creation) && <p>The previous request is awaiting confirmation. Continue to finish linking that same item.</p>}
        {creation.error && <p role="alert">{creation.error}</p>}
        <div className="admin-actions"><button type="button" className="button" onClick={create} disabled={disabled || !canCreate}>
          {recoverableSquareCreation(creation) ? 'Continue creation and linking' : 'Approve creation and link'}</button>
          <button type="button" className="button alt" disabled={!!request || busy} onClick={() => setCreation(null)}>Close preview</button>
          {!recoverableSquareCreation(creation) && <button type="button" className="button text" disabled={disabled || !canCreate} onClick={previewCreation}>Refresh preview</button>}
        </div>
      </section>}
    </>}
    {request && <p role="status" aria-live="polite">{request}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">Square setup could not finish: {error} <button type="button" className="button text" disabled={!!request || busy} onClick={() => {
      setLoading(true); load().then(() => setError('')).catch(e => setError(e.message)).finally(() => setLoading(false));
    }}>Refresh setup</button></p>}
  </section>;
}
