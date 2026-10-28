import fs from 'node:fs/promises';
const base = new URL('./', import.meta.url);
const read = async name => JSON.parse(await fs.readFile(new URL(name, base), 'utf8'));
const verified = await read('verified.json');
const preview = await read('preview.json');
const money = amount => `$${Number(amount).toFixed(2)}`;
const unit = value => ['lb', 'lbs'].includes(value) ? 'lb' : 'each/package';
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const rows = verified.rows.map(row => {
  const before = preview.find(p => p.name === row.product);
  const changed = before.squareBefore.amount !== before.proposed.amount || before.squareBefore.unit.id !== before.proposed.unit.id;
  return [row.product, `${money(before.localRetailBefore)}/${unit(before.localUnitBefore)}`, `${money(row.localRetailPrice)}/${unit(row.localUnit)}`,
    `${money(before.squareBefore.amount / 100)}/${unit(before.squareBefore.unit.unit)}`, `${money(row.squarePrice)}/${unit(row.squareUnit)}`, changed ? 'Updated and confirmed' : 'Already correct; confirmed'];
});
const headings = ['Product', 'Local retail before', 'Local retail after', 'Square before', 'Square after', 'Square result'];
const csv = [headings, ...rows].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
await fs.writeFile(new URL('changes.csv', base), csv);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Square unit corrections — October 11, 2026</title><style>body{font:16px/1.5 system-ui;max-width:1250px;margin:32px auto;padding:0 20px;color:#24343f}h1{font-size:26px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}th{background:#f2f4ef}.scroll{overflow:auto}small{color:#53606a}</style><h1>Square unit corrections — October 11, 2026</h1><p>Verified ${escape(verified.verifiedAt)}. Seven local pricing profiles corrected; ${verified.squareUpdated} Square variations updated. Ground Lamb was already per package in Square.</p><div class="scroll"><table><thead><tr>${headings.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p>Ground Pork retains its 20% sale: $12 regular retail, $9.60 selling price per package in Square. Local retail prices are the vendor retail input; CSA customer prices continue to follow their existing formulas and sale settings.</p><p>Sales, markups, package records and inventory were preserved. Cajun Chaurice’s missing local package weight was recorded as 0.875 lb from its existing 14 oz package label so the new per-pound rate can calculate local package prices. Other weights were preserved. Local Line was not published; these local pricing changes remain pending there.</p><small>Product Sync audit ${verified.auditId}; release ${verified.releaseId}. This report supersedes the earlier unit decisions for these seven products only.</small></html>`;
await fs.writeFile(new URL('completed.html', base), html);
console.log(JSON.stringify({ localUpdated: verified.localUpdated, squareUpdated: verified.squareUpdated, report: 'reports/square-units/2026-10-11/user-corrections/completed.html' }));
