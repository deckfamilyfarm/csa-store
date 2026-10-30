import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { adminGet, adminPut } from "../adminApi.js";
import { ProductImages } from "./ProductImages.jsx";
import { productCapabilities } from "./productWorkspace.js";

// Retain simple storefront formatting without executing imported HTML.
export function safeDescription(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const allowed = new Set(["P", "BR", "DIV", "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "H2", "H3", "H4", "A", "SPAN"]);
  for (const node of [...template.content.querySelectorAll("*")].reverse()) {
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH"].includes(node.tagName)) { node.remove(); continue; }
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    for (const attr of [...node.attributes]) {
      if (!(node.tagName === "A" && attr.name === "href" && /^(https?:\/\/|mailto:|\/[^/]|#)/i.test(attr.value))) node.removeAttribute(attr.name);
    }
  }
  return template.innerHTML;
}
const fields = product => ({ name: product.name || "", vendorId: String(product.vendorId || ""),
  excludeFromSnap: Boolean(product.excludeFromSnap), excludeFromGuest: Boolean(product.excludeFromGuest), categoryId: String(product.categoryId || ""), description: safeDescription(product.description) });

export const ProductEditorInfo = forwardRef(function ProductEditorInfo({ productId, token, roles, vendors, busy, onDirty, onSaved, onImageBusy }, ref) {
  const [product, setProduct] = useState(null);
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const canEdit = productCapabilities(roles).edit;
  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([adminGet(`products/${productId}`, token), adminGet("categories", token)]).then(([data, categoryData]) => {
      if (cancelled) return;
      setProduct(data.product); setDraft(fields(data.product)); setBaseline(fields(data.product)); setCategories(categoryData.categories);
    }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [productId, token, retry]);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useImperativeHandle(ref, () => ({
    async save() {
      if (!dirty) return;
      if (!canEdit) throw new Error("You do not have permission to edit product info.");
      if (!draft.name.trim() || !draft.vendorId) throw new Error("Product name and vendor are required.");
      const payload = Object.fromEntries(Object.keys(draft).filter(key => draft[key] !== baseline[key]).map(key =>
        [key, typeof draft[key] === "boolean" ? draft[key] : key === "vendorId" ? Number(draft[key]) : key === "categoryId" ? Number(draft[key]) || null : key === "description" ? safeDescription(draft[key]) : draft[key].trim()]));
      if (["excludeFromSnap","excludeFromGuest"].some(k=>k in payload)) payload.expectedBasketEligibility = {excludeFromSnap:baseline.excludeFromSnap,excludeFromGuest:baseline.excludeFromGuest};
      const result = await adminPut(`products/${productId}`, token, payload);
      if (!result.ok) throw new Error("Product info was not saved.");
      const saved = { ...draft, ...(payload.description !== undefined ? { description: payload.description } : {}) };
      setDraft(saved); setBaseline(saved); onDirty(false);
      onSaved({ ...payload, vendorName: vendors.find(v => String(v.id) === draft.vendorId)?.name });
    }
  }), [draft, baseline, dirty, canEdit, productId, token, vendors, onDirty, onSaved]);
  const update = patch => setDraft(value => ({ ...value, ...patch }));
  return <>
    <section id="editor-info" className="product-editor-section"><h3>Product info</h3>
      {error && <p role="alert">{error} <button type="button" className="button alt" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {!draft && !error && <p>Loading product info…</p>}
      {draft && <div className="product-editor-info-fields">
        {!vendors.some(vendor => String(vendor.id) === draft.vendorId && vendor.name?.trim()) &&
          <p role="alert">This product needs a vendor. Choose one below and save before changing pricing, inventory, or synchronizing.</p>}
        <ProductInfoFields draft={draft} baseline={baseline} vendors={vendors} categories={categories} disabled={!canEdit || busy} update={update} />
        <ProductImages productId={productId} token={token} images={product.images || []} name={draft.name} disabled={!canEdit || busy}
          onBusy={onImageBusy} onImages={images => setProduct(value => ({ ...value, images }))} />
      </div>}
    </section>
    <section id="editor-inventory" className="product-editor-section"><h3>Inventory</h3>
      {product ? <><div className="product-editor-inventory"><span>On farm: {product.stockOnFarm == null ? "Not checked" : product.stockOnFarm ? "Yes" : "No"}</span>
        <span>On-farm pounds: {product.stockOnFarmLbs ?? "Unknown"}</span>
        <span>Full Farm quantity: {product.inventory ?? "—"}</span><span>Tracking: {product.trackInventory ? "On" : "Off"}</span></div>
        <p className="small">Manage stock, tracking, and visibility in Store → Inventory.</p></> : <p>Loading inventory…</p>}
    </section>
  </>;
});

export function ProductInfoFields({ draft, baseline, vendors, categories, disabled, update }) {
  const description = useRef(null);
  useEffect(() => { if (description.current) description.current.innerHTML = baseline?.description || ""; }, [baseline?.description]);
  return <>
        <label>Name<input className="input" disabled={disabled} value={draft.name} onChange={event => update({ name: event.target.value })} /></label>
        <label>Vendor<select className="input" disabled={disabled} value={draft.vendorId} onChange={event => update({ vendorId: event.target.value, ...(/creamy cow/i.test(vendors.find(v=>String(v.id)===event.target.value)?.name || "") ? {excludeFromGuest:true} : {}) })}>
          <option value="">Select vendor</option>{vendors.map(vendor => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
        </select></label>
        <label>Category<select className="input" disabled={disabled} value={draft.categoryId} onChange={event => update({ categoryId: event.target.value })}>
          <option value="">Uncategorized</option>{categories.filter(category => category.name?.toLowerCase() !== "membership").map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <div className="product-basket-exclusions">
          <label><input type="checkbox" disabled={disabled} checked={Boolean(draft.excludeFromSnap)} onChange={e=>update({excludeFromSnap:e.target.checked})} /> Exclude from SNAP</label>
          <label><input type="checkbox" disabled={disabled} checked={Boolean(draft.excludeFromGuest)} onChange={e=>update({excludeFromGuest:e.target.checked})} /> Exclude from Guest</label>
          {/creamy cow/i.test(vendors.find(v=>String(v.id)===String(draft.vendorId))?.name || '') && <span className="small">Creamy Cow: only hard cheeses may be offered to guests.</span>}
        </div>
        <div><span id="editor-description-label">Description</span>
          <div className="product-editor-description" ref={description} role="textbox" aria-labelledby="editor-description-label" aria-multiline="true"
            contentEditable={!disabled} suppressContentEditableWarning onInput={event => update({ description: safeDescription(event.currentTarget.innerHTML) })}
            onPaste={event => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); }} />
        </div>
  </>;
}
