import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { isDepositPricing, markupCategories, markupValue, selectMarkupCategory, percentLabel } from "./enterpriseMarkup.js";

const money = cents => `$${(Number(cents) / 100).toFixed(2)}`;
const savedPricingRow = (result, detail) => ({ ...result, buyPrice: {
  cents: Math.round(result.output.buyFromTenThousandths / 100),
  enterpriseId: result.input.retailEnterpriseId,
  revision: (detail.buyPrice?.revision || 0) + 1
} });

export function MarkupControls({ input, settings, vendor, name, disabled, onChange, autoFocus = false, compact = false }) {
  if (compact) {
    const custom = input.markupCategory === "custom" || input.customMarkupBp != null;
    return <div className="enterprise-markup-controls">
      <select className="input" aria-label={`Markup category for ${name}`} disabled={disabled} autoFocus={autoFocus && !custom}
        value={custom ? "custom" : input.markupCategory} onChange={event => onChange(selectMarkupCategory(event.target.value, input, settings))}>
        {Object.entries(markupCategories).map(([key, label]) => <option key={key} value={key}>{label}{settings.markupBp?.[key] != null ? ` · ${percentLabel(settings.markupBp[key])}` : ""}</option>)}
      </select>
      {custom && <div className="enterprise-markup-custom"><input className="input" type="number" min="0" max="1000" step="0.01"
        aria-label={`Markup percentage for ${name}`} disabled={disabled} autoFocus={autoFocus}
        value={markupValue(input, settings) == null || markupValue(input, settings) === "" ? "" : markupValue(input, settings) / 100}
        onChange={event => onChange({ markupCategory: "custom", customMarkupBp: event.target.value === "" ? "" : Math.round(Number(event.target.value) * 100) })} /><span>%</span></div>}
    </div>;
  }
  const custom = input.markupCategory === "custom" || input.customMarkupBp != null;
  return <div className="enterprise-markup-controls">
    <label>Markup category<select className="input" aria-label={`Markup category for ${name}`} disabled={disabled}
      value={custom ? "custom" : input.markupCategory} onChange={event => onChange(selectMarkupCategory(event.target.value, input, settings))}>
      {Object.entries(markupCategories).map(([key, label]) => <option key={key} value={key}>{label}{settings.markupBp?.[key] != null ? ` · ${percentLabel(settings.markupBp[key])}` : ""}</option>)}
    </select></label>
    {custom && <label>Custom markup %<input className="input" type="number" min="0" max="1000" step="0.01" disabled={disabled} autoFocus={autoFocus}
      aria-label={`Markup percentage for ${name}`} value={markupValue(input, settings) == null || markupValue(input, settings) === "" ? "" : markupValue(input, settings) / 100}
      onChange={event => onChange({ markupCategory: "custom", customMarkupBp: event.target.value === "" ? "" : Math.round(Number(event.target.value) * 100) })} /></label>}
  </div>;
}

