import React from "react";
import { MarkupControls, MarkupCalculation } from "./EnterpriseMarkup.jsx";
const textValue = value => value ?? "";
const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
const localDateTime = value => {
  if (!value) return "";
  const raw = String(value);
  const date = new Date(raw.includes(" ") ? raw.replace(" ", "T") + "Z" : raw);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function ProductPricingFields({ draft, detail, preview, canEdit = true, loading = false, update, creating = false }) {
  const changeRow = (key, index, patch) => update({ [key]: draft[key].map((row, i) => i === index ? { ...row, ...patch } : row) });
  const updateCost = (i, patch) => changeRow("purchaseCosts", i, patch);
  const updatePackage = (i, patch) => changeRow("packages", i, patch);
  const updateWholesale = (i, patch) => changeRow("wholesale", i, patch);
  return <>
      <section id="editor-pricing" className="product-editor-section"><h3>Pricing</h3>
      <div className="admin-grid enterprise-pricing-editor-grid">
        <label>Retail purchasing enterprise<select className="input" disabled={!canEdit || loading} value={textValue(draft.retailEnterpriseId)} onChange={event => update({ retailEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select></label>
        <label>Pricing effective time<input className="input" type="datetime-local" disabled={!canEdit || loading} value={localDateTime(draft.priceEffectiveAt)} onChange={event => update({ priceEffectiveAt: event.target.value ? new Date(event.target.value).toISOString() : "" })} /></label>
        <label>Pricing unit<select className="input" disabled={!canEdit || loading} value={textValue(draft.pricingUnit)} onChange={event => update({ pricingUnit: event.target.value })}><option value="">Select unit</option><option value="lb">per lb</option><option value="each">per each</option></select></label>
        <MarkupControls input={draft} settings={detail.settings} vendor={detail.product.vendorName} name={detail.product.name} disabled={!canEdit || loading} onChange={update} />
        <label>Square enabled<input type="checkbox" disabled={!canEdit || loading} checked={Boolean(draft.squareEnabled)} onChange={event => update({ squareEnabled: event.target.checked, csaOverride: event.target.checked ? null : draft.csaOverride, squareOverride: event.target.checked ? draft.squareOverride : null })} /></label>
        <label>Square override<input className="input" type="number" step="0.50" disabled={!canEdit || loading || !draft.squareEnabled} value={textValue(draft.squareOverride)} onChange={event => update({ squareOverride: event.target.value || null })} /></label>
        <label>CSA-only override<input className="input" type="number" step="0.01" disabled={!canEdit || loading || draft.squareEnabled} value={textValue(draft.csaOverride)} onChange={event => update({ csaOverride: event.target.value || null })} /></label>
        <label>Override note<input className="input" disabled={!canEdit || loading} value={draft.overrideNote || ""} onChange={event => update({ overrideNote: event.target.value })} /></label>
      </div>
      <h4>Buy Prices</h4><p className="small">Set the price paid by each purchasing enterprise. Cost-plus wholesale prices use that enterprise’s Buy Price. Packages can have their own Buy Price below; those costs stay fixed when the default changes.</p>
      {draft.purchaseCosts.map((cost, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={index}>
        <select className="input" disabled={!canEdit || loading} aria-label="Purchasing enterprise" value={cost.enterpriseId} onChange={event => updateCost(index, { enterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        <input className="input" aria-label="Buy Price" type="number" step="0.01" min="0.01" disabled={!canEdit || loading} value={textValue(cost.cost)} onChange={event => updateCost(index, { cost: event.target.value })} />
        <input className="input" aria-label="Cost effective date" type="date" disabled={!canEdit || loading} value={String(cost.effectiveAt || "").slice(0, 10)} onChange={event => updateCost(index, { effectiveAt: event.target.value })} />
        <input className="input" aria-label="Documentation reference" disabled={!canEdit || loading} placeholder="Document reference" value={cost.documentationRef || ""} onChange={event => updateCost(index, { documentationRef: event.target.value })} />
        {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: draft.purchaseCosts.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: [...draft.purchaseCosts, { enterpriseId: detail.enterprises[0]?.id, cost: "", effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }] })}>Add Buy Price</button>}
      <MarkupCalculation input={draft} output={preview?.output} settings={detail.settings} packageNames={Object.fromEntries(detail.packages.map(p=>[p.packageId,p.name]))} />
      </section>
      <section id="editor-packages" className="product-editor-section"><h3>Packages</h3>
      {draft.packages.map((pkg, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={pkg.packageId}>
        {creating ? <label>Package name<input className="input" value={pkg.name || ""} onChange={event => updatePackage(index, { name: event.target.value })} /></label> : <strong>{detail.packages.find(row => Number(row.packageId) === Number(pkg.packageId))?.name || pkg.packageId}</strong>}
        {draft.pricingUnit === "lb" ? <>
          <label>Minimum lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.minWeight)} onChange={event => updatePackage(index, { minWeight: event.target.value })} /></label>
          <label>Maximum lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.maxWeight)} onChange={event => updatePackage(index, { maxWeight: event.target.value })} /></label>
          <label>Average override lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.avgWeightOverride)} onChange={event => updatePackage(index, { avgWeightOverride: event.target.value })} /></label>
        </> : <label>Units in package<input className="input" type="number" min="1" step="1" disabled={!canEdit || loading} value={textValue(pkg.quantity)} onChange={event => updatePackage(index, { quantity: event.target.value })} /></label>}
        {draft.pricingUnit === "each" && <label>Package Buy Price<input className="input" type="number" min="0.01" step="0.01" disabled={!canEdit || loading}
          aria-label={`Package Buy Price for ${pkg.name || detail.packages.find(row=>Number(row.packageId)===Number(pkg.packageId))?.name || 'package'}`}
          placeholder="Use default × quantity" value={textValue(pkg.packageBuyPrice)} onChange={event=>updatePackage(index,{packageBuyPrice:event.target.value || null,packageBuyPriceEnterpriseId:Number(draft.retailEnterpriseId)})} />
          <small>Total cost of this package. Blank uses the default Buy Price × quantity.</small></label>}
        <span>FF Package Price {money(preview?.output?.packages?.find(row => row.packageId === Number(pkg.packageId))?.localLineRegularCents)}</span>
        {creating && draft.packages.length > 1 && <button type="button" className="button alt" onClick={() => update({ packages: draft.packages.filter((_, i) => i !== index) })}>Remove package</button>}
      </div>)}
      {creating && <button type="button" className="button alt" onClick={() => update({ packages: [...draft.packages, { packageId: Math.max(...draft.packages.map(p => p.packageId)) + 1, name: "", quantity: 1 }] })}>Add package</button>}
      </section>
      <section id="editor-wholesale" className="product-editor-section"><h3>Wholesale resale prices</h3>
      {draft.wholesale.map((row, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={index}>
        <select className="input" aria-label="Selling enterprise" disabled={!canEdit || loading} value={row.sellingEnterpriseId} onChange={event => updateWholesale(index, { sellingEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        <select className="input" aria-label="Wholesale mode" disabled={!canEdit || loading} value={row.mode} onChange={event => updateWholesale(index, { mode: event.target.value })}><option value="fixed">Fixed</option><option value="markup">Cost plus markup</option></select>
        {row.mode === "fixed" ? <input className="input" aria-label="Fixed wholesale price" type="number" step="0.01" disabled={!canEdit || loading} value={textValue(row.fixedPrice)} onChange={event => updateWholesale(index, { fixedPrice: event.target.value })} /> : <>
          <input className="input" aria-label="Wholesale markup percentage" type="number" step="0.01" disabled={!canEdit || loading} value={row.markupBp == null ? "" : Number(row.markupBp) / 100} onChange={event => updateWholesale(index, { markupBp: Math.round(Number(event.target.value) * 100) })} />
          <select className="input" aria-label="Cost enterprise" disabled={!canEdit || loading} value={row.costEnterpriseId || row.sellingEnterpriseId} onChange={event => updateWholesale(index, { costEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        </>}
        {canEdit && <button className="button alt" type="button" onClick={() => update({ wholesale: draft.wholesale.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {canEdit && <button className="button alt" type="button" onClick={() => update({ wholesale: [...draft.wholesale, { sellingEnterpriseId: detail.enterprises[0]?.id, mode: "fixed", fixedPrice: "" }] })}>Add wholesale price</button>}
      </section>
  </>;
}
