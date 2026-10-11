import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import XLSX from '../../../apps/api/node_modules/xlsx/xlsx.js';
import {getDb,getPool} from '../../../apps/api/db.js';
import * as schema from '../../../apps/api/schema.js';
import {getLocalLineAccessToken,getLocalLineBaseUrl} from '../../../apps/api/localLineAuth.js';
import {computeProductPricingSnapshot,computeFinalPrice,getPriceListDefinitions} from '../../../apps/api/lib/productPricing.js';

const directory=new URL(process.argv.find(a=>a.startsWith('--directory='))?.slice(12)||'./',import.meta.url),pool=getPool();
const files=['vendors','categories','products','packages','productPricingProfiles','productSales','localLineProductMeta','localLinePackageMeta'];
const read=async file=>JSON.parse(await readFile(new URL(file,directory),'utf8'));
async function exists(file){try{return await read(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function save(file,data){const target=new URL(file,directory),temp=new URL(file+'.tmp',directory);await writeFile(temp,JSON.stringify(data,null,2)+'\n');await rename(temp,target);}
const norm=v=>String(v??'').trim().replace(/\s+/g,' ').toLowerCase();
const blockedName=v=>/deck|hyland|creamy cow/i.test(String(v||''));
function excluded(product,vendor,category){return Boolean(product.isDeleted)||norm(category)==='membership'||product.id===1011876||blockedName(vendor)||blockedName(product.name)||/deposit/i.test(product.name||'');}
async function get(path){
  const base=getLocalLineBaseUrl(),url=new URL(path,base);assert.equal(url.origin,new URL(base).origin);
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${await getLocalLineAccessToken()}`},signal:AbortSignal.timeout(90000)});
    if([429,500,502,503,504].includes(response.status)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));continue;}
    const body=await response.text();let json;try{json=JSON.parse(body);}catch{json=null;}
    if(!response.ok)return {error:{status:response.status,code:json?.code||'',detail:json?.detail||`HTTP ${response.status}`}};
    assert.ok(json,'Non-JSON Local Line response');return {data:json};
  }
}
async function collection(path){const out=[];while(path){const response=await get(path);assert.ok(response.data,JSON.stringify(response.error));if(Array.isArray(response.data)){out.push(...response.data);break;}assert.ok(Array.isArray(response.data.results));out.push(...response.data.results);path=response.data.next;}return out;}
async function snapshot(){
  assert.equal(await exists('snapshot-info.json'),null,'A snapshot exists; do not overwrite a current audit run.');
  await mkdir(new URL('details/',directory),{recursive:true});
  const startedAt=new Date().toISOString(),data={};for(const key of files)data[key]=await getDb().select().from(schema[key]);await save('local.json',data);
  const vendors=await collection('vendors/?page_size=100');await save('remote-vendors.json',vendors);
  const response=await fetch(new URL('products/export/?direct=true',getLocalLineBaseUrl()),{method:'GET',headers:{Authorization:`Bearer ${await getLocalLineAccessToken()}`},signal:AbortSignal.timeout(120000)});assert.ok(response.ok,`Export HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());await writeFile(new URL('live-export.xlsx',directory),bytes);
  const workbook=XLSX.read(bytes,{type:'buffer'}),products=XLSX.utils.sheet_to_json(workbook.Sheets.Availability),packages=XLSX.utils.sheet_to_json(workbook.Sheets['Packages and pricing']);await save('remote-export.json',{products,packages});
  const info={startedAt,snapshotAt:new Date().toISOString(),localProducts:data.products.length,remoteProducts:products.length,localVendors:data.vendors.length,remoteVendors:vendors.length};await save('snapshot-info.json',info);console.log(JSON.stringify(info));
  const swagger=await fetch('https://localline.ca/swagger/backoffice/v2?format=openapi',{signal:AbortSignal.timeout(90000)});
  if(swagger.ok){const spec=await swagger.json();await save('api-schema.json',spec);console.log(JSON.stringify({boxPaths:Object.keys(spec.paths||{}).filter(p=>/box|bundle/.test(p))}));}
}
async function capture(){
  const local=await read('local.json'),remote=await read('remote-export.json'),vendors=await read('remote-vendors.json');
  const remoteById=new Map(remote.products.map(p=>[Number(p['Local Line Product ID']),p]));
  const scope=[];
  for(const p of local.products){
    const vendor=local.vendors.find(v=>v.id===p.vendorId),category=local.categories.find(c=>c.id===p.categoryId)?.name||'';
    const meta=local.localLineProductMeta.find(m=>m.productId===p.id),remoteId=Number(meta?.localLineProductId)||p.id,row=remoteById.get(remoteId);
    if(excluded(p,vendor?.name,category)||blockedName(row?.Vendor))continue;
    scope.push({id:p.id,name:p.name,vendorId:p.vendorId,vendor:vendor?.name||'',remoteId,hasLink:Boolean(meta?.localLineProductId),category,visible:Boolean(p.visible),remoteVisible:row?.Visible??'',remoteVendor:row?.Vendor||''});
  }
  await save('scope.json',scope);let index=0,done=0,errors=0;
  const results=await Promise.allSettled(Array.from({length:4},async()=>{while(index<scope.length){const row=scope[index++];let detail=await exists(`details/${row.id}.json`);if(!detail){try{const r=await get(`products/${row.remoteId}/?expand=packages,product_price_list_entries`);detail={...r,localProductId:row.id,remoteProductId:row.remoteId,checkedAt:new Date().toISOString()};}catch(e){detail={error:{status:0,code:'request_failed',detail:e.message},localProductId:row.id,remoteProductId:row.remoteId,checkedAt:new Date().toISOString()};}await save(`details/${row.id}.json`,detail);}if(detail.error)errors++;if(++done%50===0||done===scope.length)console.log(JSON.stringify({checked:done,total:scope.length,unavailable:errors}));}}));
  for(const r of results)if(r.status==='rejected')throw r.reason;
  await save('capture-info.json',{finishedAt:new Date().toISOString(),scopeProducts:scope.length,checked:done,errors});
}

async function boxes(){const rows=await collection('boxes/?page_size=100&expand=product_price_list_entries');await save('remote-boxes.json',{checkedAt:new Date().toISOString(),boxes:rows});console.log(JSON.stringify({count:rows.length,fields:Object.keys(rows[0]||{}),sample:rows.slice(0,2).map(r=>({id:r.id,name:r.name,price:r.price,vendor:r.vendor,entries:r.product_price_list_entries}))},null,2));}
async function boxProducts(){const rows=await collection('products/?is_box=true&page_size=100&expand=packages,product_price_list_entries');await save('box-products.json',{checkedAt:new Date().toISOString(),products:rows});console.log(JSON.stringify({count:rows.length,fields:Object.keys(rows[0]||{}),sample:rows.slice(0,1)},null,2));}
async function checkLocal(){
  const before=await read('local.json'),after={};for(const key of files)after[key]=await getDb().select().from(schema[key]);
  const relevant={vendors:['id','name','priceListMarkup','sourceMultiplier','guestMarkup','memberMarkup'],categories:['id','name'],products:['id','name','vendorId','categoryId','isDeleted','visible'],packages:['id','productId','name','price'],productPricingProfiles:['productId','markupOverride','customerPriceOverridesJson','guestMarkup','memberMarkup','herdShareMarkup','snapMarkup','onSale','saleDiscount','sourceUnitPrice','sourceMultiplier','unitOfMeasure','minWeight','maxWeight','avgWeightOverride'],productSales:['productId','onSale','saleDiscount'],localLineProductMeta:['productId','localLineProductId'],localLinePackageMeta:['packageId','productId','localLinePackageId']};
  const changed=[];for(const[key,columns]of Object.entries(relevant)){const project=rows=>rows.map(r=>columns.map(k=>r[k]??null)).sort((a,b)=>Number(a[0])-Number(b[0]));if(JSON.stringify(project(before[key]))!==JSON.stringify(project(after[key])))changed.push(key);}
  const result={checkedAt:new Date().toISOString(),readOnly:true,relevantLocalInputsUnchanged:changed.length===0,changedTables:changed};await save('local-stability.json',result);console.log(JSON.stringify(result));assert.equal(changed.length,0,'Local inputs changed during audit; refresh before reporting');
}
try{const phase=process.argv[2];if(phase==='snapshot')await snapshot();else if(phase==='capture')await capture();else if(phase==='boxes')await boxes();else if(phase==='box-products')await boxProducts();else if(phase==='check-local')await checkLocal();else throw new Error('Unknown read-only phase');}finally{await pool.end();}
