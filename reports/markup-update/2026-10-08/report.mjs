import { readFile, writeFile } from 'node:fs/promises';
import XLSX from '../../../apps/api/node_modules/xlsx/xlsx.js';

const directory=new URL('./',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,directory),'utf8'));
const maybeRead=async name=>{try{return await read(name);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const scope=await read('scope.json');
const summary=await read('verification-summary.json');
const release=await read('release.json');
const actions=new Map(release.actions.map(a=>[a.productId,a]));
const verifiedVendorNames=new Map();
for(const row of scope.eligible) {
  const record=await read(`audit/${row.id}.json`);
  if(record.context.localLineVendorId) verifiedVendorNames.set(Number(record.context.localLineVendorId),record.context.vendor.name);
}
const products=[],prices=[],exceptions=[];
const money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
const unique=values=>[...new Set(values)];
const range=values=>{const a=values.filter(v=>v!=null&&Number.isFinite(Number(v))).map(Number);return !a.length?'—':Math.min(...a)===Math.max(...a)?money(a[0]):`${money(Math.min(...a))}–${money(Math.max(...a))}`;};
for(const row of scope.eligible) {
  const r=await read(`audit/${row.id}.json`);const a=actions.get(row.id);const v=await maybeRead(`verification/${row.id}.json`);
  const confirmed=Boolean(v?.priceConfirmed);
  const remoteVendorId=r.remote?.vendor?.id??r.remote?.vendor??null;
  const remoteVendor=remoteVendorId?verifiedVendorNames.get(Number(remoteVendorId))||`Vendor ID ${remoteVendorId}`:'Unassigned / unavailable';
  let reason=confirmed?'':v&&!v.priceConfirmed?'Local Line readback differs from the approved prices; review required':r.problems.join(' ')||a?.message||'Local Line verification is incomplete';
  if(reason.includes('vendor differs')) reason+=` (local: ${row.vendor}; Local Line: ${remoteVendor})`;
  const status=confirmed?'Local + Local Line verified':'Local saved; Local Line held';
  const packageIds=unique(r.rows.map(p=>p.packageId));
  const p={productId:row.id,product:row.name,vendor:row.vendor,category:row.category,visible:row.visible,
    markupBefore:40,markupAfter:45,packageCount:packageIds.length,localPriceBefore:range(r.rows.map(x=>x.localPriceBefore)),
    localPriceAfter:range(r.rows.map(x=>x.localPriceAfter)),remoteVendorId,remoteVendor,status,reason,warnings:unique(r.warnings||[]).join(' | '),confirmed};
  products.push(p);
  if(!confirmed)exceptions.push(p);
  for(const x of r.rows) {
    const oldPackage=r.remote?.packages?.find(pkg=>Number(pkg.id)===Number(r.context.packageMeta.find(m=>m.packageId===x.packageId)?.localLinePackageId||x.packageId));
    const listName=x.priceList;
    const oldEntry=oldPackage?.price_list_entries.find(e=>e.price_list_name===listName);
    const present=Boolean(oldEntry);
    prices.push({...x,package:x.package||`Package ${x.packageId}`,localChange:x.localPriceBefore==null||x.localPriceAfter==null?null:Number((x.localPriceAfter-x.localPriceBefore).toFixed(2)),
      remotePriceAfter:confirmed&&present?x.remotePriceAfter:present?x.remotePriceBefore:null,
      remoteAdjustmentAfter:confirmed&&present?x.remoteAdjustmentAfter:present?x.remoteAdjustmentBefore:null,
      remoteStatus:!present?'Not listed in Local Line':confirmed?'Verified':'Held / unchanged',
      status,reason,warnings:p.warnings});
  }
}
products.sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.product.localeCompare(b.product));
prices.sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.product.localeCompare(b.product)||a.package.localeCompare(b.package)||a.priceList.localeCompare(b.priceList));
const vendors=unique(products.map(p=>p.vendor)).sort().map(vendor=>{
  const rows=products.filter(p=>p.vendor===vendor);
  return {vendor,localUpdated:rows.length,localLineVerified:rows.filter(p=>p.confirmed).length,localLineHeld:rows.filter(p=>!p.confirmed).length,
    productsWithNotes:rows.filter(p=>p.warnings).length};
});
function exceptionKind(reason) {
  return /vendor differs/i.test(reason)?'Vendor mismatch':/box\/bundle/i.test(reason)?'Unsupported Local Line box/bundle':/404/.test(reason)?'Remote product not found':
    /product link/i.test(reason)?'Missing Local Line link':/Sale status/.test(reason)?'Sale mismatch':'Other';
}
const reasons={};for(const p of exceptions){const k=exceptionKind(p.reason);reasons[k]=(reasons[k]||0)+1;}
const excludedReasons={};for(const p of scope.excluded)excludedReasons[p.reason]=(excludedReasons[p.reason]||0)+1;
const excluded=scope.excluded.map(p=>({productId:p.id,product:p.name,vendor:p.vendor||'Unassigned',category:p.category,visible:p.visible,reason:p.reason}));
const report={...summary,createdAt:new Date().toISOString(),vendors,products,prices,exceptions,excluded,reasons,excludedReasons,
  priceListRows:prices.length,publishedPriceListRows:prices.filter(p=>p.remoteStatus==='Verified').length,
  notListedRows:prices.filter(p=>p.remoteStatus==='Not listed in Local Line').length,
  preExistingRemotePriceDifferences:products.filter(p=>p.warnings.includes('differed from local')).length};
