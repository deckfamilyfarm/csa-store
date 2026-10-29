import React from "react";
import { ProductIdentity } from "./ProductIdentity.jsx";
import { useViewportRows } from "./useViewportRows.js";
import { InventoryFieldInfo } from "./InventoryFieldInfo.jsx";
import { dirtyFields } from "./productWorkspace.js";

export function CompactInventoryList({ rows, drafts, renderField, saving, saveResults, loading }) {
  const scrollRef = useViewportRows();
  return <div className="compact-inventory-list" ref={scrollRef} role="region" aria-label="Inventory table" tabIndex={0}>
    <div className="compact-inventory-columns">
      <span className="compact-inventory-product-heading">Product</span>
      <span className="compact-inventory-farm-heading">On-Farm Inventory</span>
      <span className="compact-inventory-ff-heading">FF Inventory</span>
    </div>
    <ul aria-label="Farm inventory products">
      {rows.map(row => {
        const draft = drafts[row.productId];
        const dirty = dirtyFields(draft).length > 0;
        const result = saveResults.find(result => result.productId === row.productId);
        const size = row.packageSummary || (row.packageRecords || []).map(pkg => pkg.name).filter(Boolean).join(" · ");
        return <li className="compact-inventory-row" key={row.productId}>
          <div className="compact-inventory-product">
            <ProductIdentity name={draft?.values.name ?? row.name} thumbnailUrl={row.thumbnailUrl} unit={size} vendor={row.vendorName} />
            {(dirty || result) && <span className={`compact-inventory-feedback${result && !result.ok ? " failed" : ""}`} role="status">
              {saving && dirty ? "Saving…" : draft?.meta.farmStockConflict ? "Count changed — review below" : result && !result.ok ? "Save failed — retry" : dirty ? "Unsaved" : "Saved"}
            </span>}
          </div>
            <div className="compact-inventory-farm" role="group" aria-label={`On-Farm Inventory: ${row.name}`}>
              <div className="compact-inventory-farm-label">
                <span>Stock on farm</span><InventoryFieldInfo field="stockOnFarm" label="Stock on Farm" />
              </div>
              {renderField("stockOnFarm", row)}
              <div className="compact-farm-weight">
                <span className="compact-farm-weight-label">lbs</span>
                {renderField("stockOnFarmLbs", row)}
                <InventoryFieldInfo field="stockOnFarmLbs" label="On-farm inventory (lbs)" />
              </div>
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
