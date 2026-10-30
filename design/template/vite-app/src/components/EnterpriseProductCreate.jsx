import React, { useEffect, useRef, useState } from "react";
import { adminGet, adminPost, adminUploadImage } from "../adminApi.js";
import { ProductEditorDialog } from "./ProductEditorDialog.jsx";
import { ProductInfoFields, safeDescription } from "./ProductEditorInfo.jsx";
import { ProductPricingFields } from "./ProductPricingFields.jsx";

const recoveryKey = "enterprise-product-create-request";
const emptyProduct = { name: "", vendorId: "", categoryId: "", description: "", excludeFromSnap:false, excludeFromGuest:false };
function savedRequest() {
  try { return JSON.parse(sessionStorage.getItem(recoveryKey)); } catch { return null; }
}
export function EnterpriseProductCreate({ token, onClose, onCreated }) {
  const [request, setRequest] = useState(savedRequest);
  const [product, setProduct] = useState(() => savedRequest()?.product || emptyProduct);
  const [input, setInput] = useState(() => savedRequest()?.input || null);
  const infoBaseline = useRef(product);
  const [options, setOptions] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [retry, setRetry] = useState(0);
  const photoRef = useRef([]);
  const saving = useRef(false);
  useEffect(() => { photoRef.current = photos; }, [photos]);
  useEffect(() => () => photoRef.current.forEach(photo => URL.revokeObjectURL(photo.url)), []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([adminGet("vendors", token), adminGet("categories", token), adminGet("enterprise-pricing/settings", token), adminGet("enterprise-pricing/enterprises", token)])
      .then(([vendors, categories, settings, enterprises]) => {
        if (cancelled) return;
        setOptions({ vendors: vendors.vendors, categories: categories.categories, settings, enterprises });
        const enterpriseId = enterprises.find(row => row.code === "ffcsa")?.id || enterprises[0]?.id;
        setInput(value => value || { retailEnterpriseId: enterpriseId, priceEffectiveAt: new Date().toISOString(),
          pricingUnit: "", markupCategory: "shelfStable", customMarkupBp: null, squareEnabled: false,
          squareOverride: null, csaOverride: null, overrideNote: "", saleBp: 0,
          purchaseCosts: [{ enterpriseId, cost: "", effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }],
          packages: [{ packageId: 1, name: "", quantity: 1 }], wholesale: [] });
      }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [token, retry]);
  useEffect(() => {
    setPreview(null); setPreviewError("");
    if (!input || request || createdId) return;
    let cancelled = false;
    const timer = setTimeout(() => adminPost("enterprise-pricing/products/preview", token, { product, input })
      .then(value => { if (!cancelled) setPreview(value); })
      .catch(error => { if (!cancelled) setPreviewError(error.message); }), 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [product, input, token, request, createdId, retry]);
  const update = patch => { setPreview(null); setInput(value => ({ ...value, ...patch })); };
  function updateProduct(patch) {
    setPreview(null); setProduct(value => ({ ...value, ...patch }));
    if (patch.vendorId !== undefined && options) {
      const vendor = options.vendors.find(v => String(v.id) === String(patch.vendorId))?.name || "";
      const key = /deck family farm/i.test(vendor) ? "deck" : /hyland/i.test(vendor) ? "hyland" : /creamy cow/i.test(vendor) ? "creamyCow" : "other";
      update({ markupCategory: key === "deck" || key === "hyland" ? "deckHyland" : key === "creamyCow" ? "creamyCow" : "shelfStable",
        customMarkupBp: null, squareEnabled: options.settings.squareDefaults?.[key] === true, squareOverride: null, csaOverride: null });
    }
  }
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    let id = createdId;
    try {
      if (!id) {
        const pending = request || { product: { ...product, description: safeDescription(product.description) }, input, previewHash: preview?.previewHash, creationKey: crypto.randomUUID() };
        // Keep the exact request across lost responses and reloads.
        sessionStorage.setItem(recoveryKey, JSON.stringify(pending)); setRequest(pending);
        const result = await adminPost("enterprise-pricing/products", token, pending);
        id = result.productId; setCreatedId(id); setRequest(null); sessionStorage.removeItem(recoveryKey);
      }
      for (const photo of photos) {
        await adminUploadImage(id, token, photo.file);
        URL.revokeObjectURL(photo.url);
        setPhotos(value => value.filter(item => item !== photo));
      }
      onCreated(id);
    } catch (error) {
      if (!id && [400, 403, 409].includes(error.status)) {
        sessionStorage.removeItem(recoveryKey); setRequest(null); setRetry(value => value + 1);
      }
      setError(id ? `Product saved. Photo upload failed: ${error.message}. Retry the remaining photos or open the product.` : error.message);
    } finally { saving.current = false; setBusy(false); }
  }
  function close() {
    if (busy) return;
    if (createdId) { if (!photos.length || window.confirm("The product is saved. Open it without the remaining photos?")) onCreated(createdId); return; }
    if (request) { setError("The creation result is uncertain. Retry to recover the original product before closing."); return; }
    if ((product !== emptyProduct || photos.length || input?.purchaseCosts.some(cost => cost.cost)) && !window.confirm("Discard this new product?")) return;
    onClose();
  }
  const disabled = busy || !!request || !!createdId;
  return <ProductEditorDialog title="Add product" sections={[["editor-info", "Product info"], ["editor-pricing", "Pricing"], ["editor-packages", "Packages"], ["editor-wholesale", "Wholesale"], ["editor-photos", "Photos"], ["editor-inventory", "Inventory"], ["editor-sales", "Sales & sync"]]}
    showNeighbors={false} busy={busy} dirty={!createdId || photos.length > 0} onClose={close} message={error || previewError || (request ? "Recover the previous creation request by retrying." : "Create saves our prices; channel publication is separate.")}
    footer={<><button type="button" className="button alt" disabled={busy} onClick={close}>{createdId ? "Open saved product" : "Cancel"}</button>
      <button type="button" className="button" disabled={busy || (!preview && !request && !createdId)} onClick={save}>{busy ? "Saving…" : createdId ? "Retry photos" : request ? "Retry creation" : "Create product"}</button></>}>
    {!options || !input ? <p>{error || "Loading product fields…"} {error && <button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry</button>}</p> : <>
      <fieldset className="enterprise-pricing-editor" disabled={disabled}>
        <section id="editor-info" className="product-editor-section"><h3>Product info</h3><div className="product-editor-info-fields">
          <ProductInfoFields draft={product} baseline={infoBaseline.current} vendors={options.vendors} categories={options.categories} disabled={disabled} update={updateProduct} />
          <p className="small">Deposits and membership fees use their existing dedicated workflows.</p>
        </div></section>
        <ProductPricingFields draft={input} detail={{ ...options, product: { ...product, vendorName: options.vendors.find(v => String(v.id) === String(product.vendorId))?.name }, packages: input.packages }} preview={preview} update={update} creating loading={disabled} />
      </fieldset>
      <section id="editor-photos" className="product-editor-section"><h3>Photos</h3>
        <div className="product-editor-images">{photos.map(photo => <div key={photo.url}><img src={photo.url} alt={photo.file.name} /><button type="button" className="button alt" disabled={busy} onClick={() => { URL.revokeObjectURL(photo.url); setPhotos(value => value.filter(item => item !== photo)); }}>Remove photo</button></div>)}</div>
        <label>Add photos<input type="file" multiple accept="image/*" disabled={busy || !!request} onChange={event => {
          setPhotos(value => [...value, ...Array.from(event.target.files || [], file => ({ file, url: URL.createObjectURL(file) }))]); event.target.value = "";
        }} /></label><p className="small">Photos upload after the product is saved. Failed uploads can be retried.</p>
      </section>
      <section id="editor-inventory" className="product-editor-section"><h3>Inventory</h3><p>Starts hidden, with zero Full Farm stock and tracking off. On-farm status and pounds start unknown. Manage these in Store → Inventory.</p></section>
      <section id="editor-sales" className="product-editor-section"><h3>Sales & sync</h3><p>Create regular pricing first. Then use Sales to propose a promotion and Sync to review channel publication. Creating a product does not create a listing in Square or Local Line.</p></section>
    </>}
  </ProductEditorDialog>;
}
