import dotenv from 'dotenv';
if(process.env.CSA_LOCAL_ONLY!=='true')dotenv.config({path:new URL('../../../.env',import.meta.url).pathname,quiet:true});
const {getPool}=await import('../db.js');
const {getMerchandiseService}=await import('../lib/merchandiseRuntime.js');
try {console.log(JSON.stringify(await getMerchandiseService().maintenance()));}
finally {await getPool().end();}
