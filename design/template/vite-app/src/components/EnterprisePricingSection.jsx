import { CostFieldInfo } from "./CostFieldInfo.jsx";
import { EnterpriseInventoryCell } from "./EnterpriseInventoryCell.jsx";
import { EnterpriseVisibilityCell } from "./EnterpriseVisibilityCell.jsx";
import { EnterpriseSaleCell, SalePrice } from "./EnterpriseSaleCell.jsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { EnterprisePromotionEditor } from "./EnterprisePromotionEditor.jsx";
import { EnterpriseMarkupCell } from "./EnterpriseMarkup.jsx";
import { ProductEditorDialog } from "./ProductEditorDialog.jsx";
import { ProductPricingFields } from "./ProductPricingFields.jsx";
import { EnterpriseProductCreate } from "./EnterpriseProductCreate.jsx";
import { ProductEditorInfo } from "./ProductEditorInfo.jsx";
import { PricingSyncStatus } from "./PricingSyncStatus.jsx";
import { ProductPricingWarnings } from "./ProductPricingWarnings.jsx";
import { productPricingWarnings as productWarnings } from './pricingWarningDetails.js';
import { ProductPricingSync } from "./ProductPricingSync.jsx";
import { ProductIdentity } from "./ProductIdentity.jsx";
import { InlinePricingValue } from "./InlinePricingValue.jsx";
import { EnterpriseBundles } from './EnterpriseBundles.jsx';
import { usesProductMarkup, isDepositPricing, depositBaseCents, productPricingUnit } from "./enterpriseMarkup.js";
import "./EnterprisePricingSection.css";

const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
const dollars = amount => amount == null ? "—" : `$${Number(amount).toFixed(2)}`;
const vendorLabel = name => String(name || "").replace(/\s+\(local sample\)$/i, "");
const productHref = id => {
  const url = new URL(window.location.href);
  url.searchParams.set("pricingProduct", String(id));
  return `${url.pathname}${url.search}${url.hash}`;
};
const columns = [
  ["name", "Product"], ["buyFrom", "Cost"],
  ["markup", "Markup"], ["csa", "FF Unit Price"],
  ["sale", "Sale"], ["llPackage", "FF Package Price"], ["square", "Square"], ["wholesale", "Wholesale"], ["visibility", "FF Visible"], ["inventory", "FF Inventory"], ["sync", "Sync"]
];

export function EnterprisePricingSection({ token, roles = [] }) {
  const [creating, setCreating] = useState(false);
  const [createdProductId, setCreatedProductId] = useState(null);
  const onAddProduct = () => setCreating(true);
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('pricingTab') === 'bundles' ? 'bundles' : 'products');
  const selectTab = value => {
    setTab(value);
    const url = new URL(window.location.href); url.searchParams.set('pricingTab', value);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  return <div className="pricing-workspace"><div className="pricing-type-tabs"><h2>Pricing</h2><div role="tablist" aria-label="Pricing product type">
    {['products','bundles'].map(value => <button key={value} role="tab" id={`pricing-${value}-tab`} aria-controls={`pricing-${value}-panel`} aria-selected={tab===value}
      tabIndex={tab===value?0:-1} onClick={()=>selectTab(value)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'products':e.key==='End'?'bundles':value==='products'?'bundles':'products';selectTab(next);document.getElementById(`pricing-${next}-tab`)?.focus();}}}>{value==='products'?'Products':'Bundles'}</button>)}
  </div>{tab === "products" && onAddProduct && roles.some(role => ["admin", "pricing_admin", "pricing_editor", "local_pricelist_admin"].includes(role)) && <button className="button alt" type="button" onClick={onAddProduct}>+ Add product</button>}</div>
    <div role="tabpanel" id="pricing-products-panel" aria-labelledby="pricing-products-tab" hidden={tab!=='products'}><EnterpriseProductsSection token={token} roles={roles} createdProductId={createdProductId} /></div>
    <div role="tabpanel" id="pricing-bundles-panel" aria-labelledby="pricing-bundles-tab" hidden={tab!=='bundles'}><EnterpriseBundles token={token} roles={roles} active={tab==='bundles'} /></div>
    {creating && <EnterpriseProductCreate token={token} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setCreatedProductId(id); }} />}
  </div>;
}

