// Standalone read-only channel capture. No application bootstrap or database client.
import fs from 'node:fs';import path from 'node:path';import dotenv from '../../apps/api/node_modules/dotenv/lib/main.js';
const arg=n=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3);
if(!arg('local')||!arg('out'))throw Error('Provide --local=<snapshot.json> and --out=<private directory>.');
const local=JSON.parse(fs.readFileSync(arg('local'))).tables,env=dotenv.parse(fs.readFileSync(new URL('../../.env',import.meta.url)));
const ll=new URL((env.LL_BASEURL||'https://localline.ca/api/backoffice/v2/').replace(/\/?$/,'/')),sq=new URL(env.SQUARE_BASE_URL||'https://connect.squareup.com');
if(ll.protocol!=='https:'||!/(^|\.)localline\.ca$/.test(ll.hostname)||sq.origin!=='https://connect.squareup.com')throw Error('Expected known catalog hosts.');
fs.mkdirSync(arg('out'),{recursive:true,mode:0o700});const write=(name,obj)=>fs.writeFileSync(path.join(arg('out'),name),JSON.stringify(obj,null,2),{flag:'wx',mode:0o600});
async function request(url,options={}){
 const target=new URL(url),method=options.method||'GET',auth=target.href===new URL('token/',ll).href&&method==='POST';
 if(![ll.origin,sq.origin].includes(target.origin)||!auth&&method!=='GET')throw Error('Read-only request guard rejected this request.');
 const response=await fetch(target,{...options,redirect:'error',signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error(`${target.pathname}: HTTP ${response.status}`);return response.json();
}
const token=(await request(new URL('token/',ll),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env.LL_USERNAME,password:env.LL_PASSWORD})})).access;
if(!token)throw Error('Authentication failed.');const headers={Authorization:`Bearer ${token}`};
const saleIds=local.products.filter(p=>{const sale=local.product_sales.find(s=>s.product_id===p.id),profile=local.product_pricing_profiles.find(s=>s.product_id===p.id);return Boolean(Number(sale?.on_sale??profile?.on_sale??0));}).map(p=>p.id);
const packageIds=new Set(local.enterprise_bundles.flatMap(b=>JSON.parse(b.input_json).components.map(c=>c.packageId)));
const productIds=new Set([...saleIds,...local.packages.filter(p=>packageIds.has(p.id)).map(p=>p.product_id)]);
const ids=[...productIds].map(id=>{const links=local.local_line_product_meta.filter(m=>m.product_id===id);if(links.length!==1||!links[0].local_line_product_id)throw Error(`Product ${id} needs a mapping.`);return Number(links[0].local_line_product_id);});
const products=[];let next=0;await Promise.all(Array.from({length:3},async()=>{while(next<ids.length){const id=ids[next++];products.push(await request(new URL(`products/${id}/?expand=packages,product_price_list_entries`,ll),{headers}));}}));
const boxes=[];for(const b of local.enterprise_bundles)boxes.push(await request(new URL(`boxes/${b.remote_box_id}/`,ll),{headers}));
const objects=[];let cursor;do{const url=new URL('/v2/catalog/list',sq);if(cursor)url.searchParams.set('cursor',cursor);const response=await request(url,{headers:{Authorization:`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':env.SQUARE_API_VERSION||'2026-08-19'}});objects.push(...response.objects||[]);cursor=response.cursor;}while(cursor);
write('channels.json',{capturedAt:new Date().toISOString(),readOnly:true,saleProductIds:saleIds,products,boxes,square:objects,basketIds:['LL_PRICE_LIST_GUEST_ID','LL_PRICE_LIST_CSA_MEMBERS_ID','LL_PRICE_LIST_HERDSHARE_ID','LL_PRICE_LIST_SNAP_ID'].map(k=>Number(env[k]))});
console.log(JSON.stringify({products:products.length,saleProducts:saleIds.length,boxes:boxes.length,squareObjects:objects.length,remoteWrites:0}));
