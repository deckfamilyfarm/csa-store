import fs from 'node:fs';
import path from 'node:path';
import { buildPricingSalesReview, discountPrice } from './pricingSalesReview.mjs';
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!arg('dir')) throw Error('Provide --dir=<private capture directory>.');
const dir = arg('dir'), read = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
const local = read('local.json'), channels = read('channels.json');
if (arg('full-capture')) {
  const readFull = name => JSON.parse(fs.readFileSync(path.join(arg('full-capture'), name)));
  const manifest = readFull('manifest.json');
  // Local Line includes legacy box aliases in its product export. Its explicit
  // product_is_box response excludes those from the ordinary product endpoint;
  // native boxes are captured separately. Never excuse other HTTP failures.
  const aliases = manifest.errors.filter(e => e.productId && e.error.includes('"code":"product_is_box"'));
  if (aliases.length !== manifest.errors.length || manifest.products + aliases.length !== manifest.expectedProducts) throw Error('Full channel capture is incomplete.');
  channels.excludedBoxAliases = aliases.map(e => e.productId);
  channels.products = readFull('localline-products.json');
  channels.square = readFull('square-catalog.json').objects;
  channels.capturedAt = manifest.finishedAt;
  const saleRemoteIds = new Set(channels.products.filter(p => p.packages?.some(k => k.price_list_entries?.some(e => e.on_sale || e.on_sale_toggle))).map(p => Number(p.id)));
  channels.saleProductIds = [...new Set([...channels.saleProductIds, ...local.tables.local_line_product_meta.filter(m => saleRemoteIds.has(Number(m.local_line_product_id))).map(m => Number(m.product_id))])];
}
const report = buildPricingSalesReview(local, channels);
report.excludedBoxAliases = channels.excludedBoxAliases || [];
const decisionPath = path.join(dir, 'decisions.json');
report.decisions = fs.existsSync(decisionPath) ? JSON.parse(fs.readFileSync(decisionPath)) : null;
const money = cents => cents == null ? 'Review' : `$${(cents / 100).toFixed(2)}`;
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table = (headers, rows) => `<table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
report.sales.sort((a,b) => Number(b.visible)-Number(a.visible)||a.name.localeCompare(b.name));
const sales = report.sales.map(s => [s.name + (s.visible ? '' : ` — ${s.packageName}`), money(s.sale?.baskets[0]?.priceCents), s.sale?.discountPercent == null ? 'Review' : `${s.sale.discountPercent}%`, money(s.regularCents), money(s.proposedSaleCents),
  s.productId === report.decisions?.salami?.productId ? 'Approved intent: $13.50 regular, remove sale display at publication.' :
    !s.visible ? `Held; remains hidden. ${s.sale?.issue || 'Review before publishing.'}` :
      report.decisions?.retainVisibleDiscounts && !s.sale?.issue ? (report.decisions?.endPolicy === 'until-manually-turned-off' ? 'Retain discount until turned off in the interface; publication pending.' : 'Retain discount; end date and channel publication pending.') : s.sale?.issue || 'Choose whether to keep the discount and its end date.']);
const bundles = report.bundles.map(b => [b.name + (b.visible ? ' (visible)' : ' (hidden)'), [...new Set(b.remoteBaskets.map(p => money(p.priceCents)))].join(' / '), money(b.regularScenarioCents), money(b.retainedSalesScenarioCents), `$${b.buyPrice}`]);
const headers = ['Product','Current LL selling','Discount','New regular','Keep discount','Decision'];
const square = report.sales.filter(s => s.visible).map(s => [s.name, s.pricingUnit, money(s.squareCatalogCents), money(s.squareCents), s.sale?.discountPercent == null || s.squareCents == null ? '—' : money(discountPrice(s.squareCents, s.sale.discountPercent))]);
const html = `<!doctype html><meta charset="utf-8"><title>Sales and bundle review</title><style>body{font:16px system-ui;margin:32px;max-width:1400px;color:#19392c}table{border-collapse:collapse;width:100%;margin-bottom:32px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ccc}th{background:#edf3ed}h1{font-size:26px}p{max-width:900px}summary{cursor:pointer;font-weight:bold;padding:15px 0}</style><h1>Sales and bundle review</h1><p>Channel snapshot: ${escape(report.capturedAt)}. No dates, promotions or publications have been created. Decisions below record intent for rollout; live prices are unchanged.</p><h2>Visible Local Line sales</h2><p>“Keep discount” applies the inferred percentage to the new local regular package price. All amounts are per package.</p>${table(headers,sales.filter((_,i) => report.sales[i].visible))}<details><summary>Hidden products: older sale flags held for review</summary>${table(headers,sales.filter((_,i) => !report.sales[i].visible))}</details><h2>Bundle pilots</h2><p>Each scenario subtracts the configured bundle discount from the sum of its components. Buy Price stays unchanged. Components must be published and verified first. Hidden bundles stay hidden. These are scenarios, not approved publications.</p>${table(['Bundle','Current LL','End old sales','Keep old sales','Buy Price'], bundles)}<details><summary>Square price transition</summary><p>Several current catalog prices already include the sale. Preserve the effective checkout price when restoring regular prices and creating managed automatic discounts. Catalog values alone do not verify actual checkout discounts, units, or stacking. “Review” means a current approved mapping or price is unavailable.</p>${table(['Product','Local pricing unit','Current catalog','New regular','After discount'],square)}</details><p>Bundle prices must be reviewed and republished after component sales start or end; that publication is not automatic.</p>`;
for (const [name, content] of [['review.json',JSON.stringify(report,null,2)],['review.html',html]]) fs.writeFileSync(path.join(dir,name),content,{mode:0o600});
console.log(JSON.stringify({sales:sales,bundles:bundles}, null, 2));
