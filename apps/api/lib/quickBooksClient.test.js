import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {QuickBooksClient} from './quickBooksClient.js';
import {withTokenStoreLock,saveRefreshTokenLocked} from './qboTokenStore.js';

test('dashboard clients share rotated credentials and observe reauthorization without copying old tokens',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csa-qbo-client-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'refresh.json');fs.writeFileSync(file,JSON.stringify({company:'shared-current',other:'preserved'}));
 const config={realmId:'company',clientId:'same-app',clientSecret:'test',refreshToken:'obsolete-env',tokenStorePath:file,env:'production'};
 const clients=[new QuickBooksClient(config),new QuickBooksClient(config)];
 const refreshes=[],access=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.includes('/tokens/bearer')){
   const token=new URLSearchParams(options.body).get('refresh_token');refreshes.push(token);
   await new Promise(r=>setTimeout(r,30));
   return new Response(JSON.stringify({access_token:'access-'+token,refresh_token:'next-'+token,expires_in:3600}),{status:200});
  }
  assert.match(url,/\/company\/company\/companyinfo\/company/);access.push(options.headers.Authorization);
  return new Response(JSON.stringify({CompanyInfo:{CompanyName:'Full Farm CSA'}}),{status:200});
 });
 await Promise.all(clients.map(c=>c.fetchCompanyInfo()));
 assert.deepEqual(refreshes,['shared-current']);assert.deepEqual(access,['Bearer access-shared-current','Bearer access-shared-current']);
 await withTokenStoreLock(file,async()=>saveRefreshTokenLocked(file,'company','reauthorized'));
 await clients[0].fetchCompanyInfo();assert.deepEqual(refreshes,['shared-current','reauthorized']);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{company:'next-reauthorized',other:'preserved'});
});
