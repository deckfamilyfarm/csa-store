import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import XLSX from '../../../../apps/api/node_modules/xlsx/xlsx.js';
const directory=new URL('./',import.meta.url),root=new URL('../',import.meta.url);
const read=async n=>JSON.parse(await readFile(new URL(n,directory),'utf8'));
const old=await read('../report-data.json'),scope=await read('scope.json'),summary=await read('verification-summary.json'),vendorSave=await read('vendor-save.json'),plan=await read('vendor-plan.json'),after=await read('catalog-after.json'),release=await read('release.json');
const actions=new Map(release.actions.map(a=>[a.productId,a])),products=new Map(old.products.map(p=>[p.productId,{...p,verificationDate:old.verifiedAt}]));
const money=n=>n==null?'':Number(n).toFixed(2);
const range=values=>{const a=values.filter(x=>x!=null).map(Number);return a.length?Math.min(...a)===Math.max(...a)?'$'+money(a[0]):`$${money(Math.min(...a))}–$${money(Math.max(...a))}`:'';};
const prices=[],choices=[];
for(const item of scope.eligible){
  const r=await read(`audit/${item.id}.json`),a=actions.get(item.id),confirmed=a?.status==='completed';
  if([928741,928742,957990,981122,981124,1011876].includes(item.id))choices.push({ProductID:item.id,Product:item.name,LocalVendor:item.vendor,RemoteVendorBefore:r.remote?.vendor??'',RemoteVendorAfter:confirmed?r.payload.vendor:r.remote?.vendor??'',MarkupChange:item.vendorOnly?'Excluded; vendor only':'45%',Result:confirmed?'Verified':'Held'});
  if(item.vendorOnly)continue;
  const previous=products.get(item.id);
  products.set(item.id,{...previous,productId:item.id,product:item.name,vendor:item.vendor,category:item.category,visible:item.visible,
    markupBefore:previous?.markupBefore??[...new Set(r.rows.map(p=>p.markupBefore))].join(' / '),markupAfter:45,
    localPriceBefore:previous?.localPriceBefore??range(r.rows.map(p=>p.localPriceBefore)),localPriceAfter:range(r.rows.map(p=>p.localPriceAfter)),
    confirmed,status:confirmed?'Local + Local Line verified':'Local saved; Local Line held',reason:confirmed?'':r.problems.join(' ')||a?.message||'Not published',warnings:r.warnings.join(' | '),verificationDate:summary.verifiedAt});
  for(const row of r.rows)prices.push({...row,remotePriceAfter:confirmed?row.remotePriceAfter:row.remotePriceBefore,remoteAdjustmentAfter:confirmed?row.remoteAdjustmentAfter:row.remoteAdjustmentBefore,result:confirmed?'Verified':'Held',reason:products.get(item.id).reason});
}
for(const p of products.values()){const product=after.products.find(x=>x.id===p.productId);p.vendor=after.vendors.find(v=>v.id===product.vendorId)?.name||'';}
const rows=[...products.values()].sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.product.localeCompare(b.product)),held=rows.filter(p=>!p.confirmed);
const vendors=after.vendors.map(v=>({VendorID:v.id,Vendor:v.name,PricelistMarkup:v.priceListMarkup,GuestFallback:v.guestMarkup,MemberFallback:v.memberMarkup,SourceMultiplier:v.sourceMultiplier,AddedLocally:plan.vendorChanges.some(x=>x.id===v.id)}));
const assignmentRows=plan.changes.map(x=>({ProductID:x.id,Product:x.name,LocalVendorBefore:x.oldVendor||'Unassigned',LocalVendorAfter:x.vendor,LocalLineProductID:x.remoteId,LocalVendorIDBefore:x.oldVendorId,LocalVendorIDAfter:x.vendorId}));
const unresolved=plan.exceptions.filter(x=>!choices.some(c=>c.ProductID===x.id)).map(x=>({ProductID:x.id,Product:x.name,LocalVendor:x.oldVendor,Reason:x.issue}));
const totals={...summary,...vendorSave,checks:{vendorReconciliation:vendorSave.checks,pricing:summary.checks},localProductsAt45:rows.length,remoteProductsVerified:rows.filter(p=>p.confirmed).length,remoteProductsHeld:held.length,previousTrialAdditional:1};
assert.equal(rows.length,old.products.length+summary.newLocal45);assert.ok(choices.find(p=>p.ProductID===1011876)?.MarkupChange.includes('Excluded'));
const columns={productId:'Product ID',product:'Product',vendor:'Vendor',category:'Category',markupBefore:'Original local markup %',markupAfter:'New markup %',localPriceBefore:'Original local price range',localPriceAfter:'New local price range',status:'Result',reason:'Remaining issue',warnings:'Notes',verificationDate:'Verified/reviewed UTC'};
const mapped=rs=>rs.map(r=>Object.fromEntries(Object.entries(columns).map(([k,v])=>[v,r[k]??''])));
const overview=[
  {Item:'Updated through',Value:summary.verifiedAt},
  {Item:'Local vendor records added',Value:vendorSave.vendorsInserted},
  {Item:'Local product vendor assignments corrected',Value:vendorSave.productsReassigned},
  {Item:'Previously unassigned local products resolved',Value:vendorSave.missingVendorsResolved},
  {Item:'This follow-up: additional local products at 45%',Value:summary.newLocal45},
  {Item:'This follow-up: Local Line price results verified',Value:summary.remotePriceProducts},
  {Item:'This follow-up: vendor-only result',Value:summary.remoteVendorOnlyProducts},
  {Item:'Cumulative local products at 45%, excluding original trial',Value:totals.localProductsAt45},
  {Item:'Cumulative Local Line products verified, excluding original trial',Value:totals.remoteProductsVerified},
  {Item:'Remaining markup publications held',Value:held.length},
  {Item:'Previous trial',Value:'Roasted Hazelnuts 4 oz #806107 remains at 45%; add one to cumulative counts above.'},
  {Item:'Six exceptions',Value:'Use existing local vendors for all six; publish those assignments to Local Line. Classic Pork Broth receives vendor-only correction.'},
  {Item:'Protected pricing',Value:'Deck, Creamy Cow, Hyland, Classic Pork Broth, deposits and Membership excluded from markup updates.'},
  {Item:'Vendor defaults',Value:'Existing defaults preserved. Local Line vendor records do not contain these markup fields. New vendors use schema defaults; explicit 45% product overrides control updated products.'},
  {Item:'Preserved fields',Value:'No base-price, inventory, visibility, sale, description, image, Square, or turkey preorder changes sent. Intervening catalog updates retained.'},
  {Item:'Local Line prices',Value:'Report calculations use verified API pricing inputs and current app rounding; not a public checkout capture.'},
  {Item:'Newly assigned products',Value:'Original local rates can vary when no vendor was assigned. Follow-up package rows show the post-vendor-correction pricing baseline.'},
  {Item:'Product Sync',Value:`Audit ${summary.auditId}; release ${summary.releaseId}: ${summary.releaseStatus}`},
  {Item:'Application code',Value:'Product override changes remain in the local checkout; no production application deployment performed.'}
];
const book=XLSX.utils.book_new();
function sheet(name,data){const ws=XLSX.utils.json_to_sheet(data);if(ws['!ref'])ws['!autofilter']={ref:ws['!ref']};ws['!cols']=Object.keys(data[0]||{}).map(k=>({wch:Math.min(70,Math.max(k.length+2,...data.slice(0,150).map(r=>String(r[k]??'').length+1)))}));XLSX.utils.book_append_sheet(book,ws,name);}
const packageKey=r=>[r.productId,r.packageId,r.priceList].join('|');
const cumulativePrices=new Map(old.prices.map(p=>[packageKey(p),{...p}]));
for(const p of prices){const prior=cumulativePrices.get(packageKey(p));cumulativePrices.set(packageKey(p),{...prior,...p,markupBefore:prior?.markupBefore??p.markupBefore,localPriceBefore:prior?.localPriceBefore??p.localPriceBefore,remotePriceBefore:prior?.remotePriceBefore??p.remotePriceBefore,remoteAdjustmentBefore:prior?.remoteAdjustmentBefore??p.remoteAdjustmentBefore});}
for(const p of cumulativePrices.values()){p.vendor=products.get(p.productId)?.vendor||p.vendor;p.remoteStatus=p.result??p.remoteStatus;}
sheet('Summary',overview);sheet('All Product Changes',mapped(rows));sheet('All Package Prices',[...cumulativePrices.values()]);sheet('Remaining Price Exceptions',mapped(held));sheet('Vendor Assignments',assignmentRows);sheet('Vendor Defaults',vendors);sheet('Six Approved Choices',choices);sheet('Follow-up Package Prices',prices);sheet('Other Vendor Issues',unresolved);
XLSX.writeFile(book,new URL('markup-change-report-updated.xlsx',root).pathname);
const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
const csv=data=>{const keys=Object.keys(data[0]||{});return '\uFEFF'+[keys,...data.map(r=>keys.map(k=>typeof r[k]==='string'&&/^[=+@-]/.test(r[k])?"'"+r[k]:r[k]))].map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n';};
for(const [name,data]of [['product-changes-updated.csv',mapped(rows)],['vendor-assignments.csv',assignmentRows],['exceptions-updated.csv',mapped(held)]])await writeFile(new URL(name,root),csv(data));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table=(data,cols)=>`<div class="scroll"><table><thead><tr>${cols.map(([key,label])=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${data.map(r=>`<tr>${cols.map(([key])=>`<td>${esc(r[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const reasons={};for(const p of held){const key=/box\/bundle/.test(p.reason)?'Unsupported boxes/bundles':/404/.test(p.reason)?'Missing Local Line product':/link/.test(p.reason)?'Missing saved Local Line link':/Sale/.test(p.reason)?'Sale discrepancy':'Other';reasons[key]=(reasons[key]||0)+1;}
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Updated vendor and markup report</title><style>body{font:15px system-ui;max-width:1400px;margin:35px auto;padding:0 25px;color:#233c2d;background:#f8faf6}h1{border-top:6px solid #396540;padding-top:25px}p{line-height:1.6;max-width:1100px}.cards{display:flex;gap:16px;flex-wrap:wrap}.card{padding:20px;background:#fff;border:1px solid #ccd9c5;border-radius:8px}.card b{display:block;font-size:32px}.scroll{overflow:auto;max-height:600px;margin:18px 0}table{border-collapse:collapse;background:white;width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #dde5d9;vertical-align:top}th{background:#e8f0e2;position:sticky;top:0}a{color:#2d6036}input{font:inherit;padding:12px;min-width:320px}.notice{padding:15px;background:#fff2d7;border-left:4px solid #b78129}h2{margin-top:30px}footer{margin:35px 0;color:#51634e}</style></head><body>
<h1>Vendor reconciliation & 45% markup updates</h1><p>Updated ${esc(new Date(summary.verifiedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}))} Pacific. Local Line supplied the authoritative vendor list and product assignments, with the six local-vendor exceptions explicitly approved by you.</p>
<div class="cards"><div class="card"><b>${vendorSave.vendorsInserted}</b>Vendor records added</div><div class="card"><b>${vendorSave.productsReassigned}</b>Local assignments corrected</div><div class="card"><b>${totals.localProductsAt45}</b>Products at 45% locally</div><div class="card"><b>${totals.remoteProductsVerified}</b>Verified in Local Line</div><div class="card"><b>${held.length}</b>Price publications held</div></div>
<p>Cumulative counts exclude the original hazelnut trial, which remains successfully updated. This follow-up added ${summary.newLocal45} local markup overrides and verified ${summary.remotePriceProducts} Local Line price results, plus ${summary.remoteVendorOnlyProducts} vendor-only correction.</p>
<p><a href="markup-change-report-updated.xlsx">Download complete Excel report</a> · <a href="product-changes-updated.csv">Product CSV</a> · <a href="vendor-assignments.csv">Vendor corrections CSV</a> · <a href="exceptions-updated.csv">Remaining exceptions CSV</a></p>
<div class="notice"><strong>Classic Pork Broth’s markup and prices were preserved.</strong> It received only the approved Hyland vendor assignment in Local Line. Deck, Hyland and Creamy Cow pricing remains excluded from this markup rollout.</div>
<h2>Your six decisions</h2>${table(choices,[['Product','Product'],['LocalVendor','Vendor used'],['MarkupChange','Pricing treatment'],['Result','Result']])}
<h2>Remaining price exceptions</h2><p>${Object.entries(reasons).map(([k,v])=>`${v} ${esc(k.toLowerCase())}`).join(' · ')}</p>${table(held,[['product','Product'],['vendor','Vendor'],['reason','Reason held']])}
<h2>Vendor corrections</h2>${table(assignmentRows,[['ProductID','ID'],['Product','Product'],['LocalVendorBefore','Previous local vendor'],['LocalVendorAfter','Corrected vendor']])}
<h2>All markup changes</h2><input id="search" placeholder="Filter products by name, vendor or ID" aria-label="Filter markup changes"><div id="products">${table(rows,[['productId','ID'],['product','Product'],['vendor','Vendor'],['markupBefore','Original markup %'],['markupAfter','New markup %'],['localPriceBefore','Original local prices'],['localPriceAfter','New local prices'],['status','Result']])}</div>
<h2>Preservation and defaults</h2><p>Existing vendor pricing defaults were preserved. Local Line vendors do not supply those markup fields; the 45% rate is stored as a product override. New vendor records use database schema defaults. Base prices, inventory, visibility, sales, descriptions and images were preserved. No Square or turkey preorder updates were sent. Live catalog changes between the initial preview and execution were retained.</p><p>Local Line price figures are calculated from verified API inputs. Newly assigned products may have had different fallback local rates; the workbook records their pricing baseline after vendor correction. Product override application changes remain local and have not been deployed to production.</p>
<footer>Product Sync audit ${summary.auditId}, release ${summary.releaseId}: ${esc(summary.releaseStatus)}. All recorded preservation checks passed. Full source snapshots, frozen release payloads and independent readbacks are retained with this report.</footer>
<script>document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const row of document.querySelectorAll('#products tbody tr'))row.hidden=!row.textContent.toLowerCase().includes(q);});</script></body></html>`;
await writeFile(new URL('markup-change-report-updated.html',root),html);
await writeFile(new URL('report-updated-data.json',root),JSON.stringify({summary:totals,reasons,products:rows,held,assignmentRows,choices,unresolved,overview},null,2)+'\n');
const checked=XLSX.readFile(new URL('markup-change-report-updated.xlsx',root).pathname);assert.equal(XLSX.utils.sheet_to_json(checked.Sheets['All Product Changes']).length,rows.length);assert.equal(XLSX.utils.sheet_to_json(checked.Sheets['Vendor Assignments']).length,assignmentRows.length);
console.log(JSON.stringify({summary:totals,reasons,workbookSheets:checked.SheetNames},null,2));
