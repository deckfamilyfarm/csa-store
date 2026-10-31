import { CostFieldInfo } from "./CostFieldInfo.jsx";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, adminPost } from '../adminApi.js';
import { ProductIdentity } from './ProductIdentity.jsx';
import { Comparison } from './ProductSyncReview.jsx';
import { EnterpriseBundles } from './EnterpriseBundles.jsx';
import { LocalPricingSyncReview } from './LocalPricingSyncReview.jsx';
import { useViewportRows } from './useViewportRows.js';
import { canReview, canPublishReview, filterReviewRows, selectedReviewRows, reviewState, reviewMoney,
  reviewComparisons, reviewPriceSummary, reviewWarnings, publishReviewedRevision } from './enterpriseReviewTable.js';

const labels = { unchecked: 'Check needed', checking: 'Checking…', publishing: 'Publishing…', ready: 'Ready to publish', attention: 'Needs review', synced: '✓ Synced' };
export function EnterpriseReviewTable({ token, roles, salesContent }) {
  const [rows, setRows] = useState([]), [localOnly, setLocalOnly] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [errors, setErrors] = useState({}), [selected, setSelected] = useState([]), [detailId, setDetailId] = useState(null);
  const [search, setSearch] = useState(''), [vendor, setVendor] = useState(''), [status, setStatus] = useState('');
  const [tab, setTab] = useState('products'), [receipts, setReceipts] = useState({});
  const operation = useRef(false), stopRequested = useRef(false), selectAll = useRef(null);
  const scroll = useViewportRows(42, !loading && localOnly === false && tab === 'products');
  const load = useCallback(async () => { const value = await adminGet('enterprise-pricing/review', token); setRows(value); return value; }, [token]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([adminGet('enterprise-pricing/review', token), adminGet('enterprise-pricing/summary', token)]).then(([value, summary]) => {
      if (!cancelled) { setRows(value); setLocalOnly(summary.localOnly === true); }
    }).catch(error => { if (!cancelled) setMessage(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);
  const running = rows.some(row => ['checking', 'publishing'].includes(reviewState(row)))
    || Object.values(receipts).some(r => ['queued', 'running'].includes(r.status));
  useEffect(() => {
    if (!running || busy) return;
    let cancelled = false, pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const updated = {};
        for (const [id, receipt] of Object.entries(receipts)) {
          if (['queued', 'running'].includes(receipt.status)) updated[id] = await adminGet(`product-sync/releases/${receipt.id}/progress`, token);
        }
        // The audit endpoint also detects interrupted checks.
        for (const row of rows.filter(row => row.check?.status === 'running')) await adminGet(`product-sync/audits/${row.check.auditId}`, token);
        if (!cancelled) { setReceipts(previous => ({ ...previous, ...updated })); await load(); }
      } catch (error) { if (!cancelled) setMessage(error.message); }
      finally { pending = false; }
    }, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [running, busy, rows, receipts, token, load]);
  const filtered = filterReviewRows(rows, { search, vendor, status });
  const chosen = selectedReviewRows(filtered, selected);
  const ready = chosen.filter(row => reviewState(row) === 'ready' && canPublishReview(row, roles));
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && chosen.length < filtered.length; }, [chosen.length, filtered.length]);
  const changeFilter = (setter, value) => { setter(value); setSelected([]); };
  const detail = rows.find(row => row.id === detailId);
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement;
    const dialog = document.querySelector('.review-detail-dialog');
    dialog?.querySelector('button')?.focus();
    const key = event => {
      if (event.key === 'Escape') setDetailId(null);
      if (event.key === 'Tab') { event.preventDefault(); dialog?.querySelector('button')?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [detailId]);
  async function runBatch(mode, targets) {
    if (operation.current || !targets.length) return;
    if (mode === 'publish' && !window.confirm(`Publish the reviewed changes for ${targets.length} selected products to their applicable channels? ${chosen.length - targets.length} selected products are not ready and will be skipped.`)) return;
    operation.current = true; stopRequested.current = false; setBusy(true);
    let completed = 0, failed = 0;
    try {
      for (const row of targets) {
        if (stopRequested.current) break;
        setMessage(`${mode === 'check' ? 'Checking' : 'Submitting'} ${completed + failed + 1}/${targets.length}: ${row.productName}`);
        try {
          if (mode === 'check') {
            if (['pending', 'local-preview'].includes(row.status)) await adminPost(`enterprise-pricing/revisions/${row.id}/approve`, token, {});
            let audit = await adminPost('product-sync/audits', token, {
              platforms: row.input.squareEnabled ? ['localline', 'square'] : ['localline'], productIds: [row.productId],
              productScope: 'selected', vendorGroup: 'all', enterpriseRevisionId: row.id, incoming: false
            });
            setRows(previous => previous.map(item => item.id === row.id ? { ...item, check: { auditId: audit.id, status: audit.status, actions: [] } } : item));
            // Bound API work: finish this product's check before starting another.
            for (let attempt = 0; audit.status === 'running' && attempt < 150 && !stopRequested.current; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              audit = await adminGet(`product-sync/audits/${audit.id}`, token);
            }
            await load();
            if (audit.status === 'running' && !stopRequested.current) {
              stopRequested.current = true;
              throw new Error('This check is still running. Remaining products have not been checked; refresh to follow progress.');
            }
          } else {
            const receipt = await publishReviewedRevision(row, { get: path => adminGet(path, token), post: (path, body) => adminPost(path, token, body) });
            setReceipts(previous => ({ ...previous, [row.id]: receipt }));
          }
          setErrors(previous => ({ ...previous, [row.id]: '' })); completed++;
        } catch (error) { failed++; setErrors(previous => ({ ...previous, [row.id]: error.message })); }
      }
      await load();
      setMessage(`${completed} products ${mode === 'check' ? 'submitted for checking' : 'submitted for publication'}${failed ? `; ${failed} need attention (see row details)` : ''}${stopRequested.current ? '; stopped before remaining products' : ''}.`);
    } catch (error) { setMessage(error.message); }
    finally { operation.current = false; setBusy(false); }
  }
  async function retry(row, releaseId) {
    if (operation.current || !canPublishReview(row, roles)) return;
    if (!window.confirm(`Retry saved publication ${releaseId} for ${row.productName}?`)) return;
    operation.current = true; setBusy(true);
    try {
      const receipt = await adminPost(`product-sync/releases/${releaseId}/retry`, token, { background: true });
      setReceipts(previous => ({ ...previous, [row.id]: receipt })); await load();
    } catch (error) { setErrors(previous => ({ ...previous, [row.id]: error.message })); }
    finally { operation.current = false; setBusy(false); }
  }
  const checkable = chosen.filter(row => !['checking', 'publishing'].includes(reviewState(row)) && !row.check?.actions?.some(a => a.released && a.releaseStatus !== 'completed'));
  return <section className="card enterprise-review-page">
    <div className="review-heading"><h2>Review &amp; Publish</h2><div role="tablist" aria-label="Publication type">
      {['products', 'bundles', 'sales'].map(value => <button className={`button ${tab === value ? '' : 'alt'}`} role="tab" aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
    </div></div>
    {message && <p className="review-message" role="status">{message}</p>}
    {tab === 'bundles' && <EnterpriseBundles token={token} roles={roles} review />}
    {tab === 'sales' && salesContent}
    {tab === 'products' && <>
      {loading ? <p>Loading prices and saved checks…</p> : localOnly ? <LocalPricingSyncReview revisions={rows} /> : <>
        <div className="review-filters">
          <input className="input" aria-label="Search products" placeholder="Search products or vendors" value={search} onChange={e => changeFilter(setSearch, e.target.value)} disabled={busy} />
          <select className="input" aria-label="Vendor" value={vendor} onChange={e => changeFilter(setVendor, e.target.value)} disabled={busy}><option value="">All vendors</option>{[...new Set(rows.map(row => row.vendorName).filter(Boolean))].sort().map(name => <option key={name}>{name}</option>)}</select>
          <select className="input" aria-label="Sync status" value={status} onChange={e => changeFilter(setStatus, e.target.value)} disabled={busy}><option value="">All sync statuses</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button className="button alt" disabled={busy || !checkable.length || !canReview(roles)} onClick={() => runBatch('check', checkable)}>Approve &amp; check selected ({checkable.length})</button>
          <button className="button" disabled={busy || !ready.length} onClick={() => runBatch('publish', ready)}>Publish selected ({ready.length})</button>
          {busy && <button className="button alt" onClick={() => { stopRequested.current = true; }}>Stop after current product</button>}
          <button className="button alt" disabled={busy} onClick={() => load().catch(error => setMessage(error.message))}>Refresh</button>
        </div>
        <div className="review-table-scroll" ref={scroll} role="region" aria-label="Product publication table" tabIndex={0}>
          <table className="admin-table review-product-table"><thead><tr>
            <th><input ref={selectAll} type="checkbox" aria-label="Select all matching products" disabled={busy || !filtered.length} checked={filtered.length > 0 && chosen.length === filtered.length} onChange={e => setSelected(e.target.checked ? filtered.map(row => row.id) : [])} /></th>
            <th>Product</th><th>Cost <CostFieldInfo /></th><th>Markup</th><th>LL channel → local package</th><th>Square channel → local</th><th>Sync / review</th>
          </tr></thead><tbody>{filtered.map(row => {
            const state = reviewState(row), warnings = [errors[row.id], ...reviewWarnings(row)].filter(Boolean);
            const releases = [...new Map((row.check?.actions || []).filter(a => a.releaseId && ['partial', 'failed', 'held', 'scheduled'].includes(a.publicationStatus)).map(a => [a.releaseId, a])).values()];
            return <tr key={row.id}>
              <td><input type="checkbox" aria-label={`Select ${row.productName}`} checked={selected.includes(row.id)} disabled={busy} onChange={e => setSelected(previous => e.target.checked ? [...previous, row.id] : previous.filter(id => id !== row.id))} /></td>
              <td><ProductIdentity name={row.productName} unit={row.input.pricingUnit} vendor={row.vendorName} href="#review-details" onClick={e => { e.preventDefault(); setDetailId(row.id); }} /></td>
              <td>{reviewMoney(row.output.buyFromTenThousandths / 100)} / {row.input.pricingUnit}</td>
              <td>{Number(row.output.appliedMarkupBp ?? row.input.customMarkupBp ?? 0) / 100}%</td>
              <td title="Open product details for every package and basket">{reviewPriceSummary(row, 'Local Line', 'currentCents')} → {reviewPriceSummary(row, 'Local Line', 'localCents')}</td>
              <td>{row.input.squareEnabled ? `${reviewPriceSummary(row, 'Square', 'currentCents')} → ${reviewPriceSummary(row, 'Square', 'localCents')} / ${row.input.pricingUnit}` : 'n/a'}</td>
              <td><button className={`review-status ${errors[row.id] ? 'attention' : state}`} onClick={() => setDetailId(row.id)}>{errors[row.id] ? 'Needs review' : labels[state]}</button>
                {warnings.length > 0 && <span className="review-warning" title={warnings.join('\n')}>{warnings[0]}</span>}
                {releases.map(item => <button className="button alt" key={item.releaseId} disabled={busy || !canPublishReview(row, roles)} onClick={() => retry(row, item.releaseId)}>Retry #{item.releaseId}</button>)}
              </td>
            </tr>;
          })}{!filtered.length && <tr><td colSpan={7}>No products match these filters.</td></tr>}</tbody></table>
        </div>
        <div className="review-pagination">{filtered.length} products · {chosen.length} selected · Prices reflect the last channel check. Open a product for details.</div>
      </>}
    </>}
    {detail && <div className="review-detail-overlay"><div className="review-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="review-detail-title">
      <div className="review-heading"><h3 id="review-detail-title">{detail.productName}</h3><button className="button alt" onClick={() => setDetailId(null)}>Close</button></div>
      <p>{labels[reviewState(detail)]}{detail.check ? ` · Check #${detail.check.auditId}` : ' · Approve and check before publishing'}</p>
      {[errors[detail.id], ...reviewWarnings(detail)].filter(Boolean).map((text, i) => <p role="status" key={i}>{text}</p>)}
      <table className="admin-table"><thead><tr><th>Channel / package / basket</th><th>Channel price</th><th>Local price</th></tr></thead><tbody>{reviewComparisons(detail).map((item, i) => <tr key={i}><td>{item.destination} · {item.label}</td><td>{reviewMoney(item.currentCents)}</td><td>{reviewMoney(item.localCents)}</td></tr>)}</tbody></table>
      {detail.check?.actions?.map(action => <div key={action.id}><h4>{action.platform === 'square' ? 'Square' : 'Local Line'} · {action.releaseStatus || action.status}</h4>{action.display && <Comparison action={action} />}</div>)}
    </div></div>}
  </section>;
}
