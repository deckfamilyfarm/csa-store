import {installLocalEnvironment,assertLocalDatabase,installLoopbackNetworkGuard} from './env.mjs';
installLocalEnvironment();assertLocalDatabase();installLoopbackNetworkGuard();
const action=process.argv[2];
if(action==='migrate')await import('../../apps/api/scripts/migrateMerchandise.js');
else if(action==='import')await import('../../apps/api/scripts/importMerchandise.js');
else if(action==='review')await import('./merchandiseReview.mjs');
else if(action==='vendors') {
  const {getPool}=await import('../../apps/api/db.js'),pool=getPool();
  try {const [rows]=await pool.query('SELECT id,name FROM vendors WHERE LOWER(TRIM(name))=?',['deck family farm']);console.log(JSON.stringify(rows));}
  finally{await pool.end();}
}
else throw new Error('Use migrate --check / --apply, vendors, import --snapshot=... --vendor-id=ID [--apply], or review.');
