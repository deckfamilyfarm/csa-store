import React, { useEffect, useState } from 'react';
import { adminGet, adminPut } from '../adminApi.js';

export function AdminStorefront({ token, onVisibilityChange }) {
  const [saved, setSaved] = useState(null);
  const [showProducts, setShowProducts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function load() {
    setError('');
    try {
      const settings = await adminGet('storefront/settings', token);
      setSaved(settings); setShowProducts(settings.showProducts);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [token]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const settings = await adminPut('storefront/settings', token, { showProducts, version: saved.version });
      setSaved(settings);
      setMessage(settings.showProducts ? 'Products are visible on the public store.' : 'The public store shows Coming Soon. Products are hidden.');
      onVisibilityChange?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="admin-section">
    <h3>Storefront</h3>
    <p>Control the Full Farm Version 2 store landing page. Turkey preorders are managed separately under Turkey Preorders.</p>
    <p><strong>Saved visibility: {saved ? saved.showProducts ? 'Products visible' : 'Coming Soon — products hidden' : 'Loading…'}</strong></p>
    <form className="admin-form" onSubmit={save}>
      <label className="filter-toggle"><input type="checkbox" checked={showProducts} disabled={!saved || busy} onChange={event => { setShowProducts(event.target.checked); setMessage(''); }} /> Show products on the public store</label>
      <p className="small">Leave this off to display “Coming Soon, Full Farm Version 2 store.” Use the staff preview to test the catalog without showing it to visitors.</p>
      <div className="home-store-actions">
        <button className="button" disabled={!saved || busy || showProducts === saved.showProducts}>{busy ? 'Saving…' : 'Save store visibility'}</button>
        <a className="button alt" href="/?experience=store&storePreview=1#/home" target="_blank" rel="noreferrer">Preview products as staff</a>
        <a className="button alt" href="/?experience=store#/home" target="_blank" rel="noreferrer">View store</a>
      </div>
      {error ? <div role="alert">{error} <button className="button alt" type="button" onClick={load} disabled={busy}>Reload settings</button></div> : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  </section>;
}
