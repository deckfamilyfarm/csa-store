import React from 'react';
import { customerOverridePrice, normalizeCustomerPriceOverrides } from '../../../../../apps/api/lib/customerPriceOverrides.js';

export function CustomerPricingEditor({ rows = [], packages = [], lists = [], disabled, onChange }) {
  const patch = (index, change) => onChange(rows.map((row, i) => i === index ? { ...row, ...change } : row));
  const available = packages.flatMap(pkg => lists.map(list => ({ packageId: Number(pkg.id), priceListId: list.id })))
    .find(pair => !rows.some(row => Number(row.packageId) === pair.packageId && Number(row.priceListId) === pair.priceListId));
  return <fieldset className="admin-price-list products-editor-fields" disabled={disabled}>
    <legend>Customer-group prices and sales</legend>
    <p className="small">These settings take precedence over the product markup and sale for the selected package and customer group. Other groups use standard pricing. Save Local Changes, then review Product Sync to publish.</p>
    {rows.map((row, index) => {
      const pkg = packages.find(pkg => Number(pkg.id) === Number(row.packageId));
      const name = `${pkg?.name || row.packageId} · ${lists.find(list => list.id === Number(row.priceListId))?.name || row.priceListId}`;
      let price = null;
      try { price = customerOverridePrice(pkg?.price, normalizeCustomerPriceOverrides([row])[0]).final; } catch { /* Show incomplete drafts without calculating an invalid price. */ }
      return <div key={`${row.packageId}:${row.priceListId}`} className="admin-grid">
        <strong>{name}</strong>
        <label className="filter-field"><span className="small">Price calculation</span>
          <select className="input" value={row.adjustment ? row.adjustmentType : 0} onChange={e => patch(index, { adjustment: e.target.value !== '0', adjustmentType: Number(e.target.value) || 2 })}>
            <option value="0">Package price</option><option value="2">Add percentage</option><option value="1">Add dollar amount</option><option value="3">Fixed selling price</option>
          </select>
        </label>
        <label className="filter-field"><span className="small">{Number(row.adjustmentType) === 2 ? 'Adjustment %' : 'Amount $'}</span>
          <input className="input" type="number" step="0.01" disabled={!row.adjustment || disabled} value={row.adjustmentValue} onChange={e => patch(index, { adjustmentValue: e.target.value })} />
        </label>
        <label><input type="checkbox" checked={row.onSale} onChange={e => patch(index, { onSale: e.target.checked })} /> On sale</label>
        <label className="filter-field"><span className="small">Crossed-out price $</span>
          <input className="input" type="number" min="0" step="0.01" value={row.strikethrough ?? ''} onChange={e => patch(index, { strikethrough: e.target.value })} />
        </label>
        <span className="small">Selling price: {price === null ? 'Enter valid values' : `$${price.toFixed(2)}`}
          {price !== null && row.onSale && row.strikethrough != null && row.strikethrough !== '' && Number(row.strikethrough) < price ? ' · Crossed-out price is below the selling price.' : ''}</span>
        <button type="button" className="button alt" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Use standard pricing</button>
      </div>;
    })}
    <button type="button" className="button alt" disabled={disabled || !available} onClick={() => onChange([...rows, { ...available, adjustment: true, adjustmentType: 3, adjustmentValue: Number(packages.find(pkg => Number(pkg.id) === available.packageId)?.price) || 0, onSale: false, strikethrough: null }])}>Add customer-group setting</button>
  </fieldset>;
}