function EnterpriseProductsSection({ token, roles = [], createdProductId }) {
  const tableScrollRef = useRef(null);
  const productInfoRef = useRef(null);
  const saveBusy = useRef(false);
  const [pricingBaseline, setPricingBaseline] = useState(null);
  const [infoDirty, setInfoDirty] = useState(false);
  const [saleDirty, setSaleDirty] = useState(false);
  const [saleBusy, setSaleBusy] = useState(false);
  const [syncRequestBusy, setSyncRequestBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [rows, setRows] = useState([]);
  const [inventoryPageVersion,setInventoryPageVersion]=useState(0);
  const [inventoryRefreshing,setInventoryRefreshing]=useState(false);
  const inventoryRefreshBusy=useRef(false);
  const [vendors, setVendors] = useState([]);
  const [enterprises, setEnterprises] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(() => Number(new URLSearchParams(window.location.search).get("pricingProduct")) || null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [editorSection, setEditorSection] = useState(null);
  const [vendorFilter, setVendorFilter] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [snapEligibility, setSnapEligibility] = useState("");
  const [guestEligibility, setGuestEligibility] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState("");
  const [saleFilter, setSaleFilter] = useState("");
  const [squareFilter, setSquareFilter] = useState("");
  const [sort, setSort] = useState({ key: "name", direction: "asc" });
  const [warningRow, setWarningRow] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [markupRefresh, setMarkupRefresh] = useState(0);
  const canEdit = roles.some(role => ["admin", "pricing_admin", "pricing_editor", "local_pricelist_admin"].includes(role));

  useEffect(() => {
    if (createdProductId) { selectProduct(createdProductId, true); setMarkupRefresh(value => value + 1); }
  }, [createdProductId]);
  async function duplicateProduct() {
    if (!detail || loading || saleBusy || saveBusy.current) return;
    if (editorDirty) { setMessage("Save or discard your changes before duplicating this product."); return; }
    saveBusy.current = true; setLoading(true);
    try {
      const result = await adminPost(`products/${selectedId}/duplicate`, token, { forPricing: true });
      selectProduct(result.productId, true);
      setMarkupRefresh(value => value + 1);
      setMessage("Product duplicated locally. Review its name and pricing before publishing.");
    } catch (error) { setMessage(error.message); }
    finally { saveBusy.current = false; setLoading(false); }
  }

  useLayoutEffect(() => {
    const table = tableScrollRef.current;
    if (!table) return;
    // Reserve space for pagination; retain a usable table on short/mobile screens.
    const resize = () => {
      const top = table.getBoundingClientRect().top + window.scrollY;
      table.style.setProperty("--pricing-table-height", `${Math.max(240, window.innerHeight - top - 44)}px`);
    };
    const observer = new ResizeObserver(resize);
    for (const element of [table.parentElement, table.closest(".admin-layout"), document.querySelector(".admin-header")]) {
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", resize);
    resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search, syncStatus: status, vendorId: vendorFilter, pricingUnit: unitFilter,
        markupCategory: categoryFilter, square: squareFilter, sale: saleFilter, visibility: visibilityFilter, snapEligibility, guestEligibility, sort: sort.key, sortDirection: sort.direction,
        limit: "100", offset: String(page * 100) });
      adminGet(`enterprise-pricing/products?${params}`, token)
        .then(data => { if (!cancelled) { setRows(data.rows); setInventoryPageVersion(v=>v+1); setVendors(data.vendors); setEnterprises(data.enterprises); setTotal(data.total); } })
        .catch(error => { if (!cancelled) setMessage(error.message); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, search, status, vendorFilter, unitFilter, categoryFilter, squareFilter, saleFilter, visibilityFilter, snapEligibility, guestEligibility, sort, page, loading, markupRefresh]);
  async function refreshInventory() {
    if(inventoryRefreshBusy.current||summary?.localOnly!==false||!rows.length)return;
    inventoryRefreshBusy.current=true;setInventoryRefreshing(true);
    const ids=rows.map(r=>r.id);
    try {
      const result=await adminPost('products/inventory/refresh',token,{productIds:ids});
      const results=new Map(result.rows.map(r=>[Number(r.productId),r]));
      setRows(current=>current.map(row=>{const stock=results.get(row.id);return !stock?row:stock.error?{...row,ffInventoryError:stock.error}:{...row,ffInventorySnapshot:stock,ffInventory:stock.inventory,ffTrackInventory:stock.trackInventory,ffInventoryCheckedAt:stock.checkedAt,ffInventoryError:null};}));
    }catch(e){setRows(current=>current.map(row=>ids.includes(row.id)?{...row,ffInventoryError:e.message}:row));}
    finally{inventoryRefreshBusy.current=false;setInventoryRefreshing(false);}
  }
  useEffect(()=>{
    let cancelled=false,timer;
    const run=()=>{if(cancelled)return;if(inventoryRefreshBusy.current){timer=setTimeout(run,300);return;}refreshInventory();};
    run();return()=>{cancelled=true;clearTimeout(timer);};
  },[inventoryPageVersion,summary?.localOnly]);
  useEffect(() => { adminGet("enterprise-pricing/summary", token).then(setSummary).catch(() => {}); }, [token, loading, markupRefresh]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetailError("");
    adminGet(`enterprise-pricing/products/${selectedId}`, token).then(data => {
      if (cancelled) return;
      setDetail(data);
      const nextDraft = { ...structuredClone(data.suggestedInput),
        priceEffectiveAt: data.latest?.status === "pending" ? data.suggestedInput.priceEffectiveAt : new Date().toISOString() };
      setDraft(nextDraft); setPricingBaseline(JSON.stringify(nextDraft));
      setPreview(data.latest ? { output: data.latest.output } : null);
    }).catch(error => { if (!cancelled) setDetailError(error.message); });
    return () => { cancelled = true; };
  }, [selectedId, token, detailRefresh]);

  useEffect(() => {
    if (!warningRow) return undefined;
    const onKeyDown = event => { if (event.key === "Escape") setWarningRow(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [warningRow]);

  useEffect(() => {
    if (!selectedId || !draft || !canEdit || Number(detail?.product.id) !== Number(selectedId) || isDepositPricing(detail?.product)) return;
    if (detail.product.vendorRequired) { setPreview(null); return; }
    setPreview(null);
    if (draft.customMarkupBp === "") { setMessage("Enter a markup percentage."); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      adminPost(`enterprise-pricing/products/${selectedId}/preview`, token, { input: draft })
        .then(value => { if (!cancelled) { setPreview(value); } })
        .catch(error => { if (!cancelled) { setPreview(null); setMessage(error.message); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedId, token, draft, canEdit, detail]);

  const visible = rows;
  const changeSort = key => {
    setSort(current => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
    setPage(0);
  };
  const sourcePackage = evidence => evidence?.packages?.[0] || null;
  const update = patch => setDraft(previous => ({ ...previous, ...patch }));


  async function saveBuyPrice(row, value) {
    const saved = await adminPost(`enterprise-pricing/products/${row.id}/buy-price`, token,
      { price: Number(value).toFixed(2), expectedRevision: row.buyPrice?.revision || 0 });
    setRows(current => current.map(item => item.id === row.id ? { ...item, buyPrice: saved, sync: null,
      ...(saved.pricing ? { input: saved.pricing.input, output: saved.pricing.output, status: saved.pricing.status,
        latestRevisionId: saved.pricing.revisionId, activeRevisionId: saved.pricing.revisionId } : {}) } : item));
    if (Number(selectedId) === Number(row.id)) {
      setDetail(current => current ? { ...current, buyPrice: saved,
        ...(saved.pricing ? { latest: { ...current.latest, id: saved.pricing.revisionId, status: saved.pricing.status,
          input: saved.pricing.input, output: saved.pricing.output } } : {}) } : current);
      setDraft(current => current ? {
        ...current, purchaseCosts: current.purchaseCosts.some(cost => Number(cost.enterpriseId) === saved.enterpriseId)
          ? current.purchaseCosts.map(cost => Number(cost.enterpriseId) === saved.enterpriseId
            ? { ...cost, cost: (saved.cents / 100).toFixed(2) } : cost)
          : [...current.purchaseCosts, { enterpriseId: saved.enterpriseId, cost: (saved.cents / 100).toFixed(2),
            effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }]
      } : current);
    }
    setMarkupRefresh(value => value + 1);
    setMessage(saved.pricing ? "Cost saved. Updated selling prices are now in use locally." : "Cost saved. Complete the product’s pricing inputs to calculate selling prices.");
  }

  const pricingDirty = !!draft && !isDepositPricing(detail?.product) && JSON.stringify(draft) !== pricingBaseline;
  const editorDirty = pricingDirty || infoDirty || saleDirty;
  const selectedIndex = rows.findIndex(row => Number(row.id) === Number(selectedId));
  const canLeaveEditor = () => !saveBusy.current && !saleBusy && !syncRequestBusy && (!editorDirty || window.confirm("Discard unsaved changes to this product?"));
  function selectProduct(id, force = false, section = null) {
    if (!force && !canLeaveEditor()) return;
    if (!id && selectedId) setMarkupRefresh(value => value + 1);
    setEditorSection(section);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("pricingProduct", String(id)); else url.searchParams.delete("pricingProduct");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setSelectedId(id); setDetail(null); setDraft(null); setPreview(null); setPricingBaseline(null); setInfoDirty(false); setSaleDirty(false); setSaleBusy(false); setDetailError(""); setMessage("");
  }
  async function save(closeAfter = false) {
    if (!detail || !draft || saveBusy.current) return;
    saveBusy.current = true; setLoading(true); setMessage("");
    let infoSaved = false;
    try {
      if (infoDirty) { await productInfoRef.current.save(); infoSaved = true; }
      if (pricingDirty) {
        const result = await adminPost(`enterprise-pricing/products/${selectedId}/revisions`, token, {
          input: draft, expectedLatestRevisionId: detail.latest?.id || null,
          expectedBuyPriceRevision: detail.buyPrice?.revision || 0
        });
        setRows(current => current.map(row => Number(row.id) === Number(selectedId) ? { ...row, sync: null } : row));
        setPricingBaseline(JSON.stringify(draft));
        setDetailRefresh(value => value + 1);
        setMessage("Prices saved and now in use. Channel synchronization is separate.");
      } else setMessage("Product info saved locally.");
      setMarkupRefresh(value => value + 1);
      if (closeAfter && (!saleDirty || window.confirm("Your sale proposal has unsaved changes. Discard it and go back?"))) selectProduct(null, true);
    } catch (error) { setMessage(`${infoSaved ? "Product info saved. Pricing was not saved: " : ""}${error.message}`); }
    finally { saveBusy.current = false; setLoading(false); }
  }


  return <section className="card enterprise-pricing-page">
    <div className="admin-grid enterprise-pricing-filters">
      <label>Search<input className="input" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Product or vendor" /></label>
      <label>Vendor<select className="input" value={vendorFilter} onChange={event => { setVendorFilter(event.target.value); setPage(0); }}><option value="">All vendors</option>{vendors.map(vendor => <option value={vendor.id} key={vendor.id}>{vendorLabel(vendor.name)}</option>)}</select></label>
      <label>Sync status<select className="input" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">All</option><option value="synced">Synced</option><option value="localline">Needs LL sync</option><option value="square">Needs Square sync</option><option value="inputs">Needs pricing inputs</option></select></label>
      <label>Unit<select className="input" value={unitFilter} onChange={event => { setUnitFilter(event.target.value); setPage(0); }}><option value="">All units</option><option value="lb">lb</option><option value="each">each</option></select></label>
      <label>Markup category<select className="input" value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value); setPage(0); }}><option value="">All categories</option><option value="highlyPerishable">Highly perishable</option><option value="perishable">Perishable</option><option value="shelfStable">Shelf stable</option><option value="deckHyland">DFF markup</option><option value="creamyCow">Creamy Cow Markup</option><option value="custom">Custom</option></select></label>
      <label>Square<select className="input" value={squareFilter} onChange={event => { setSquareFilter(event.target.value); setPage(0); }}><option value="">All</option><option value="enabled">Enabled</option><option value="disabled">Not sold</option></select></label>
      <label>Sale<select className="input" value={saleFilter} onChange={e=>{setSaleFilter(e.target.value);setPage(0);}}><option value="">All</option><option value="on">On sale</option><option value="off">Not on sale</option></select></label>
      <button className="button alt" type="button" disabled={inventoryRefreshing||summary?.localOnly!==false} onClick={refreshInventory}>{inventoryRefreshing?'Checking FF inventory…':'Refresh FF inventory'}</button>
      <label>SNAP<select className="input" value={snapEligibility} onChange={e=>{setSnapEligibility(e.target.value);setPage(0);}}><option value="">All</option><option value="excluded">Excluded</option><option value="included">Not excluded</option></select></label>
      <label>Guest<select className="input" value={guestEligibility} onChange={e=>{setGuestEligibility(e.target.value);setPage(0);}}><option value="">All</option><option value="excluded">Excluded</option><option value="included">Not excluded</option></select></label>
      <label>FF visibility<select className="input" value={visibilityFilter} onChange={e=>{setVisibilityFilter(e.target.value);setPage(0);}}><option value="">All</option><option value="visible">Visible</option><option value="hidden">Hidden</option></select></label>
     </div>
    {message && !selectedId && <p role="status">{message}</p>}
    {summary && !summary.localOnly && <p className="small">{summary.byStatus.pending || 0} awaiting approval · {summary.byStatus.approved || 0} ready to check · {summary.byStatus.partial || 0} partially published · {(summary.problems.blocked || 0) + (summary.problems.failed || 0)} requiring review · {summary.sales?.active || 0} active sales · {summary.sales?.partial || 0} sale failures · {summary.byStatus.active || 0} active prices{summary.lastVerifiedAt ? ` · last verified ${new Date(summary.lastVerifiedAt).toLocaleString()}` : ""}</p>}
    <div className="table-wrap enterprise-pricing-table-wrap" ref={tableScrollRef} role="region" aria-label="Pricing table" tabIndex={0}><table className="admin-table enterprise-pricing-table"><thead><tr>{columns.map(([key, label]) =>
      <th key={key} scope="col" aria-sort={key === "sync" ? undefined : sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
        {key === "sync" ? label : <button type="button" className="enterprise-pricing-sort" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? sort.direction === "asc" ? " ▲" : " ▼" : " ↕"}</span></button>}
        {key === "buyFrom" && <CostFieldInfo />}
      </th>)}</tr></thead>
      <tbody>{visible.map(row => {
        const source = row.sourceEvidence;
        const pkg = sourcePackage(source);
        const missingChannelPrice = usesProductMarkup(row.vendorName) ? "—" : "n/a";
        const deposit = isDepositPricing(row);
        const packageCosts=row.input?.packages?.some(p=>p.packageBuyPrice!=null&&p.packageBuyPrice!=='');
        const packageName=id=>row.legacy?.packages?.find(p=>Number(p.id)===Number(id))?.name || 'Package';
        return <tr key={row.id}>
        <td><div className="enterprise-pricing-product-line">
          <ProductIdentity name={row.name} thumbnailUrl={row.thumbnailUrl}
            unit={(row.legacy?.packages || []).map(pkg => pkg.name).filter(Boolean).join(" · ") || row.input?.pricingUnit || source?.unit || row.legacy?.pricingUnit}
            vendor={vendorLabel(row.vendorName)} href={productHref(row.id)} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            selectProduct(row.id);
          }} />
          {productWarnings(row).length > 0 && <button type="button" className="enterprise-pricing-warning" aria-label={`Show warnings for ${row.name}`} onClick={() => setWarningRow(row)}>⚠</button>}
        </div></td>
        <td>{packageCosts ? row.output?.packages.map(p=><div key={p.packageId}><button type="button" className="enterprise-pricing-edit-value" onClick={()=>selectProduct(row.id,false,'editor-packages')}>{money(p.packageBuyPriceCents ?? Math.round(row.output.buyFromTenThousandths/100*(p.quantity||1)))}</button><small>{packageName(p.packageId)}</small></div>) : deposit ? <span title="Fixed deposit package amount; no markup">{money(depositBaseCents(row))}</span> : <InlinePricingValue label={`Cost for ${row.name}`} canEdit={canEdit} min={0.01}
          display={row.buyPrice ? money(row.buyPrice.cents) : row.output?.buyFromTenThousandths != null ? dollars(row.output.buyFromTenThousandths / 10000) : "—"}
          value={row.buyPrice ? (row.buyPrice.cents / 100).toFixed(2) : row.output?.buyFromTenThousandths != null ? (row.output.buyFromTenThousandths / 10000).toFixed(2) : ""}
          onSave={value => saveBuyPrice(row, value)} />}</td>
        <td><EnterpriseMarkupCell row={row} token={token} canEdit={canEdit} onSaved={result => {
          setRows(current => current.map(item => item.id === row.id ? { ...item, input: result.input, output: result.output, sync: null,
            status: result.status, latestRevisionId: result.revisionId, buyPrice: result.buyPrice || item.buyPrice } : item));
          setMarkupRefresh(value => value + 1);
          setMessage("Markup saved. Updated prices are now in use; channel synchronization is separate.");
        }} /></td>
        <td>{packageCosts ? "Per package" : row.output ? money(row.output.csaUnitCents) : money(pkg?.estimatedCsaUnitCents)}
          {!packageCosts && (row.output?.csaUnitCents ?? pkg?.estimatedCsaUnitCents) != null && <small>{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small>}
        </td>
        <td><EnterpriseSaleCell row={row} token={token} canEdit={canEdit && !deposit} onReview={()=>selectProduct(row.id,false,"editor-sales")} onSaved={()=>{setMarkupRefresh(v=>v+1);setMessage("Sale saved locally. Review & Publish will update the channels.");}} /></td>
        <td>{row.output?.packages?.length ? row.output.packages.map(item => {
          const packageName = row.legacy?.packages?.find(pkg => Number(pkg.id) === Number(item.packageId))?.name
            || (row.legacy?.packages?.length === 1 ? row.legacy.packages[0].name : "");
          return <div key={item.packageId}><SalePrice regular={item.localLineRegularCents} sale={item.localLineSaleCents} /><small>per package{packageName ? ` · ${packageName}` : ""}</small></div>;
        }) : source?.packages?.length ? source.packages.map(item => <div key={item.name}>{money(item.displayedPriceCents)}{item.displayedPriceCents != null && <small>per package{item.name ? ` · ${item.name}` : ""}</small>}</div>) : "—"}</td>
        <td>{packageCosts && row.input?.squareEnabled ? row.output.packages.map(p=><div key={p.packageId}><SalePrice regular={p.squareVariationCents} sale={p.squareSaleCents}/><small>per package · {packageName(p.packageId)}</small></div>) : row.output ? row.input?.squareEnabled ? <><SalePrice regular={row.output.squareUnitCents} sale={row.output.squareSaleUnitCents} /><small title="Local selling unit to publish to Square">{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small></> : missingChannelPrice : source?.square?.length ? source.square.map((price, index) => <div key={index}>{money(price.priceCents)}{price.priceCents != null && <small title="Local selling unit to publish to Square">{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small>}</div>) : missingChannelPrice}</td>
        <td>{row.output?.wholesale?.length ? row.output.wholesale.map(price => `${enterprises.find(item => Number(item.id) === price.sellingEnterpriseId)?.name || price.sellingEnterpriseId}: ${money(price.priceCents)}`).join(" · ") : missingChannelPrice}</td>
        <td><EnterpriseVisibilityCell row={row} token={token} roles={roles} localOnly={summary?.localOnly !== false} onSaved={visible=>{
          setRows(current=>current.map(item=>item.id===row.id?{...item,ffVisible:visible}:item));
          setMarkupRefresh(value=>value+1);
          setMessage(`${row.name} is now ${visible?'visible':'hidden'} in Full Farm. Confirmed in Local Line.`);
        }} /></td>
        <td><EnterpriseInventoryCell row={row} token={token} roles={roles} localOnly={summary?.localOnly !== false} onSaved={(quantity,snapshot)=>{
          setRows(current=>current.map(item=>item.id===row.id?{...item,ffInventorySnapshot:snapshot,ffInventory:quantity,ffTrackInventory:snapshot?.trackInventory??item.ffTrackInventory,ffInventoryCheckedAt:new Date().toISOString(),ffInventoryError:null}:item));
          setMessage(`${row.name}: FF inventory updated to ${quantity}. Confirmed in Local Line.`);
        }} /></td>
        <td><PricingSyncStatus row={row} onReview={() => selectProduct(row.id, false, "editor-sync")} /></td>
      </tr>; })}</tbody></table></div>
    <div className="admin-actions enterprise-pricing-pagination">
      {summary?.localOnly && <span className="enterprise-pricing-footer-status">{summary.byStatus["local-preview"] || 0} products using local prices · {summary.byStatus.unresolved || 0} need pricing inputs · Review &amp; Publish compares channel prices</span>}
      <div className="enterprise-pricing-page-controls"><button className="button alt" type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>{total ? `${page * 100 + 1}–${Math.min((page + 1) * 100, total)} of ${total}` : "0 products"}</span><button className="button alt" type="button" disabled={(page + 1) * 100 >= total} onClick={() => setPage(value => value + 1)}>Next</button></div>
    </div>
    {warningRow && <div className="enterprise-pricing-warning-backdrop" role="presentation" onClick={() => setWarningRow(null)}>
      <div className="card enterprise-pricing-warning-dialog" role="dialog" aria-modal="true" aria-label={`Warnings for ${warningRow.name}`} onClick={event => event.stopPropagation()}>
        <div className="admin-section-heading"><h3>{warningRow.name}: warnings</h3><button className="button alt" type="button" autoFocus onClick={() => setWarningRow(null)}>Close</button></div>
        <ProductPricingWarnings row={warningRow} token={token} onOpenSync={() => { const id = warningRow.id; setWarningRow(null); selectProduct(id, false, "editor-sync"); }} />
      </div>
    </div>}
    {selectedId && <ProductEditorDialog key={selectedId} name={detail?.product.name || rows.find(row => Number(row.id) === Number(selectedId))?.name}
      initialSection={editorSection}
      busy={loading || saleBusy || syncRequestBusy} dirty={editorDirty} message={message || detailError}
      onClose={() => selectProduct(null)}
      onPrevious={selectedIndex > 0 ? () => selectProduct(rows[selectedIndex - 1].id) : null}
      onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => selectProduct(rows[selectedIndex + 1].id) : null}
      sections={[["editor-info", "Product info"], ["editor-inventory", "Inventory"],
        ...(!detail || isDepositPricing(detail.product) ? [] : [["editor-pricing", "Pricing"], ["editor-packages", "Packages"], ["editor-wholesale", "Wholesale"], ["editor-sales", "Sales"]]),
        ["editor-channels", "Channel prices"], ["editor-sync", "Sync"]]}
      footer={<><button type="button" className="button alt" disabled={loading || syncRequestBusy} onClick={() => selectProduct(null)}>Back</button>
        {canEdit && <button type="button" className="button alt" disabled={loading || saleBusy || syncRequestBusy || !detail || editorDirty} title={editorDirty ? "Save or discard changes before duplicating" : "Create a separate local copy"} onClick={duplicateProduct}>Duplicate product</button>}
        {(canEdit || roles.some(role => ["admin", "inventory_admin", "pricing_admin", "local_pricelist_admin"].includes(role))) && <>
          <button type="button" className="button alt" disabled={loading || saleBusy || syncRequestBusy || !(pricingDirty || infoDirty) || (pricingDirty && !preview?.output)} onClick={() => save(false)}>{loading ? "Saving…" : "Save"}</button>
          <button type="button" className="button" disabled={loading || saleBusy || syncRequestBusy || !(pricingDirty || infoDirty) || (pricingDirty && !preview?.output)} onClick={() => save(true)}>Save and go back</button>
        </>}</>}>
      {!detail && <section className="product-editor-section"><p role="status">{detailError || "Loading product…"}</p>
        {detailError && <button type="button" className="button alt" onClick={() => setDetailRefresh(value => value + 1)}>Retry</button>}</section>}
      {detail && draft && <fieldset id="pricing-product-detail" className="enterprise-pricing-editor" disabled={loading || saleBusy || syncRequestBusy}>
      <ProductEditorInfo ref={productInfoRef} productId={selectedId} token={token} roles={roles} vendors={vendors} busy={loading || saleBusy}
        onDirty={setInfoDirty} onImageBusy={setSaleBusy} onSaved={updates => {
          setDetail(value => ({ ...value, product: { ...value.product, ...updates,
            vendorRequired: updates.vendorId ? false : value.product.vendorRequired } }));
          setRows(value => value.map(row => Number(row.id) === Number(selectedId) ? { ...row, ...updates } : row));
        }} />
      {isDepositPricing(detail.product) ? <p className="small">Fixed deposit amount, with no markup. Managed through the existing deposit workflow.</p> : <p className="small">{summary?.localOnly ? "Saving updates local prices immediately. Review & Publish compares channel prices." : "Saving updates our prices immediately. Review & Publish approves channel synchronization."} {detail.product.approvedSquareLinks ? `${detail.product.approvedSquareLinks} Square variation link(s).` : "Square mapping required if enabled."}</p>}
      {!isDepositPricing(detail.product) && <>
      <ProductPricingFields draft={draft} detail={detail} preview={preview} canEdit={canEdit} loading={loading} update={update} />
      <section id="editor-sales" className="product-editor-section"><h3>Sales</h3>
      {rows.find(row=>Number(row.id)===Number(selectedId)) && <EnterpriseSaleCell row={rows.find(row=>Number(row.id)===Number(selectedId))} token={token} canEdit={canEdit} onReview={()=>setMessage("Review the existing promotion in Review & Publish → Sales.")} onSaved={()=>{setMarkupRefresh(v=>v+1);setMessage("Sale saved locally. Publish it from Review & Publish → Sales.");}} />}
      {!detail.active && <p>Save regular pricing before planning a sale.</p>}
      {canEdit && detail.active && <EnterprisePromotionEditor token={token} product={detail.product} packages={detail.packages} squareEnabled={detail.active.input.squareEnabled} onDirtyChange={setSaleDirty} onBusyChange={setSaleBusy} onSaved={() => setMessage("Sale proposal saved. Open Review & Publish for approval.")} />}
      </section>
      </>}
      <section id="editor-channels" className="product-editor-section"><h3>Channel prices</h3>
      {detail.sourceEvidence ? <details open className="enterprise-pricing-source-detail">
        <summary>Package and channel prices</summary>
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Package</th><th>Package price</th><th>Square</th><th>CSA unit</th><th>Local Line baskets</th></tr></thead><tbody>
          {detail.sourceEvidence.packages.map(pkg => <tr key={pkg.name}><td>{pkg.name}</td><td>{money(pkg.storedSourcePriceCents)}</td><td>{detail.sourceEvidence.square.filter(price => price.packageName === pkg.name).map(price => money(price.priceCents)).join(", ") || "—"}</td><td>{money(pkg.estimatedCsaUnitCents)}</td><td>{Object.entries(pkg.basketPricesCents).map(([name, amount]) => `${name}: ${money(amount)}`).join(" · ") || "—"}</td></tr>)}
        </tbody></table></div>
      </details> : <p>No channel prices are available for this product.</p>}
      </section>
      <section id="editor-sync" className="product-editor-section"><h3>Sync</h3>
        <ProductPricingSync key={`${selectedId}-${detail.latest?.id || 0}`} productId={selectedId} token={token} roles={roles}
          dirty={editorDirty} onRequestBusy={setSyncRequestBusy} onChanged={() => setMarkupRefresh(value => value + 1)} />
      </section>
    </fieldset>}
    </ProductEditorDialog>}
  </section>;
}
