import fs from 'node:fs';import path from 'node:path';
import {installLocalEnvironment,assertLocalDatabase,installLoopbackNetworkGuard} from './env.mjs';
installLocalEnvironment();assertLocalDatabase();installLoopbackNetworkGuard();
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);if(!out)throw Error('Provide --out=<private file>.');
const {getPool}=await import('../../apps/api/db.js');const pool=getPool();pool.pool.config.connectionConfig.dateStrings=true;const db=await pool.getConnection();
try{
 await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const tables={};
 for(const name of ['products','packages','vendors','product_sales','product_pricing_profiles','local_line_product_meta','local_line_package_meta','square_variation_links','enterprise_bundles','enterprise_pricing_product_state','enterprise_promotions','enterprise_pricing_settings_versions'])tables[name]=(await db.query(`SELECT * FROM \`${name}\``))[0];
 tables.enterprise_pricing_revisions=(await db.query('SELECT r.* FROM enterprise_pricing_revisions r JOIN enterprise_pricing_product_state s ON s.latest_revision_id=r.id'))[0];
 await db.rollback();fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.writeFileSync(out,JSON.stringify({database:process.env.STORE_DB_DATABASE,capturedAt:new Date().toISOString(),tables}),{flag:'wx',mode:0o600});console.log(JSON.stringify({out,products:tables.products.length,bundles:tables.enterprise_bundles.length}));
}finally{db.release();await pool.end();}
