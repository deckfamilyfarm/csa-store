import React from "react";
import { InventoryFieldInfo } from "./InventoryFieldInfo.jsx";
import { dirtyFields } from "./productWorkspace.js";

export function CompactInventoryList({ rows, drafts, renderField, saving, saveResults, loading }) {
  return <div className="compact-inventory-list">
    <div className="compact-inventory-columns" aria-hidden="true">
      <span>Product / On farm</span><span>Full Farm</span>
    </div>
    <ul aria-label="Farm inventory products">
      {rows.map(row => {
        const draft = drafts[row.productId];
        const dirty = dirtyFields(draft).length > 0;
        const result = saveResults.find(result => result.productId === row.productId);
        const size = row.packageSummary || (row.packageRecords || []).map(pkg => pkg.name).filter(Boolean).join(" · ");
        return <li className="compact-inventory-row" key={row.productId}>
          <div className="compact-inventory-product">
            <div className="compact-inventory-description">
              <strong>{draft?.values.name ?? row.name}</strong>
              {size && <span className="compact-inventory-size">{size}</span>}
              <span className="compact-inventory-vendor">{row.vendorName}</span>
            </div>
            <div className="compact-inventory-farm">
              <div className="compact-inventory-farm-label">
                <span>Stock on farm</span><InventoryFieldInfo field="stockOnFarm" label="Stock on Farm" />
              </div>
              {renderField("stockOnFarm", row)}
            </div>
            {(dirty || result) && <span className={`compact-inventory-feedback${result && !result.ok ? " failed" : ""}`} role="status">
              {saving && dirty ? "Saving…" : result && !result.ok ? "Save failed — retry" : dirty ? "Unsaved" : "Saved"}
            </span>}
          </div>
          <div className="compact-inventory-full-farm" role="group" aria-label={`Full Farm inventory: ${row.name}`}>
            {[["inventory", "Qty", "Full Farm Stock"], ["trackInventory", "Track", "Full Farm Track Inventory"], ["visible", "Visible", "Full Farm Visible"]].map(([key, shortLabel, label]) =>
              <div className="compact-inventory-field" key={key}>
                <span>{shortLabel}</span>
                {renderField(key, row)}
                <InventoryFieldInfo field={key} label={label} />
              </div>,
            )}
          </div>
        </li>;
      })}
    </ul>
    {!loading && !rows.length && <p className="small">No products match these filters.</p>}
  </div>;
}
