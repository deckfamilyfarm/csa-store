import React, { useEffect, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";
import { EnterprisePromotionEditor } from "./EnterprisePromotionEditor.jsx";
import { EnterpriseMarkupCell, MarkupControls, MarkupCalculation } from "./EnterpriseMarkup.jsx";
import { PricingEditButton } from "./PricingEditButton.jsx";
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
  ["name", "Product"], ["vendor", "Vendor"], ["unit", "Unit"], ["buyFrom", "Buy Price"],
  ["markup", "Markup"], ["square", "Square"], ["csa", "CSA Unit"],
  ["llPackage", "LL Package"], ["wholesale", "Wholesale"], ["sale", "Sale"], ["status", "Sync / review"]
];
const productWarnings = row => {
  const warnings = [];
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

export function EnterprisePricingSection({ token, roles = [], onOpenReview }) {
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
  const [vendorFilter, setVendorFilter] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [squareFilter, setSquareFilter] = useState("");
  const [sort, setSort] = useState({ key: "name", direction: "asc" });
  const [warningRow, setWarningRow] = useState(null);
  const [buyPriceEdit, setBuyPriceEdit] = useState(null);
  const [buyPriceSaving, setBuyPriceSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [migrationReport, setMigrationReport] = useState(null);
  const [summary, setSummary] = useState(null);
  const [markupRefresh, setMarkupRefresh] = useState(0);
  const canEdit = roles.some(role => ["admin", "pricing_admin", "pricing_editor", "local_pricelist_admin"].includes(role));

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search, status, vendorId: vendorFilter, pricingUnit: unitFilter,
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
    adminGet(`enterprise-pricing/products/${selectedId}`, token).then(data => {
      if (cancelled) return;
      setDetail(data);
      setDraft({ ...structuredClone(data.suggestedInput),
        priceEffectiveAt: data.latest?.status === "pending" ? data.suggestedInput.priceEffectiveAt : new Date().toISOString() });
      setPreview(data.latest ? { output: data.latest.output } : null);
    }).catch(error => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [selectedId, token, loading]);

  useEffect(() => {
    if (detail && Number(detail.product.id) === Number(selectedId)) {
      document.getElementById("pricing-product-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [detail, selectedId]);

  useEffect(() => {
    if (!warningRow) return undefined;
    const onKeyDown = event => { if (event.key === "Escape") setWarningRow(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [warningRow]);

  useEffect(() => {
    if (!selectedId || !draft || !canEdit) return;
    setPreview(null);
    if (draft.customMarkupBp === "") { setMessage("Enter a markup percentage."); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      adminPost(`enterprise-pricing/products/${selectedId}/preview`, token, { input: draft })
        .then(value => { if (!cancelled) { setPreview(value); setMessage(""); } })
        .catch(error => { if (!cancelled) { setPreview(null); setMessage(error.message); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedId, token, draft, canEdit]);

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

  async function saveBuyPrice(row) {
    if (!buyPriceEdit || buyPriceSaving) return;
    const value = String(buyPriceEdit.value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
      setMessage("Buy Price must be greater than zero with at most two decimal places.");
      return;
    }
    setBuyPriceSaving(true);
    try {
      const saved = await adminPost(`enterprise-pricing/products/${row.id}/buy-price`, token,
        { price: Number(value).toFixed(2), expectedRevision: row.buyPrice?.revision || 0 });
      setRows(current => current.map(item => item.id === row.id ? { ...item, buyPrice: saved } : item));
      if (Number(selectedId) === Number(row.id)) {
        setDetail(current => current ? { ...current, buyPrice: saved } : current);
        setDraft(current => current ? {
          ...current, purchaseCosts: current.purchaseCosts.some(cost => Number(cost.enterpriseId) === saved.enterpriseId)
            ? current.purchaseCosts.map(cost => Number(cost.enterpriseId) === saved.enterpriseId
              ? { ...cost, cost: (saved.cents / 100).toFixed(2) } : cost)
            : [...current.purchaseCosts, { enterpriseId: saved.enterpriseId, cost: (saved.cents / 100).toFixed(2),
              effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }]
        } : current);
      }
      setBuyPriceEdit(null);
      setMessage("Buy Price saved locally. Save a pricing proposal to send it for review.");
    } catch (error) { setMessage(error.message); }
    finally { setBuyPriceSaving(false); }
  }

  async function save() {
    if (!detail || !draft) return;
    setLoading(true);
    try {
      const result = await adminPost(`enterprise-pricing/products/${selectedId}/revisions`, token, {
        input: draft, expectedLatestRevisionId: detail.latest?.id || null,
        expectedBuyPriceRevision: detail.buyPrice?.revision || 0
      });
      setMessage(`Pricing proposal ${result.revisionId} saved for review.`);
    } catch (error) { setMessage(error.message); }
    finally { setLoading(false); }
  }
  async function loadMigrationReport() {
    try { setMigrationReport(await adminGet("enterprise-pricing/migration-report?limit=1000", token)); setMessage(""); }
    catch (error) { setMessage(error.message); }
  }

  return <section className="card enterprise-pricing-page">
    <div className="admin-section-heading"><div><h2>Pricing</h2><p>Review purchase costs, markups, retail prices, packages, and wholesale prices.</p></div>
      <div className="admin-actions"><button className="button alt" type="button" onClick={loadMigrationReport}>Migration comparison</button><button className="button" type="button" onClick={onOpenReview}>Review &amp; Publish</button></div></div>
    <div className="admin-grid enterprise-pricing-filters">
      <label>Search<input className="input" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Product or vendor" /></label>
      <label>Vendor<select className="input" value={vendorFilter} onChange={event => { setVendorFilter(event.target.value); setPage(0); }}><option value="">All vendors</option>{vendors.map(vendor => <option value={vendor.id} key={vendor.id}>{vendorLabel(vendor.name)}</option>)}</select></label>
      <label>Status<select className="input" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="">All</option><option value="unresolved">Needs inputs</option><option value="pending">Awaiting approval</option><option value="approved">Approved</option><option value="partial">Partial</option><option value="active">Active</option>{summary?.localOnly && <option value="local-preview">Applied locally</option>}</select></label>
      <label>Unit<select className="input" value={unitFilter} onChange={event => { setUnitFilter(event.target.value); setPage(0); }}><option value="">All units</option><option value="lb">lb</option><option value="each">each</option></select></label>
      <label>Markup category<select className="input" value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value); setPage(0); }}><option value="">All categories</option><option value="highlyPerishable">Highly perishable</option><option value="perishable">Perishable</option><option value="shelfStable">Shelf stable</option><option value="custom">Custom</option></select></label>
      <label>Square<select className="input" value={squareFilter} onChange={event => { setSquareFilter(event.target.value); setPage(0); }}><option value="">All</option><option value="enabled">Enabled</option><option value="disabled">Not sold</option></select></label>
     </div>
    <p className="small">Markup adds a percentage to Buy Price. Select the pencil in the Markup column to change the percentage or category and preview the resulting prices.</p>
    {message && <p role="status">{message}</p>}
    {summary && <p className="small">{summary.byStatus.pending || 0} awaiting approval · {summary.byStatus.approved || 0} ready to check · {summary.byStatus.partial || 0} partially published · {(summary.problems.blocked || 0) + (summary.problems.failed || 0)} requiring review · {summary.sales?.active || 0} active sales · {summary.sales?.partial || 0} sale failures · {summary.byStatus.active || 0} active prices{summary.lastVerifiedAt ? ` · last verified ${new Date(summary.lastVerifiedAt).toLocaleString()}` : ""}</p>}
    <div className="table-wrap enterprise-pricing-table-wrap"><table className="admin-table enterprise-pricing-table"><thead><tr>{columns.map(([key, label]) =>
      <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
        <button type="button" className="enterprise-pricing-sort" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? sort.direction === "asc" ? " ▲" : " ▼" : " ↕"}</span></button>
      </th>)}</tr></thead>
      <tbody>{visible.map(row => {
        const source = row.sourceEvidence;
        const pkg = sourcePackage(source);
        return <tr key={row.id}>
        <td><div className="enterprise-pricing-product-line">
          <a href={productHref(row.id)} title={row.name} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            window.history.replaceState(null, "", productHref(row.id));
            setSelectedId(row.id);
          }}>{row.name}</a>
          {productWarnings(row).length > 0 && <button type="button" className="enterprise-pricing-warning" aria-label={`Show warnings for ${row.name}`} onClick={() => setWarningRow(row)}>⚠</button>}
        </div></td>
        <td>{vendorLabel(row.vendorName) || "—"}</td>
        <td>{row.input?.pricingUnit || source?.unit || row.legacy?.pricingUnit || "Needs review"}</td>
        <td>{buyPriceEdit?.productId === row.id ? <form className="enterprise-pricing-buy-edit" onSubmit={event => { event.preventDefault(); saveBuyPrice(row); }}>
          <input className="input" aria-label={`Buy Price for ${row.name}`} type="number" min="0.01" step="0.01" autoFocus disabled={buyPriceSaving}
            value={buyPriceEdit.value} onChange={event => setBuyPriceEdit({ productId: row.id, value: event.target.value })} />
          <button type="submit" disabled={buyPriceSaving}>Save</button><button type="button" disabled={buyPriceSaving} onClick={() => setBuyPriceEdit(null)}>Cancel</button>
        </form> : <div className="enterprise-pricing-buy-value"><span>{row.buyPrice ? money(row.buyPrice.cents) : row.output?.buyFromTenThousandths != null ? dollars(row.output.buyFromTenThousandths / 10000) : "—"}</span>
          {canEdit && <PricingEditButton label={`Edit Buy Price for ${row.name}`} onClick={() => setBuyPriceEdit({ productId: row.id,
            value: row.buyPrice ? (row.buyPrice.cents / 100).toFixed(2) : row.output?.buyFromTenThousandths != null ? (row.output.buyFromTenThousandths / 10000).toFixed(2) : "" })} />}
        </div>}</td>
        <td><EnterpriseMarkupCell row={row} token={token} canEdit={canEdit} onSaved={result => {
          setRows(current => current.map(item => item.id === row.id ? { ...item, input: result.input, output: result.output,
            status: result.status, latestRevisionId: result.revisionId } : item));
          setMarkupRefresh(value => value + 1);
          setMessage("Markup proposal saved locally. Review & Publish is required to change live prices.");
        }} /></td>
        <td>{row.output ? row.input?.squareEnabled ? money(row.output.squareUnitCents) : "—" : source?.square?.length ? source.square.map(price => money(price.priceCents)).join(", ") : "—"}</td>
        <td>{row.output ? money(row.output.csaUnitCents) : money(pkg?.estimatedCsaUnitCents)}</td>
        <td>{row.output?.packages?.length ? row.output.packages.map(item => money(item.localLineRegularCents)).join(", ") : source?.packages?.length ? source.packages.map(item => <span key={item.name}>{money(item.displayedPriceCents)}<small>{item.name}</small></span>) : "—"}</td>
        <td>{row.output?.wholesale?.length ? row.output.wholesale.map(price => `${enterprises.find(item => Number(item.id) === price.sellingEnterpriseId)?.name || price.sellingEnterpriseId}: ${money(price.priceCents)}`).join(" · ") : "—"}</td>
        <td>{row.saleStatus || sourceSale(source)}</td>
        <td>{row.status === "unresolved" ? "Needs review" : row.status === "local-preview" ? "Applied locally" : row.status}{row.editorName && <small>Edited {row.editorName}</small>}{row.approverName && <small>Approved {row.approverName}</small>}</td>
      </tr>; })}</tbody></table></div>
    <div className="admin-actions"><button className="button alt" type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>{total ? `${page * 100 + 1}–${Math.min((page + 1) * 100, total)} of ${total}` : "0 products"}</span><button className="button alt" type="button" disabled={(page + 1) * 100 >= total} onClick={() => setPage(value => value + 1)}>Next</button></div>
    {migrationReport && <details open><summary>Migration comparison ({migrationReport.length} package rows)</summary>
      <div className="table-wrap"><table className="admin-table"><thead><tr><th>Product / package</th><th>Current local</th><th>Local Line</th><th>Square</th><th>Proposed</th><th>Difference</th><th>Action</th></tr></thead><tbody>
        {migrationReport.map(row => <tr key={`${row.productId}-${row.packageId}`}><td>{row.product} · {row.package}</td><td>{row.currentLocalPrice == null ? "—" : `$${Number(row.currentLocalPrice).toFixed(2)}`}</td><td>{row.currentRemote.localLine.map(entry => `${entry.list}: $${entry.price.toFixed(2)}`).join(" · ") || "—"}{row.basketConflict && " · basket conflict"}</td><td>{row.currentRemote.square.map(price => `$${price.toFixed(2)}`).join(", ") || "—"}</td><td>{row.proposedPrice == null ? "—" : `$${row.proposedPrice.toFixed(2)}`}</td><td>{row.difference == null ? "—" : `$${row.difference.toFixed(2)} (${row.differencePercent}%)`}</td><td>{row.action}</td></tr>)}
      </tbody></table></div></details>}
    {warningRow && <div className="enterprise-pricing-warning-backdrop" role="presentation" onClick={() => setWarningRow(null)}>
      <div className="card enterprise-pricing-warning-dialog" role="dialog" aria-modal="true" aria-label={`Warnings for ${warningRow.name}`} onClick={event => event.stopPropagation()}>
        <div className="admin-section-heading"><h3>{warningRow.name}: warnings</h3><button className="button alt" type="button" autoFocus onClick={() => setWarningRow(null)}>Close</button></div>
        <ul>{productWarnings(warningRow).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </div>
    </div>}
    {detail && draft && <div id="pricing-product-detail" className="card enterprise-pricing-editor">
      <div className="admin-section-heading"><h3>{detail.product.name}</h3><button className="button alt" type="button" onClick={() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("pricingProduct");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        setSelectedId(null); setDetail(null);
      }}>Close</button></div>
      <p className="small">Save changes locally, then use Review &amp; Publish to approve them. {detail.product.approvedSquareLinks ? `${detail.product.approvedSquareLinks} Square variation link(s).` : "Square mapping required if enabled."}</p>
      {detail.sourceEvidence && <details className="enterprise-pricing-source-detail">
        <summary>Package and channel prices</summary>
        <div className="table-wrap"><table className="admin-table"><thead><tr><th>Package</th><th>Package price</th><th>Square</th><th>CSA unit</th><th>Local Line baskets</th></tr></thead><tbody>
          {detail.sourceEvidence.packages.map(pkg => <tr key={pkg.name}><td>{pkg.name}</td><td>{money(pkg.storedSourcePriceCents)}</td><td>{detail.sourceEvidence.square.filter(price => price.packageName === pkg.name).map(price => money(price.priceCents)).join(", ") || "—"}</td><td>{money(pkg.estimatedCsaUnitCents)}</td><td>{Object.entries(pkg.basketPricesCents).map(([name, amount]) => `${name}: ${money(amount)}`).join(" · ") || "—"}</td></tr>)}
        </tbody></table></div>
      </details>}
      <div className="admin-grid enterprise-pricing-editor-grid">
        <label>Retail purchasing enterprise<select className="input" disabled={!canEdit} value={textValue(draft.retailEnterpriseId)} onChange={event => update({ retailEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select></label>
        <label>Pricing effective time<input className="input" type="datetime-local" disabled={!canEdit} value={localDateTime(draft.priceEffectiveAt)} onChange={event => update({ priceEffectiveAt: event.target.value ? new Date(event.target.value).toISOString() : "" })} /></label>
        <label>Pricing unit<select className="input" disabled={!canEdit} value={textValue(draft.pricingUnit)} onChange={event => update({ pricingUnit: event.target.value })}><option value="">Select unit</option><option value="lb">per lb</option><option value="each">per each</option></select></label>
        <MarkupControls input={draft} settings={detail.settings} vendor={detail.product.vendorName} name={detail.product.name} disabled={!canEdit} onChange={update} />
        <label>Square enabled<input type="checkbox" disabled={!canEdit} checked={Boolean(draft.squareEnabled)} onChange={event => update({ squareEnabled: event.target.checked, csaOverride: event.target.checked ? null : draft.csaOverride, squareOverride: event.target.checked ? draft.squareOverride : null })} /></label>
        <label>Square override<input className="input" type="number" step="0.50" disabled={!canEdit || !draft.squareEnabled} value={textValue(draft.squareOverride)} onChange={event => update({ squareOverride: event.target.value || null })} /></label>
        <label>CSA-only override<input className="input" type="number" step="0.01" disabled={!canEdit || draft.squareEnabled} value={textValue(draft.csaOverride)} onChange={event => update({ csaOverride: event.target.value || null })} /></label>
        <label>Override note<input className="input" disabled={!canEdit} value={draft.overrideNote || ""} onChange={event => update({ overrideNote: event.target.value })} /></label>
      </div>
      <h4>Buy Prices</h4><p className="small">Set the price paid by each purchasing enterprise. Cost-plus wholesale prices use that enterprise’s Buy Price.</p>
      {draft.purchaseCosts.map((cost, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={index}>
        <select className="input" disabled={!canEdit} aria-label="Purchasing enterprise" value={cost.enterpriseId} onChange={event => updateCost(index, { enterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        <input className="input" aria-label="Buy Price" type="number" step="0.01" min="0.01" disabled={!canEdit} value={textValue(cost.cost)} onChange={event => updateCost(index, { cost: event.target.value })} />
        <input className="input" aria-label="Cost effective date" type="date" disabled={!canEdit} value={String(cost.effectiveAt || "").slice(0, 10)} onChange={event => updateCost(index, { effectiveAt: event.target.value })} />
        <input className="input" aria-label="Documentation reference" disabled={!canEdit} placeholder="Document reference" value={cost.documentationRef || ""} onChange={event => updateCost(index, { documentationRef: event.target.value })} />
        {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: draft.purchaseCosts.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {canEdit && <button className="button alt" type="button" onClick={() => update({ purchaseCosts: [...draft.purchaseCosts, { enterpriseId: detail.enterprises[0]?.id, cost: "", effectiveAt: new Date().toISOString().slice(0, 10), documentationRef: "" }] })}>Add Buy Price</button>}
      <h4>Packages</h4>
      {draft.packages.map((pkg, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={pkg.packageId}>
        <strong>{detail.packages.find(row => Number(row.packageId) === Number(pkg.packageId))?.name || pkg.packageId}</strong>
        {draft.pricingUnit === "lb" ? <>
          <label>Minimum lb<input className="input" type="number" step="0.001" disabled={!canEdit} value={textValue(pkg.minWeight)} onChange={event => updatePackage(index, { minWeight: event.target.value })} /></label>
          <label>Maximum lb<input className="input" type="number" step="0.001" disabled={!canEdit} value={textValue(pkg.maxWeight)} onChange={event => updatePackage(index, { maxWeight: event.target.value })} /></label>
          <label>Average override lb<input className="input" type="number" step="0.001" disabled={!canEdit} value={textValue(pkg.avgWeightOverride)} onChange={event => updatePackage(index, { avgWeightOverride: event.target.value })} /></label>
        </> : <label>Units in package<input className="input" type="number" min="1" step="1" disabled={!canEdit} value={textValue(pkg.quantity)} onChange={event => updatePackage(index, { quantity: event.target.value })} /></label>}
        <span>LL {money(preview?.output?.packages?.find(row => row.packageId === Number(pkg.packageId))?.localLineRegularCents)}</span>
      </div>)}
      <h4>Wholesale resale prices</h4>
      {draft.wholesale.map((row, index) => <div className="admin-grid enterprise-pricing-repeat-grid" key={index}>
        <select className="input" aria-label="Selling enterprise" disabled={!canEdit} value={row.sellingEnterpriseId} onChange={event => updateWholesale(index, { sellingEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        <select className="input" aria-label="Wholesale mode" disabled={!canEdit} value={row.mode} onChange={event => updateWholesale(index, { mode: event.target.value })}><option value="fixed">Fixed</option><option value="markup">Cost plus markup</option></select>
        {row.mode === "fixed" ? <input className="input" aria-label="Fixed wholesale price" type="number" step="0.01" disabled={!canEdit} value={textValue(row.fixedPrice)} onChange={event => updateWholesale(index, { fixedPrice: event.target.value })} /> : <>
          <input className="input" aria-label="Wholesale markup percentage" type="number" step="0.01" disabled={!canEdit} value={row.markupBp == null ? "" : Number(row.markupBp) / 100} onChange={event => updateWholesale(index, { markupBp: Math.round(Number(event.target.value) * 100) })} />
          <select className="input" aria-label="Cost enterprise" disabled={!canEdit} value={row.costEnterpriseId || row.sellingEnterpriseId} onChange={event => updateWholesale(index, { costEnterpriseId: Number(event.target.value) })}>{detail.enterprises.map(enterprise => <option value={enterprise.id} key={enterprise.id}>{enterprise.name}</option>)}</select>
        </>}
        {canEdit && <button className="button alt" type="button" onClick={() => update({ wholesale: draft.wholesale.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}
      {canEdit && <button className="button alt" type="button" onClick={() => update({ wholesale: [...draft.wholesale, { sellingEnterpriseId: detail.enterprises[0]?.id, mode: "fixed", fixedPrice: "" }] })}>Add wholesale price</button>}
      <MarkupCalculation input={draft} output={preview?.output} settings={detail.settings} />
      {preview?.output && <details><summary>How these prices are calculated</summary><p className="small">The selected enterprise’s Buy Price is multiplied by 1 + {(preview.output.appliedMarkupBp / 100).toFixed(2)}% markup. {draft.squareEnabled ? `Square is rounded to the nearest $${(detail.settings.squareIncrementCents / 100).toFixed(2)}; CSA is Square less ${(detail.settings.localLineDiscountBp / 100).toFixed(2)}%.` : "CSA uses the calculated price directly."} Each Local Line package multiplies that CSA unit price by its reviewed quantity or average pounds. All four baskets receive the same package price. Overrides remain fixed when cost or markup changes.</p></details>}
      {canEdit && <button className="button" type="button" disabled={loading || !preview?.output} onClick={save}>{loading ? "Saving…" : "Save proposal"}</button>}
      {canEdit && detail.active && <EnterprisePromotionEditor token={token} product={detail.product} packages={detail.packages} squareEnabled={detail.active.input.squareEnabled} onSaved={() => setMessage("Sale proposal saved. Open Review & Publish for approval.")} />}
    </div>}
  </section>;
}
