import React, { useEffect, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { markupCategories, usesProductMarkup, markupValue, selectMarkupCategory, percentLabel } from "./enterpriseMarkup.js";
import { PricingEditButton } from "./PricingEditButton.jsx";

const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;

export function MarkupControls({ input, settings, vendor, name, disabled, onChange }) {
  const productSpecific = usesProductMarkup(vendor);
  const defaultBp = settings.markupBp?.[input.markupCategory];
  const overridden = input.customMarkupBp != null && defaultBp != null;
  return <div className="enterprise-markup-controls">
    {!productSpecific && <label>Markup category<select className="input" aria-label={`Markup category for ${name}`} disabled={disabled}
      value={input.markupCategory} onChange={event => onChange(selectMarkupCategory(event.target.value, input, settings))}>
      {Object.entries(markupCategories).map(([key, label]) => <option key={key} value={key}>{label}{settings.markupBp?.[key] != null ? ` · ${percentLabel(settings.markupBp[key])}` : ""}</option>)}
    </select></label>}
    <label>Markup %<input className="input" type="number" min="0" max="1000" step="0.01" disabled={disabled}
      aria-label={`Markup percentage for ${name}`} value={markupValue(input, settings) == null || markupValue(input, settings) === "" ? "" : markupValue(input, settings) / 100}
      onChange={event => onChange({ customMarkupBp: event.target.value === "" ? "" : Math.round(Number(event.target.value) * 100) })} /></label>
    <small>{overridden ? `Product override · category default ${percentLabel(defaultBp)}` : input.markupCategory === "custom" ? "Product-specific markup" : `Category default · ${percentLabel(defaultBp)}`}</small>
    {overridden && <button type="button" disabled={disabled} onClick={() => onChange({ customMarkupBp: null })}>Use category default</button>}
  </div>;
}

export function MarkupCalculation({ input, output, settings }) {
  if (!output) return null;
  const fixed = input.squareEnabled ? input.squareOverride != null && input.squareOverride !== "" : input.csaOverride != null && input.csaOverride !== "";
  return <div className="enterprise-markup-calculation" role="status">
    <div><span>Buy {money(output.buyFromTenThousandths / 100)}</span><span> + {percentLabel(output.appliedMarkupBp)} markup</span><strong> → {money(output.calculatedRetailCents)} target / {input.pricingUnit}</strong></div>
    <div>{input.squareEnabled ? <><strong>Square {money(output.squareUnitCents)}</strong> {fixed ? "(fixed override)" : `(rounded to ${money(settings.squareIncrementCents)})`} → CSA {money(output.csaUnitCents)} (−{percentLabel(settings.localLineDiscountBp)})</> : <strong>CSA {money(output.csaUnitCents)} / {input.pricingUnit}{fixed ? " (fixed override)" : ""}</strong>}</div>
    {fixed && <small>The selling price is fixed. Change or remove its price override in product details to follow markup.</small>}
    {output.effectiveMarkupBp !== output.appliedMarkupBp && <small>Effective selling markup: {percentLabel(output.effectiveMarkupBp)}</small>}
    <small>{output.packages.map(pkg => `LL package ${money(pkg.localLineRegularCents)}`).join(" · ")} · Same price in all four baskets</small>
  </div>;
}

export function EnterpriseMarkupCell({ row, token, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [input, setInput] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    adminGet(`enterprise-pricing/products/${row.id}`, token).then(data => {
      if (cancelled) return;
      setDetail(data);
      setInput({ ...structuredClone(data.suggestedInput), priceEffectiveAt: data.latest?.status === "pending" ? data.suggestedInput.priceEffectiveAt : new Date().toISOString() });
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [editing, row.id, token]);
  useEffect(() => {
    if (!editing || !input || saving) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (input.customMarkupBp === "") { setError("Enter a markup percentage."); return; }
      adminPost(`enterprise-pricing/products/${row.id}/preview`, token, { input }).then(result => {
        if (!cancelled) { setPreview({ ...result, forInput: input }); setError(""); }
      }).catch(err => { if (!cancelled) { setPreview(null); setError(err.message); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [editing, input, row.id, token, saving]);
  const currentPreview = preview?.forInput === input ? preview : null;
  async function save(event) {
    event.preventDefault();
    if (!detail || !input || saving) return;
    if (input.customMarkupBp === "") { setError("Enter a markup percentage."); return; }
    setSaving(true);
    setError("");
    try {
      const result = await adminPost(`enterprise-pricing/products/${row.id}/revisions`, token, { input,
        expectedLatestRevisionId: detail.latest?.id || null, expectedBuyPriceRevision: detail.buyPrice?.revision || 0 });
      setEditing(false); setDetail(null); setInput(null); setPreview(null);
      onSaved(result);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  const bp = row.output?.appliedMarkupBp ?? (row.sourceEvidence?.markupPercent == null ? null : Math.round(row.sourceEvidence.markupPercent * 100));
  if (!editing) return <div className="enterprise-markup-cell">
    <div className="enterprise-pricing-buy-value"><span>{percentLabel(bp)}</span>
      {canEdit && <PricingEditButton label={`Edit markup for ${row.name}`} onClick={() => { setError(""); setEditing(true); }} />}
    </div>
    <small>{usesProductMarkup(row.vendorName) ? "Product-specific" : markupCategories[row.input?.markupCategory] || "Needs category"}{row.input?.markupCategory !== "custom" && row.input?.customMarkupBp != null ? " · override" : ""}</small>
  </div>;
  return <form className="enterprise-markup-inline" onSubmit={save}>
    {detail && input ? <>
      <MarkupControls input={input} settings={detail.settings} vendor={row.vendorName} name={row.name} disabled={saving} onChange={patch => { setInput(value => ({ ...value, ...patch })); setError(""); }} />
    </> : !error && <small>Loading markup…</small>}
    {error && <p role="alert">{error}</p>}
    <div className="admin-actions"><button className="button" type="submit" disabled={saving || !detail || !input || input.customMarkupBp === ""}>{saving ? "Saving…" : "Save"}</button><button className="button alt" type="button" disabled={saving} onClick={() => { setEditing(false); setDetail(null); setInput(null); setPreview(null); }}>Cancel</button></div>
    <small>Save locally and close this row. Publishing is separate.</small>
    {detail && input && <MarkupCalculation input={input} output={currentPreview?.output} settings={detail.settings} />}
  </form>;
}
