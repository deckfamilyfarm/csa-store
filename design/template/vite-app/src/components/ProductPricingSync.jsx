import React, { useCallback, useEffect, useState } from "react";
import { adminGet } from "../adminApi.js";
import { EnterpriseReviewSection } from "./EnterpriseReviewSection.jsx";

const money = cents => cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
const percent = bp => bp == null ? "—" : `${Number(bp) / 100}%`;

export function ProductPricingSync({ productId, token, roles, dirty, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [live, setLive] = useState(null);
  useEffect(() => {
    let cancelled = false;
    adminGet(`enterprise-pricing/products/${productId}/sync`, token).then(result => {
      if (!cancelled) { setData(result); setError(""); }
    }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [productId, token, refresh]);
  const checked = useCallback(actions => {
    const rows = actions.flatMap(action => {
      if (action.platform === "localline") return action.display?.pricingComparison || [];
      const current = action.display?.current?.price, proposed = action.display?.proposed?.price;
      return [{ destination: "Square", label: `${action.packageName || "Variation"} · per ${action.display?.proposed?.sellingUnit || "unit"}`,
        currentCents: current == null ? null : Math.round(Number(current) * 100), localCents: proposed == null ? null : Math.round(Number(proposed) * 100),
        status: current == null || proposed == null ? "needs-check" : Number(current) === Number(proposed) ? "matches" : "different" }];
    });
    setLive(rows); onChanged?.();
  }, [onChanged]);
  const published = useCallback(() => { setLive(null); setRefresh(value => value + 1); onChanged?.(); }, [onChanged]);
  const rows = live ?? data?.comparison ?? [];
  const differences = rows.filter(row => row.status === "different").length;
  return <div className="product-pricing-sync">
    {error && <p role="alert">{error} <button type="button" className="button alt" onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
    {!data && !error && <p role="status">Loading channel prices…</p>}
    {data && <>
      {dirty && <p role="status">Save your product changes before checking or updating channel prices.</p>}
      <div className="table-wrap"><table className="admin-table"><thead><tr><th>Pricing inputs</th><th>Buy Price</th><th>Markup</th></tr></thead><tbody>
        {data.previous.map(previous => <tr key={previous.platform}><td>Last published to {previous.platform === "square" ? "Square" : "Local Line"}</td>
          <td>{money(previous.output?.buyFromTenThousandths == null ? null : previous.output.buyFromTenThousandths / 100)} / {previous.input?.pricingUnit}</td><td>{percent(previous.output?.appliedMarkupBp)}</td></tr>)}
        <tr><td>Saved local pricing</td><td>{money(data.output?.buyFromTenThousandths == null ? null : data.output.buyFromTenThousandths / 100)}{data.input?.pricingUnit ? ` / ${data.input.pricingUnit}` : ""}</td><td>{percent(data.output?.appliedMarkupBp)}</td></tr>
      </tbody></table></div>
      <p className="small">Buy Price and markup are local inputs. {!data.previous.length && "No previously published input history is available."}</p>
      <h4>{live ? "Server price check" : data.localOnly ? "Imported channel prices" : "Last stored channel prices"}</h4>
      {!rows.length ? <p>Complete the pricing inputs and package mappings to compare prices.</p> : <div className="table-wrap"><table className="admin-table"><thead><tr><th>Channel / package</th><th>{live ? "Server price" : "Channel price"}</th><th>Local price to send</th><th>Difference</th></tr></thead><tbody>
        {rows.map((row, index) => <tr key={index}><td>{row.destination} · {row.label}</td><td>{money(row.currentCents)}</td><td>{money(row.localCents)}</td>
          <td>{row.status === "needs-check" ? "Needs checking" : row.status === "matches" ? "✓ Matches" : money(row.localCents - row.currentCents)}</td></tr>)}
      </tbody></table></div>}
      {!!differences && <p>Suggested update: send the saved local selling prices to the channels with differences.</p>}
      {data.localOnly ? <>
        <p className="small">Local test mode: server checks and remote updates are disabled.</p>
        <div className="admin-actions"><button className="button alt" type="button" disabled={dirty} onClick={() => { setRefresh(value => value + 1); onChanged?.(); }}>Recheck imported prices</button>
          <button className="button" type="button" disabled>Update remote prices</button></div>
      </> : <fieldset disabled={dirty}><EnterpriseReviewSection token={token} roles={roles} productId={productId} embedded onChecked={checked} onPublished={published} /></fieldset>}
    </>}
  </div>;
}
