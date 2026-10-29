import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { EnterprisePromotionEditor } from "./EnterprisePromotionEditor.jsx";
import { EnterpriseMarkupCell, MarkupControls, MarkupCalculation } from "./EnterpriseMarkup.jsx";
import { ProductEditorDialog } from "./ProductEditorDialog.jsx";
import { ProductEditorInfo } from "./ProductEditorInfo.jsx";
import { PricingSyncStatus } from "./PricingSyncStatus.jsx";
import { ProductPricingSync } from "./ProductPricingSync.jsx";
import { ProductIdentity } from "./ProductIdentity.jsx";
import { InlinePricingValue } from "./InlinePricingValue.jsx";
import { EnterpriseBundles } from './EnterpriseBundles.jsx';
import { usesProductMarkup, retailMarginPercent, isDepositPricing, depositBaseCents, productPricingUnit } from "./enterpriseMarkup.js";
import "./EnterprisePricingSection.css";

const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
const dollars = amount => amount == null ? "—" : `$${Number(amount).toFixed(2)}`;
const textValue = value => value ?? "";
const vendorLabel = name => String(name || "").replace(/\s+\(local sample\)$/i, "");
const productHref = id => {
  const url = new URL(window.location.href);
  url.searchParams.set("pricingProduct", String(id));
  return `${url.pathname}${url.search}${url.hash}`;
};
const columns = [
  ["name", "Product"], ["buyFrom", "Buy Price"],
  ["markup", "Markup"], ["margin", "Margin"], ["csa", "FF Unit Price"],
  ["llPackage", "FF Package Price"], ["square", "Square"], ["wholesale", "Wholesale"], ["sale", "Sale"], ["sync", "Sync"]
];
const productWarnings = row => {
  const warnings = [...(row.sourceEvidence?.warnings || [])];
  if (row.status === "partial") warnings.push("This pricing revision is only partially published. Review both destinations.");
  if (row.status === "rejected") warnings.push("The latest pricing proposal was rejected.");
  for (const publication of row.publications || []) {
    if (["blocked", "failed", "partial"].includes(publication.status)) warnings.push(`${publication.platform === "square" ? "Square" : "Local Line"} publication: ${publication.status}. Open Review & Publish for details.`);
  }
  return warnings;
};
const localDateTime = value => {
  if (!value) return "";
  const raw = String(value);
  const date = new Date(raw.includes(" ") ? raw.replace(" ", "T") + "Z" : raw);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function EnterprisePricingSection({ token, roles = [] }) {
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
  </div></div>
    <div role="tabpanel" id="pricing-products-panel" aria-labelledby="pricing-products-tab" hidden={tab!=='products'}><EnterpriseProductsSection token={token} roles={roles} /></div>
    <div role="tabpanel" id="pricing-bundles-panel" aria-labelledby="pricing-bundles-tab" hidden={tab!=='bundles'}><EnterpriseBundles token={token} roles={roles} active={tab==='bundles'} /></div>
  </div>;
}

function EnterpriseProductsSection({ token, roles = [] }) {
  const tableScrollRef = useRef(null);
  const productInfoRef = useRef(null);
  const saveBusy = useRef(false);
  const [pricingBaseline, setPricingBaseline] = useState(null);
  const [infoDirty, setInfoDirty] = useState(false);
  const [saleDirty, setSaleDirty] = useState(false);
  const [saleBusy, setSaleBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [rows, setRows] = useState([]);
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
  const [squareFilter, setSquareFilter] = useState("");
  const [sort, setSort] = useState({ key: "name", direction: "asc" });
  const [warningRow, setWarningRow] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [markupRefresh, setMarkupRefresh] = useState(0);
  const canEdit = roles.some(role => ["admin", "pricing_admin", "pricing_editor", "local_pricelist_admin"].includes(role));

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
        markupCategory: categoryFilter, square: squareFilter, sort: sort.key, sortDirection: sort.direction,
        limit: "100", offset: String(page * 100) });
      adminGet(`enterprise-pricing/products?${params}`, token)
        .then(data => { if (!cancelled) { setRows(data.rows); setVendors(data.vendors); setEnterprises(data.enterprises); setTotal(data.total); } })
        .catch(error => { if (!cancelled) setMessage(error.message); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, search, status, vendorFilter, unitFilter, categoryFilter, squareFilter, sort, page, loading, markupRefresh]);
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
  const sourceSale = evidence => {
    if (!evidence) return "—";
    const active = evidence.sale?.activeInProduct || evidence.sale?.activeInProfile;
    if (!active) return evidence.packages?.some(pkg => pkg.crossedOutPriceCents > pkg.displayedPriceCents)
      ? "Sale" : "—";
    return `${evidence.sale?.discountPercent ?? "?"}%`;
  };
  const update = patch => setDraft(previous => ({ ...previous, ...patch }));
  const updateCost = (index, patch) => setDraft(previous => ({ ...previous, purchaseCosts: previous.purchaseCosts.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const updatePackage = (index, patch) => setDraft(previous => ({ ...previous, packages: previous.packages.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const updateWholesale = (index, patch) => setDraft(previous => ({ ...previous, wholesale: previous.wholesale.map((row, i) => i === index ? { ...row, ...patch } : row) }));

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
    setMessage(saved.pricing ? "Buy Price saved. Updated selling prices are now in use locally." : "Buy Price saved. Complete the product’s pricing inputs to calculate selling prices.");
  }

  const pricingDirty = !!draft && !isDepositPricing(detail?.product) && JSON.stringify(draft) !== pricingBaseline;
  const editorDirty = pricingDirty || infoDirty || saleDirty;
  const selectedIndex = rows.findIndex(row => Number(row.id) === Number(selectedId));
  const canLeaveEditor = () => !saveBusy.current && !saleBusy && (!editorDirty || window.confirm("Discard unsaved changes to this product?"));
  function selectProduct(id, force = false, section = null) {
    if (!force && !canLeaveEditor()) return;
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
      <label>Markup category<select className="input" value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value); setPage(0); }}><option value="">All categories</option><option value="highlyPerishable">Highly perishable</option><option value="perishable">Perishable</option><option value="shelfStable">Shelf stable</option><option value="deckHyland">Deck/Hyland Markup</option><option value="creamyCow">Creamy Cow Markup</option><option value="custom">Custom</option></select></label>
      <label>Square<select className="input" value={squareFilter} onChange={event => { setSquareFilter(event.target.value); setPage(0); }}><option value="">All</option><option value="enabled">Enabled</option><option value="disabled">Not sold</option></select></label>
     </div>
    {message && !selectedId && <p role="status">{message}</p>}
    {summary && !summary.localOnly && <p className="small">{summary.byStatus.pending || 0} awaiting approval · {summary.byStatus.approved || 0} ready to check · {summary.byStatus.partial || 0} partially published · {(summary.problems.blocked || 0) + (summary.problems.failed || 0)} requiring review · {summary.sales?.active || 0} active sales · {summary.sales?.partial || 0} sale failures · {summary.byStatus.active || 0} active prices{summary.lastVerifiedAt ? ` · last verified ${new Date(summary.lastVerifiedAt).toLocaleString()}` : ""}</p>}
    <div className="table-wrap enterprise-pricing-table-wrap" ref={tableScrollRef} role="region" aria-label="Pricing table" tabIndex={0}><table className="admin-table enterprise-pricing-table"><thead><tr>{columns.map(([key, label]) =>
      <th key={key} scope="col" aria-sort={key === "sync" ? undefined : sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
        {key === "sync" ? label : <button type="button" className="enterprise-pricing-sort" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? sort.direction === "asc" ? " ▲" : " ▼" : " ↕"}</span></button>}
      </th>)}</tr></thead>
      <tbody>{visible.map(row => {
        const source = row.sourceEvidence;
        const pkg = sourcePackage(source);
        const missingChannelPrice = usesProductMarkup(row.vendorName) ? "—" : "n/a";
        const deposit = isDepositPricing(row);
        const margin = deposit ? null : retailMarginPercent(row);
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
        <td>{deposit ? <span title="Fixed deposit package amount; no markup">{money(depositBaseCents(row))}</span> : <InlinePricingValue label={`Buy Price for ${row.name}`} canEdit={canEdit} min={0.01}
          display={row.buyPrice ? money(row.buyPrice.cents) : row.output?.buyFromTenThousandths != null ? dollars(row.output.buyFromTenThousandths / 10000) : "—"}
          value={row.buyPrice ? (row.buyPrice.cents / 100).toFixed(2) : row.output?.buyFromTenThousandths != null ? (row.output.buyFromTenThousandths / 10000).toFixed(2) : ""}
          onSave={value => saveBuyPrice(row, value)} />}</td>
        <td><EnterpriseMarkupCell row={row} token={token} canEdit={canEdit} onSaved={result => {
          setRows(current => current.map(item => item.id === row.id ? { ...item, input: result.input, output: result.output, sync: null,
            status: result.status, latestRevisionId: result.revisionId, buyPrice: result.buyPrice || item.buyPrice } : item));
          setMarkupRefresh(value => value + 1);
          setMessage("Markup saved. Updated prices are now in use; channel synchronization is separate.");
        }} /></td>
        <td title={`(${row.input?.squareEnabled ? "Square" : "FF unit"} price − Buy Price) ÷ ${row.input?.squareEnabled ? "Square" : "FF unit"} price × 100`}>{margin == null ? "—" : `${Math.round(margin)}%`}</td>
        <td>{row.output ? money(row.output.csaUnitCents) : money(pkg?.estimatedCsaUnitCents)}
          {(row.output?.csaUnitCents ?? pkg?.estimatedCsaUnitCents) != null && <small>{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small>}
        </td>
        <td>{row.output?.packages?.length ? row.output.packages.map(item => {
          const packageName = row.legacy?.packages?.find(pkg => Number(pkg.id) === Number(item.packageId))?.name
            || (row.legacy?.packages?.length === 1 ? row.legacy.packages[0].name : "");
          return <div key={item.packageId}>{money(item.localLineRegularCents)}<small>per package{packageName ? ` · ${packageName}` : ""}</small></div>;
        }) : source?.packages?.length ? source.packages.map(item => <div key={item.name}>{money(item.displayedPriceCents)}{item.displayedPriceCents != null && <small>per package{item.name ? ` · ${item.name}` : ""}</small>}</div>) : "—"}</td>
        <td>{row.output ? row.input?.squareEnabled ? <>{money(row.output.squareUnitCents)}<small title="Local selling unit to publish to Square">{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small></> : missingChannelPrice : source?.square?.length ? source.square.map((price, index) => <div key={index}>{money(price.priceCents)}{price.priceCents != null && <small title="Local selling unit to publish to Square">{productPricingUnit(row) ? `per ${productPricingUnit(row)}` : "Select pricing unit"}</small>}</div>) : missingChannelPrice}</td>
        <td>{row.output?.wholesale?.length ? row.output.wholesale.map(price => `${enterprises.find(item => Number(item.id) === price.sellingEnterpriseId)?.name || price.sellingEnterpriseId}: ${money(price.priceCents)}`).join(" · ") : missingChannelPrice}</td>
        <td>{row.saleStatus || sourceSale(source)}</td>
        <td><PricingSyncStatus row={row} onReview={() => selectProduct(row.id, false, "editor-sync")} /></td>
      </tr>; })}</tbody></table></div>
    <div className="admin-actions enterprise-pricing-pagination">
      {summary?.localOnly && <span className="enterprise-pricing-footer-status">{summary.byStatus["local-preview"] || 0} products using local prices · {summary.byStatus.unresolved || 0} need pricing inputs · Review &amp; Publish compares channel prices</span>}
      <div className="enterprise-pricing-page-controls"><button className="button alt" type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>{total ? `${page * 100 + 1}–${Math.min((page + 1) * 100, total)} of ${total}` : "0 products"}</span><button className="button alt" type="button" disabled={(page + 1) * 100 >= total} onClick={() => setPage(value => value + 1)}>Next</button></div>
    </div>
    {warningRow && <div className="enterprise-pricing-warning-backdrop" role="presentation" onClick={() => setWarningRow(null)}>
      <div className="card enterprise-pricing-warning-dialog" role="dialog" aria-modal="true" aria-label={`Warnings for ${warningRow.name}`} onClick={event => event.stopPropagation()}>
        <div className="admin-section-heading"><h3>{warningRow.name}: warnings</h3><button className="button alt" type="button" autoFocus onClick={() => setWarningRow(null)}>Close</button></div>
        <ul>{productWarnings(warningRow).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </div>
    </div>}
    {selectedId && <ProductEditorDialog key={selectedId} name={detail?.product.name || rows.find(row => Number(row.id) === Number(selectedId))?.name}
      initialSection={editorSection}
      busy={loading || saleBusy} dirty={editorDirty} message={message || detailError}
      onClose={() => selectProduct(null)}
      onPrevious={selectedIndex > 0 ? () => selectProduct(rows[selectedIndex - 1].id) : null}
      onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => selectProduct(rows[selectedIndex + 1].id) : null}
      sections={[["editor-info", "Product info"], ["editor-inventory", "Inventory"],
        ...(!detail || isDepositPricing(detail.product) ? [] : [["editor-pricing", "Pricing"], ["editor-packages", "Packages"], ["editor-wholesale", "Wholesale"], ["editor-sales", "Sales"]]),
        ["editor-channels", "Channel prices"], ["editor-sync", "Sync"]]}
      footer={<><button type="button" className="button alt" disabled={loading} onClick={() => selectProduct(null)}>Back</button>
        {(canEdit || roles.some(role => ["admin", "inventory_admin", "pricing_admin", "local_pricelist_admin"].includes(role))) && <>
          <button type="button" className="button alt" disabled={loading || saleBusy || !(pricingDirty || infoDirty) || (pricingDirty && !preview?.output)} onClick={() => save(false)}>{loading ? "Saving…" : "Save"}</button>
          <button type="button" className="button" disabled={loading || saleBusy || !(pricingDirty || infoDirty) || (pricingDirty && !preview?.output)} onClick={() => save(true)}>Save and go back</button>
        </>}</>}>
      {!detail && <section className="product-editor-section"><p role="status">{detailError || "Loading product…"}</p>
        {detailError && <button type="button" className="button alt" onClick={() => setDetailRefresh(value => value + 1)}>Retry</button>}</section>}
      {detail && draft && <fieldset id="pricing-product-detail" className="enterprise-pricing-editor" disabled={loading || saleBusy}>
      <ProductEditorInfo ref={productInfoRef} productId={selectedId} token={token} roles={roles} vendors={vendors} busy={loading || saleBusy}
        onDirty={setInfoDirty} onSaved={updates => {
          setDetail(value => ({ ...value, product: { ...value.product, ...updates,
            vendorRequired: updates.vendorId ? false : value.product.vendorRequired } }));
          setRows(value => value.map(row => Number(row.id) === Number(selectedId) ? { ...row, ...updates } : row));
        }} />
      {isDepositPricing(detail.product) ? <p className="small">Fixed deposit amount, with no markup. Managed through the existing deposit workflow.</p> : <p className="small">{summary?.localOnly ? "Saving updates local prices immediately. Review & Publish compares channel prices." : "Saving updates our prices immediately. Review & Publish approves channel synchronization."} {detail.product.approvedSquareLinks ? `${detail.product.approvedSquareLinks} Square variation link(s).` : "Square mapping required if enabled."}</p>}
      {!isDepositPricing(detail.product) && <>
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
      <h4>Buy Prices</h4><p className="small">Set the price paid by each purchasing enterprise. Cost-plus wholesale prices use that enterprise’s Buy Price.</p>
      {draft.purchaseCosts.map((cost, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={index}>
        <select className="input" disabled={!canEdit || loading} aria-label="Purchasing enterprise" value={cost.enterpriseId} onChange={event => updateCost(index, { enterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        <input className="input" aria-label="Buy Price" type="number" step="0.01" min="0.01" disabled={!canEdit || loading} value={textValue(cost.cost)} onChange={event => updateCost(index, { cost: event.target.value })} />
        <input className="input" aria-label="Cost effective date" type="date" disabled={!canEdit || loading} value={String(cost.effectiveAt || "").slice(0, 10)} onChange={event => updateCost(index, { effectiveAt: event.target.value })} />
        <input className="input" aria-label="Documentation reference" disabled={!canEdit || loading} placeholder="Document reference" value={cost.documentationRef || ""} onChange={event => updateCost(index, { documentationRef: event.target.value })} />
        {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: draft.purchaseCosts.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: [...draft.purchaseCosts, { enterpriseId: detail.enterprises[0]?.id, cost: "", effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }] })}>Add Buy Price</button>}
      <MarkupCalculation input={draft} output={preview?.output} settings={detail.settings} />
      </section>
      <section id="editor-packages" className="product-editor-section"><h3>Packages</h3>
      {draft.packages.map((pkg, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={pkg.packageId}>
        <strong>{detail.packages.find(row => Number(row.packageId) === Number(pkg.packageId))?.name || pkg.packageId}</strong>
        {draft.pricingUnit === "lb" ? <>
          <label>Minimum lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.minWeight)} onChange={event => updatePackage(index, { minWeight: event.target.value })} /></label>
          <label>Maximum lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.maxWeight)} onChange={event => updatePackage(index, { maxWeight: event.target.value })} /></label>
          <label>Average override lb<input className="input" type="number" step="0.001" disabled={!canEdit || loading} value={textValue(pkg.avgWeightOverride)} onChange={event => updatePackage(index, { avgWeightOverride: event.target.value })} /></label>
        </> : <label>Units in package<input className="input" type="number" min="1" step="1" disabled={!canEdit || loading} value={textValue(pkg.quantity)} onChange={event => updatePackage(index, { quantity: event.target.value })} /></label>}
        <span>LL {money(preview?.output?.packages?.find(row => row.packageId === Number(pkg.packageId))?.localLineRegularCents)}</span>
      </div>)}
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
      <section id="editor-sales" className="product-editor-section"><h3>Sales</h3>
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
          dirty={editorDirty} onChanged={() => setMarkupRefresh(value => value + 1)} />
      </section>
    </fieldset>}
    </ProductEditorDialog>}
  </section>;
}
