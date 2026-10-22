import React, { useEffect, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";

export function EnterprisePricingSettings({ token }) {
  const [current, setCurrent] = useState(null);
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(null);
  const [impact, setImpact] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    const [settings, proposal] = await Promise.all([
      adminGet("enterprise-pricing/settings", token), adminGet("enterprise-pricing/settings/draft", token)
    ]);
    setCurrent(settings); setDraft(proposal?.settings || settings); setPending(proposal);
  }
  useEffect(() => { reload().catch(error => setMessage(error.message)); }, [token]);
  const update = patch => { setDraft(previous => ({ ...previous, ...patch })); setImpact(null); };
  const updateMarkup = (key, amount) => update({ markupBp: { ...draft.markupBp, [key]: Math.round(Number(amount) * 100) } });
  const updateSquareDefault = (key, checked) => update({ squareDefaults: { ...draft.squareDefaults, [key]: checked } });
  async function preview() {
    setBusy(true);
    try { const result = await adminPost("enterprise-pricing/settings/preview", token, { settings: draft }); setImpact(result.affected); setMessage(""); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try { const result = await adminPost("enterprise-pricing/settings/drafts", token, { settings: draft }); setImpact(result.affected); setMessage(`Settings version ${result.id} saved for separate approval.`); await reload(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true);
    try { const result = await adminPost(`enterprise-pricing/settings/drafts/${pending.id}/approve`, token, {}); setMessage(`Settings version ${result.id} approved. ${result.pendingProductCount} affected product proposals require review.`); setImpact(null); await reload(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  if (!draft) return <section className="card"><h2>Pricing settings</h2><p>{message || "Loading…"}</p></section>;
  return <section className="card"><h2>Pricing settings</h2>
    <p>Version {current?.id}. Settings changes generate proposals; current published prices stay in place until each product is approved and verified.</p>
    {pending && <p role="status">Pending version {pending.id}, saved by user {pending.editorId}.</p>}
    {message && <p role="status">{message}</p>}
    <div className="admin-grid">
      <label>Local Line discount %<input className="input" type="number" step="0.01" value={draft.localLineDiscountBp / 100} onChange={event => update({ localLineDiscountBp: Math.round(Number(event.target.value) * 100) })} /></label>
      <label>Square rounding $<input className="input" type="number" step="0.01" value={draft.squareIncrementCents / 100} onChange={event => update({ squareIncrementCents: Math.round(Number(event.target.value) * 100) })} /></label>
      <label>Highly perishable markup %<input className="input" type="number" step="0.01" value={draft.markupBp.highlyPerishable / 100} onChange={event => updateMarkup("highlyPerishable", event.target.value)} /></label>
      <label>Perishable markup %<input className="input" type="number" step="0.01" value={draft.markupBp.perishable / 100} onChange={event => updateMarkup("perishable", event.target.value)} /></label>
      <label>Shelf stable markup %<input className="input" type="number" step="0.01" value={draft.markupBp.shelfStable / 100} onChange={event => updateMarkup("shelfStable", event.target.value)} /></label>
      <label>Different editor and approver<input type="checkbox" checked={draft.requireDifferentApprover !== false} onChange={event => update({ requireDifferentApprover: event.target.checked })} /></label>
      {[["deck", "Deck"], ["hyland", "Hyland"], ["creamyCow", "Creamy Cow"], ["other", "Other vendors"]].map(([key, label]) =>
        <label key={key}>Square default · {label}<input type="checkbox" checked={Boolean(draft.squareDefaults?.[key])} onChange={event => updateSquareDefault(key, event.target.checked)} /></label>)}
    </div>
    <div className="admin-actions"><button className="button alt" type="button" disabled={busy} onClick={preview}>Preview affected products</button>
      {!pending && <button className="button" type="button" disabled={busy || !impact} onClick={save}>Save settings proposal</button>}
      {pending && <button className="button" type="button" disabled={busy} onClick={approve}>Approve settings</button>}
    </div>
    {impact && <div><h3>{impact.length} affected product{impact.length === 1 ? "" : "s"}</h3><div className="table-wrap"><table className="admin-table"><thead><tr><th>Product</th><th>Current Square</th><th>Proposed Square</th><th>Current CSA</th><th>Proposed CSA</th><th>Override</th><th>Review</th></tr></thead><tbody>
      {impact.map(row => <tr key={row.productId}><td>{row.product}</td><td>{row.before?.square == null ? "—" : `$${(row.before.square / 100).toFixed(2)}`}</td><td>{row.after?.square == null ? "—" : `$${(row.after.square / 100).toFixed(2)}`}</td><td>{row.before?.csa == null ? "—" : `$${(row.before.csa / 100).toFixed(2)}`}</td><td>{row.after?.csa == null ? "—" : `$${(row.after.csa / 100).toFixed(2)}`}</td><td>{row.squareOverride || row.csaOverride ? "Yes" : "No"}</td><td>{row.blocked || "—"}</td></tr>)}
    </tbody></table></div></div>}
  </section>;
}
