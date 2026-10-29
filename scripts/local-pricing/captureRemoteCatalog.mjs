// Standalone remote reader. No application bootstrap, database writes, or publication clients.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from '../../apps/api/node_modules/dotenv/lib/main.js';
import * as xlsx from '../../apps/api/node_modules/xlsx/xlsx.mjs';

const env=dotenv.parse(fs.readFileSync(new URL('../../.env',import.meta.url)));
const out=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6);
if(!out)throw new Error('Provide --out=<private snapshot directory>.');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const ll=new URL((env.LL_BASEURL||'https://localline.ca/api/backoffice/v2/').replace(/\/?$/,'/'));
const square=new URL(env.SQUARE_BASE_URL||'https://connect.squareup.com');
if(ll.protocol!=='https:' || !/(^|\.)localline\.ca$/.test(ll.hostname) || square.origin!=='https://connect.squareup.com')throw new Error('Expected the known production catalog hosts.');
const manifest={startedAt:new Date().toISOString(),complete:false,readOnly:true,requests:0,products:0,errors:[]};
const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2),{mode:0o600});
async function request(url,options={}){
  const target=new URL(url),method=options.method||'GET';
  const auth=target.origin===ll.origin && target.pathname===new URL('token/',ll).pathname && method==='POST';
  if(![ll.origin,square.origin].includes(target.origin)||(!auth&&method!=='GET'))throw new Error('Read-only request guard rejected the request.');
  for(let attempt=0;attempt<4;attempt++){
    manifest.requests++;
    const response=await fetch(target,{...options,redirect:'error',signal:AbortSignal.timeout(45000)});
    if((response.status===429||response.status>=500)&&attempt<3){await new Promise(resolve=>setTimeout(resolve,Math.min(10000,1000*2**attempt)));continue;}
    if(!response.ok){const detail=(await response.text()).slice(0,500);throw new Error(`${target.hostname}${target.pathname}: HTTP ${response.status} ${detail}`);}
    return response;
  }
}
try{
  const auth=await(await request(new URL('token/',ll),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env.LL_USERNAME,password:env.LL_PASSWORD})})).json();
  const token=auth.access||auth.token;if(typeof token!=='string')throw new Error('Local Line authentication did not return a token.');
  const llHeaders={Authorization:`Bearer ${token}`};
  async function pages(url,headers){const values=[];const seen=new Set();while(url){if(seen.has(String(url)))throw new Error('Repeated pagination URL');seen.add(String(url));const data=await(await request(url,{headers})).json();values.push(...(Array.isArray(data)?data:data.results||[]));url=Array.isArray(data)?null:data.next?new URL(data.next,url):null;}return values;}
  if(process.argv.includes('--boxes')){
    const boxes=await pages(new URL('boxes/?page_size=100',ll),llHeaders);
    write('localline-boxes.json',boxes);console.log(JSON.stringify({boxes:boxes.length,fields:Object.keys(boxes[0]||{})}));process.exit(0);
  }
  if(process.argv.includes('--categories')){
    const products=JSON.parse(fs.readFileSync(path.join(out,'localline-products.json')));
    const ids=[...new Set(products.flatMap(p=>p.packages||[]).flatMap(p=>p.price_list_entries||[]).filter(e=>e.price_list_name==='Guest Basket').map(e=>e.price_list_id))];
    if(ids.length!==1)throw new Error('Guest Basket mapping is ambiguous.');
    const categories=await pages(new URL(`price-lists/${ids[0]}/categories/?page_size=100`,ll),llHeaders);
    for(const category of categories)category.products=await pages(new URL(`price-lists/${ids[0]}/categories/${category.id}/products/?page_size=100`,ll),llHeaders);
    write('localline-categories.json',{priceListId:ids[0],categories,capturedAt:new Date().toISOString()});
    console.log(JSON.stringify({categories:categories.length,associations:categories.reduce((sum,c)=>sum+c.products.length,0)}));process.exit(0);
  }
  if(process.argv.includes('--inspect-box-api')){
    const schema=await(await request(new URL('/swagger/backoffice/v2?format=openapi',ll))).json();
    const paths=Object.fromEntries(Object.entries(schema.paths||{}).filter(([name])=>/box|categor/i.test(name)));
    write('box-endpoints.json',paths);console.log(Object.keys(paths).join('\n'));process.exit(0);
  }
  if(process.argv.includes('--retry-failed')){
    const previous=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
    const products=JSON.parse(fs.readFileSync(path.join(out,'localline-products.json')));
    const errors=[];
    for(const failure of previous.errors){
      if(!failure.productId){errors.push(failure);continue;}
      try{const box=String(failure.error).includes('product_is_box');const body=await(await request(new URL(`${box?'boxes':'products'}/${failure.productId}/?expand=packages,product_price_list_entries`,ll),{headers:llHeaders})).json();products.push(body);}
      catch(error){errors.push({productId:failure.productId,error:error.message});}
    }
    write('localline-products.json',products);write('manifest.json',{...previous,products:products.length,errors,complete:!errors.length,retriedAt:new Date().toISOString()});
    console.log(JSON.stringify({products:products.length,remainingErrors:errors.length}));process.exitCode=errors.length?1:0;
  }else{
  const bytes=Buffer.from(await(await request(new URL('products/export/?direct=true',ll),{headers:llHeaders})).arrayBuffer());
  fs.writeFileSync(path.join(out,'localline-export.xlsx'),bytes,{mode:0o600});
  const book=xlsx.read(bytes,{type:'buffer'});
  const availability=xlsx.utils.sheet_to_json(book.Sheets.Availability);
  const packages=xlsx.utils.sheet_to_json(book.Sheets['Packages and pricing']);
  write('localline-export.json',{availability,packages});
  write('localline-vendors.json',await pages(new URL('vendors/',ll),llHeaders));
  const squareHeaders={Authorization:`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':env.SQUARE_API_VERSION||'2026-08-19'};
  const objects=[];let cursor;
  do{const url=new URL('/v2/catalog/list',square);if(cursor)url.searchParams.set('cursor',cursor);const data=await(await request(url,{headers:squareHeaders})).json();objects.push(...(data.objects||[]));cursor=data.cursor;}while(cursor);
  write('square-catalog.json',{capturedAt:new Date().toISOString(),objects});
  write('square-locations.json',await(await request(new URL('/v2/locations',square),{headers:squareHeaders})).json());
  console.log(`Captured export and ${objects.length} Square catalog objects; fetching Local Line details.`);
  const ids=[...new Set(availability.map(row=>Number(row['Local Line Product ID'])).filter(Number.isSafeInteger))];
  const products=[];let next=0,done=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(next<ids.length){const id=ids[next++];try{const body=await(await request(new URL(`products/${id}/?expand=packages,product_price_list_entries`,ll),{headers:llHeaders})).json();products.push(body);}
      catch(error){manifest.errors.push({productId:id,error:error.message});}
      done++;if(done%100===0){write('localline-products.json',products);console.log(`Local Line details: ${done}/${ids.length}`);}
    }
  }));
  write('localline-products.json',products);manifest.products=products.length;manifest.expectedProducts=ids.length;manifest.squareObjects=objects.length;
  manifest.complete=manifest.errors.length===0;manifest.finishedAt=new Date().toISOString();write('manifest.json',manifest);
  console.log(JSON.stringify({complete:manifest.complete,products:products.length,squareObjects:objects.length,errors:manifest.errors.length,out}));
  if(!manifest.complete)process.exitCode=1;
  }
}catch(error){manifest.errors.push({error:error.message});write('manifest.json',manifest);console.error(error.message);process.exitCode=1;}