export function MarkupCalculation({ input, output, settings, packageNames = {} }) {
  if (!output) return null;
  if(input.packages?.some(p=>p.packageBuyPrice!=null&&p.packageBuyPrice!=='')) return <div className="enterprise-markup-calculation" role="status">
    {output.packages.map((pkg,index)=><div key={pkg.packageId}><strong>{packageNames[pkg.packageId] || `Package ${index+1}`}</strong>: Buy {money(pkg.packageBuyPriceCents ?? Math.round(output.buyFromTenThousandths/100*(pkg.quantity||1)))} + {percentLabel(output.appliedMarkupBp)} markup → {input.squareEnabled?<>Square {money(pkg.squareVariationCents)} → </>:null}FF {money(pkg.localLineRegularCents)} per package</div>)}
    {(output.csaOverrideActive||output.squareOverrideActive)&&<small>A fixed retail override takes precedence over the markup calculation.</small>}
  </div>;
  const fixed = input.squareEnabled ? input.squareOverride != null && input.squareOverride !== "" : input.csaOverride != null && input.csaOverride !== "";
  return <div className="enterprise-markup-calculation" role="status">
    <div><span>Buy {money(output.buyFromTenThousandths / 100)}</span><span> + {percentLabel(output.appliedMarkupBp)} markup</span><strong> → {money(output.calculatedRetailCents)} target / {input.pricingUnit}</strong></div>
    <div>{input.squareEnabled ? <><strong>Square {money(output.squareUnitCents)}</strong> {fixed ? "(fixed override)" : `(rounded to ${money(settings.squareIncrementCents)})`} → CSA {money(output.csaUnitCents)} (−{percentLabel(settings.localLineDiscountBp)})</> : <strong>CSA {money(output.csaUnitCents)} / {input.pricingUnit}{fixed ? " (fixed override)" : ""}</strong>}</div>
    {fixed && <small>The selling price is fixed. Change or remove its price override in product details to follow markup.</small>}
    {output.effectiveMarkupBp !== output.appliedMarkupBp && <small>Effective selling markup: {percentLabel(output.effectiveMarkupBp)}</small>}
    <small>{output.packages.map(pkg => `LL package ${money(pkg.localLineRegularCents)}`).join(" · ")} · Same price in all three active baskets</small>
  </div>;
}

export function EnterpriseMarkupCell({ row, token, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [input, setInput] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const dirty = useRef(false);
  const cancelledEdit = useRef(false);
  const open = () => { dirty.current = false; cancelledEdit.current = false; setError(""); setEditing(true); };
  const close = () => { cancelledEdit.current = true; setEditing(false); setDetail(null); setInput(null); };
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
  async function save(event) {
    if (event?.type === "submit") event.preventDefault();
    if (!detail || !input || busy.current || cancelledEdit.current) return;
    if (!dirty.current) { close(); return; }
    if (input.customMarkupBp === "") { setError("Enter a markup percentage."); return; }
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await adminPost(`enterprise-pricing/products/${row.id}/revisions`, token, { input,
        expectedLatestRevisionId: detail.latest?.id || null, expectedBuyPriceRevision: detail.buyPrice?.revision || 0 });
      close();
      onSaved(savedPricingRow(result, detail));
    } catch (err) { setError(err.message); }
    finally { busy.current = false; setSaving(false); }
  }
  if (isDepositPricing(row)) return <div className="enterprise-markup-cell">0%<small className="enterprise-markup-category">Fixed deposit</small></div>;
  const bp = row.output?.appliedMarkupBp ?? row.markupAssignment?.markupBp ?? (row.sourceEvidence?.markupPercent == null ? null : Math.round(row.sourceEvidence.markupPercent * 100));
  const categoryLabel = row.input?.customMarkupBp != null ? "Custom" : markupCategories[row.input?.markupCategory || row.markupAssignment?.category] || "Choose category";
  if (!editing) return <div className="enterprise-markup-cell">
    {canEdit ? <button type="button" className="enterprise-pricing-edit-value" aria-label={`Edit markup for ${row.name}`} onClick={open}>{percentLabel(bp)}</button> : <span>{percentLabel(bp)}</span>}
    <small className="enterprise-markup-category">{canEdit ? <button type="button" className="enterprise-pricing-edit-value" aria-label={`Edit markup category for ${row.name}`}
      onClick={open}>{categoryLabel}</button> : categoryLabel}</small>
  </div>;
  return <form className="enterprise-markup-inline" onSubmit={save}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) save(); }}
    onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      if (event.key === "Tab" && event.target.tagName === "INPUT" && !event.shiftKey) save();
      if (event.key === "Escape" && !busy.current) { event.preventDefault(); close(); }
    }}>
    {detail && input ? <>
      <MarkupControls input={input} settings={detail.settings} vendor={row.vendorName} name={row.name} disabled={saving} autoFocus compact onChange={patch => { dirty.current = true; setInput(value => ({ ...value, ...patch })); setError(""); }} />
    </> : !error && <small>Loading markup…</small>}
    {error && <p role="alert">{error}</p>}
    {saving && <small role="status">Saving…</small>}
  </form>;
}
