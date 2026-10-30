import React, { useEffect, useRef, useState } from "react";
import { adminPost } from "../adminApi.js";

const dollars = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
const localDateTime = date => {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return copy.toISOString().slice(0, 16);
};

export function EnterprisePromotionEditor({ token, product, packages, squareEnabled, onSaved, onDirtyChange, onBusyChange }) {
  const [packageIds, setPackageIds] = useState([]);
  const [name, setName] = useState("");
  const [discountPercent, setDiscountPercent] = useState("20");
  const [startAt, setStartAt] = useState(localDateTime(new Date(Date.now() + 3600000)));
  const [endAt, setEndAt] = useState(localDateTime(new Date(Date.now() + 25 * 3600000)));
  const [untilTurnedOff, setUntilTurnedOff] = useState(true);
  const [squareIncluded, setSquareIncluded] = useState(Boolean(squareEnabled));
  const [localLineIncluded, setLocalLineIncluded] = useState(true);
  const [squareLocationIds, setSquareLocationIds] = useState("");
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const signature = JSON.stringify([packageIds, name, discountPercent, startAt, untilTurnedOff ? null : endAt, squareIncluded, localLineIncluded, squareLocationIds]);
  const baseline = useRef(signature);
  useEffect(() => { onDirtyChange?.(signature !== baseline.current); }, [signature, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const input = () => ({
    name, discountBp: Math.round(Number(discountPercent) * 100), packageIds,
    startAt: new Date(startAt).toISOString(), endAt: untilTurnedOff ? null : new Date(endAt).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channels: [localLineIncluded ? "localline" : null, squareIncluded ? "square" : null].filter(Boolean),
    squareLocationIds: squareIncluded ? squareLocationIds.split(",").map(value => value.trim()).filter(Boolean) : []
  });
  async function submit(save) {
    setBusy(true);
    try {
      const value = await adminPost(save ? "enterprise-promotions" : "enterprise-promotions/preview", token, { input: input() });
      setPreview(value);
      setMessage(save ? `Sale proposal ${value.id} saved for separate approval.` : "Sale preview is ready. Regular prices stay unchanged.");
      if (save) { baseline.current = signature; onDirtyChange?.(false); onSaved?.(); }
    } catch (error) { setPreview(null); setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <details className="card" style={{ marginTop: 16 }}>
    <summary>Plan a sale for {product.name}</summary>
    <p className="small">Sales use approved regular prices. Square’s normal catalog prices stay intact.</p>
    <div className="admin-grid">
      <label>Sale name<input className="input" value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Discount %<input className="input" type="number" min="0.01" max="99.99" step="0.01" value={discountPercent} onChange={event => setDiscountPercent(event.target.value)} /></label>
      <label>Start<input className="input" type="datetime-local" value={startAt} onChange={event => setStartAt(event.target.value)} /></label>
      <label><input type="checkbox" checked={untilTurnedOff} onChange={event => setUntilTurnedOff(event.target.checked)} /> Until I turn it off</label>
      {!untilTurnedOff && <label>End<input className="input" type="datetime-local" value={endAt} onChange={event => setEndAt(event.target.value)} /></label>}
    </div>
    <fieldset><legend>Packages</legend>{packages.map(pkg => <label key={pkg.packageId} style={{ marginRight: 16 }}><input type="checkbox" checked={packageIds.includes(Number(pkg.packageId))} onChange={event => setPackageIds(previous => event.target.checked ? [...previous, Number(pkg.packageId)] : previous.filter(id => id !== Number(pkg.packageId)))} /> {pkg.name}</label>)}</fieldset>
    {squareEnabled && <label><input type="checkbox" checked={localLineIncluded} onChange={event => setLocalLineIncluded(event.target.checked)} /> Include Local Line sale</label>}
    {squareEnabled && <label><input type="checkbox" checked={squareIncluded} onChange={event => setSquareIncluded(event.target.checked)} /> Include Square automatic discount</label>}
    {squareIncluded && <label>Square location IDs<input className="input" placeholder="Comma-separated Square location IDs" value={squareLocationIds} onChange={event => setSquareLocationIds(event.target.value)} /></label>}
    <div className="admin-actions"><button className="button alt" type="button" disabled={busy} onClick={() => submit(false)}>Preview sale</button><button className="button" type="button" disabled={busy || !preview} onClick={() => submit(true)}>Save sale proposal</button></div>
    {message && <p role="status">{message}</p>}
    {localLineIncluded && preview?.output?.localLinePrices?.map(row => <p className="small" key={row.packageId}>Package {row.packageId}: {dollars(row.regularCents)} regular → {dollars(row.saleCents)} sale in all three active Local Line baskets.</p>)}
  </details>;
}