await writeFile(new URL('report-data.json',directory),JSON.stringify(report,null,2)+'\n');

const productColumns={productId:'Product ID',product:'Product',vendor:'Vendor',remoteVendor:'Local Line vendor',remoteVendorId:'Local Line vendor ID',category:'Category',visible:'Visible',markupBefore:'Markup before %',markupAfter:'Markup after %',packageCount:'Packages',localPriceBefore:'Local price before',localPriceAfter:'Local price after',status:'Result',reason:'Exception',warnings:'Notes'};
const priceColumns={productId:'Product ID',product:'Product',vendor:'Vendor',packageId:'Package ID',package:'Package',priceList:'Customer price list',basePrice:'Local base price',markupBefore:'Markup before %',markupAfter:'Markup after %',saleDiscount:'Sale discount %',localPriceBefore:'Local price before',localPriceAfter:'Local price after',localChange:'Local price change',remoteBasePrice:'Local Line base price',remoteAdjustmentType:'Local Line adjustment type (1=dollars, 2=percent, 3=fixed)',remoteAdjustmentBefore:'Local Line adjustment before',remoteAdjustmentAfter:'Local Line adjustment after',remotePriceBefore:'Local Line price before (calculated)',remotePriceAfter:'Local Line price after (calculated)',remoteStatus:'Local Line result',reason:'Exception',warnings:'Notes'};
const remap=(rows,columns)=>rows.map(r=>Object.fromEntries(Object.entries(columns).map(([k,label])=>[label,r[k]??''])));
function csv(rows,columns) {
  const text=value=>{const s=String(value??'');return /[=+@-]/.test(s[0]||'')&&typeof value==='string'?"'"+s:s;};
  const quote=value=>'"'+text(value).replace(/"/g,'""')+'"';
  return '\uFEFF'+[Object.values(columns),...rows.map(r=>Object.keys(columns).map(k=>r[k]))].map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n';
}
await writeFile(new URL('product-changes.csv',directory),csv(products,productColumns));
await writeFile(new URL('package-price-changes.csv',directory),csv(prices,priceColumns));
await writeFile(new URL('exceptions.csv',directory),csv(exceptions,productColumns));
await writeFile(new URL('excluded-products.csv',directory),csv(excluded,{productId:'Product ID',product:'Product',vendor:'Vendor',category:'Category',visible:'Visible',reason:'Reason unchanged'}));
const workbook=XLSX.utils.book_new();
function sheet(name,rows) {
  const ws=XLSX.utils.json_to_sheet(rows);const headers=Object.keys(rows[0]||{});
  ws['!cols']=headers.map(h=>({wch:Math.min(75,Math.max(h.length+2,...rows.slice(0,200).map(r=>String(r[h]??'').length+1)))}));
  if(ws['!ref'])ws['!autofilter']={ref:ws['!ref']};
  for(const key of Object.keys(ws))if(!key.startsWith('!')&&ws[key].t==='n') {
    const column=XLSX.utils.decode_cell(key).c;
    if(/price|change/i.test(headers[column])&&!/list|type/i.test(headers[column]))ws[key].z='$0.00';
  }
  XLSX.utils.book_append_sheet(workbook,ws,name);
}
sheet('Summary',[
  {Item:'Operation',Value:'Existing non-Deck products, customer markup 40% to 45%'},
  {Item:'Verified at (Pacific)',Value:new Date(summary.verifiedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles'})},
  {Item:'Local products updated',Value:summary.localUpdated},
  {Item:'Local Line products verified',Value:summary.remoteConfirmed},
  {Item:'Local products updated; Local Line held',Value:summary.remoteHeld},
  {Item:'Other catalog products unchanged',Value:scope.excluded.length},
  {Item:'Previous successful trial',Value:'Farmhands Roasted Hazelnuts 4 oz #806107, already 45%; not changed again'},
  {Item:'Audit / release',Value:`${summary.auditId} / ${summary.releaseId}`},
  {Item:'Protection',Value:'Deck, Creamy Cow, Hyland, Deck/Hyland-named products, Membership and missing-vendor products unchanged'},
  {Item:'Vendor defaults',Value:'Unchanged. Explicit overrides apply to the updated existing products; future products still inherit vendor defaults.'},
  {Item:'Other fields',Value:'No base-price, inventory, visibility, description, image, sale, Square, or preorder changes requested or sent'},
  {Item:'Price interpretation',Value:'Local prices use current app rounding. Local Line prices are calculated from verified API inputs, not a public storefront checkout.'},
  {Item:'Missing lists',Value:'Only existing configured Local Line customer price-list entries updated; missing entries were not created.'},
  {Item:'Existing remote differences',Value:`${report.preExistingRemotePriceDifferences} products had remote rates/prices different from the local 40% baseline; report records actual before values.`},
  ...Object.entries(reasons).map(([Item,Value])=>({Item:`Held: ${Item}`,Value})),
  ...Object.entries(excludedReasons).map(([Item,Value])=>({Item:`Unchanged: ${Item}`,Value}))
]);
sheet('Vendors',vendors);sheet('Product Changes',remap(products,productColumns));sheet('Package Prices',remap(prices,priceColumns));
sheet('Local Line Exceptions',remap(exceptions,productColumns));sheet('Unchanged Products',excluded);
XLSX.writeFile(workbook,new URL('markup-change-report.xlsx',directory).pathname);

const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vendorRows=vendors.map(v=>`<tr><td>${escape(v.vendor)}</td><td>${v.localUpdated}</td><td>${v.localLineVerified}</td><td>${v.localLineHeld}</td></tr>`).join('');
const list=obj=>Object.entries(obj).map(([k,v])=>`<li><strong>${v}</strong> ${escape(k)}</li>`).join('');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CSA markup change report · October 8, 2026</title>
<style>:root{font-family:system-ui,-apple-system,sans-serif;color:#203629;background:#f4f5ef;font-size:15px}body{max-width:1400px;margin:auto;padding:36px 28px}header{border-top:7px solid #36583c;padding:28px 0 22px}h1{font-size:36px;letter-spacing:-1px;margin:7px 0 14px}h2{font-size:23px;margin-top:34px}p{line-height:1.65;max-width:1050px}a{color:#27543b}small,.muted{color:#617067}.eyebrow{text-transform:uppercase;letter-spacing:2px;font-size:12px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.card{background:white;border:1px solid #dde3d7;border-radius:9px;padding:20px}.card b{display:block;font-size:35px;margin-bottom:7px}.amber{color:#935a14}.notice{border-left:4px solid #b17922;background:#fff8e9;padding:15px 20px}.downloads{display:flex;gap:16px;flex-wrap:wrap;margin:20px 0}table{border-collapse:collapse;width:100%;background:white;font-size:13px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #e4e8e0;vertical-align:top}th{position:sticky;top:0;background:#eaf0e5;white-space:nowrap}td.notes{min-width:220px;max-width:380px;line-height:1.5}.scroll{overflow:auto;max-height:650px;border:1px solid #dce3d6;border-radius:7px}.filters{display:flex;gap:10px;flex-wrap:wrap;margin:15px 0}input,select,button{font:inherit;padding:10px;border:1px solid #bbcbb4;border-radius:5px;background:white}input{min-width:270px}.tag{font-size:11px;padding:4px 7px;border-radius:4px;display:inline-block;background:#e7f2e3;color:#285b31}.tag.held{background:#fff0ce;color:#82520a}ul{line-height:1.8}.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}footer{margin-top:35px;padding:20px 0;border-top:1px solid #cfd9c6;font-size:12px;line-height:1.8}@media(max-width:750px){body{padding:18px}.cards,.cols{grid-template-columns:1fr 1fr}h1{font-size:28px}}@media print{.filters,.downloads{display:none}.scroll{max-height:none;overflow:visible}th{position:static}body{padding:0}.cards{break-inside:avoid}table{font-size:9px}}</style></head><body>
<header><div class="eyebrow">Full Farm CSA · Change record · October 8, 2026</div><h1>Customer markup: 40% → 45%</h1><p>The approved rollout updates existing eligible products locally and publishes the supported changes to Local Line. Deck Family Farm, Creamy Cow, Hyland, and Deck/Hyland-branded items are excluded. Product Sync audit <strong>#${summary.auditId}</strong>, release <strong>#${summary.releaseId}</strong>.</p><small>Verified ${escape(new Date(summary.verifiedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}))} Pacific</small></header>
<div class="cards"><div class="card"><b>${summary.localUpdated}</b>Products saved locally at 45%</div><div class="card"><b>${summary.remoteConfirmed}</b>Products verified in Local Line</div><div class="card"><b class="amber">${summary.remoteHeld}</b>Local Line updates held</div><div class="card"><b>${scope.excluded.length}</b>Other products unchanged</div></div>
<div class="notice"><strong>Exceptions need follow-up.</strong> The held products have the new local markup, while their Local Line pricing remains unchanged. Missing vendors, vendor mismatches, sales, and unsupported items are identified below. The earlier hazelnut trial remains at 45% and is counted among unchanged products in this rollout.</div>
<div class="downloads"><a href="markup-change-report.xlsx">Download Excel workbook</a><a href="product-changes.csv">Product changes CSV</a><a href="package-price-changes.csv">Package prices CSV</a><a href="exceptions.csv">Local Line exceptions CSV</a><a href="excluded-products.csv">Unchanged products CSV</a></div>
<div class="cols"><section><h2>Local Line exceptions</h2><ul>${list(reasons)}</ul></section><section><h2>Products left unchanged</h2><ul>${list(excludedReasons)}</ul></section></div>
<h2>By vendor</h2><div class="scroll" style="max-height:none"><table><thead><tr><th>Vendor</th><th>Local saved</th><th>Local Line verified</th><th>Local Line held</th></tr></thead><tbody>${vendorRows}</tbody></table></div>
<h2>Product changes</h2><p>Prices below are the local customer prices, shown as a range for products with multiple packages. The Excel workbook and package CSV contain each package and customer price list, including actual Local Line before values and verified after calculations.</p>
<div class="filters"><input id="search" placeholder="Search product, ID, or note" aria-label="Search products"><select id="vendor" aria-label="Filter vendor"><option value="">All vendors</option>${vendors.map(v=>`<option>${escape(v.vendor)}</option>`).join('')}</select><select id="status" aria-label="Filter result"><option value="">All results</option><option value="verified">Verified in both</option><option value="held">Local Line held</option><option value="notes">Products with notes</option></select><span id="count" class="muted"></span></div>
<div class="scroll"><table><thead><tr><th>Product / ID</th><th>Vendor</th><th>Markup</th><th>Before</th><th>After</th><th>Result</th><th>Notes / exceptions</th></tr></thead><tbody id="products"></tbody></table></div>
<h2>What was preserved</h2><p>Vendor defaults, base prices, inventory, tracking, visibility, descriptions, images, and sales were not changed by this operation. No Square or turkey preorder updates were sent. The markup is saved as an explicit product override; defaults inherited by newly created products remain unchanged. Only existing Local Line price-list entries were updated, and no missing listings were created.</p>
<p>For a product whose customer price previously reflected 40%, moving to 45% raises the unrounded customer price by about 3.57%. Existing app rounding is preserved, including the half-cent behavior seen in the hazelnut trial. ${report.preExistingRemotePriceDifferences} products had pre-existing Local Line rates or fixed prices that differed from local 40% pricing; the workbook records those values. Local Line displayed-price figures in this report are calculated from verified API inputs rather than a public checkout.</p>
<footer>Verification: all local target markups = 45%: ${summary.allLocal45?'PASS':'REVIEW'} · Vendor defaults preserved: ${summary.checks.vendors?'PASS':'REVIEW'} · Other product profiles preserved: ${summary.checks.excludedProfiles?'PASS':'REVIEW'} · Local packages preserved: ${summary.checks.packages?'PASS':'REVIEW'}<br>Prepared from frozen pre-change snapshots, saved Product Sync actions, and independent Local Line readbacks. The new override application code is in the local checkout; no production application deployment was performed as part of this report.</footer>
<script>const data=${JSON.stringify(products).replace(/</g,'\\u003c')};const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function render(){const q=document.querySelector('#search').value.toLowerCase(),v=document.querySelector('#vendor').value,s=document.querySelector('#status').value;const rows=data.filter(p=>(!v||p.vendor===v)&&(!q||[p.product,p.productId,p.reason,p.warnings].join(' ').toLowerCase().includes(q))&&(!s||(s==='verified'&&p.confirmed)||(s==='held'&&!p.confirmed)||(s==='notes'&&p.warnings)));document.querySelector('#count').textContent=rows.length+' products';document.querySelector('#products').innerHTML=rows.map(p=>'<tr><td><strong>'+esc(p.product)+'</strong><br><small>'+p.productId+'</small></td><td>'+esc(p.vendor)+'</td><td>40% → 45%</td><td>'+p.localPriceBefore+'</td><td>'+p.localPriceAfter+'</td><td><span class="tag '+(p.confirmed?'':'held')+'">'+(p.confirmed?'Verified':'Local Line held')+'</span></td><td class="notes">'+esc([p.reason,p.warnings].filter(Boolean).join(' | '))+'</td></tr>').join('');}for(const id of ['search','vendor','status'])document.getElementById(id).addEventListener('input',render);render();</script></body></html>`;
await writeFile(new URL('markup-change-report.html',directory),html);
console.log(JSON.stringify({products:products.length,verified:products.filter(p=>p.confirmed).length,exceptions:exceptions.length,priceRows:prices.length,artifacts:['markup-change-report.html','markup-change-report.xlsx','product-changes.csv','package-price-changes.csv','exceptions.csv','excluded-products.csv'],reasons},null,2));
