// Capture local catalog/pricing state before reconciliation; never opens a remote connection.
import fs from 'node:fs';
import {installLocalEnvironment,assertLocalDatabase,installLoopbackNetworkGuard} from './env.mjs';
installLocalEnvironment();assertLocalDatabase();installLoopbackNetworkGuard();
const {getPool}=await import('../../apps/api/db.js');
const out=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6);
if(!out)throw new Error('Provide --out=<snapshot.json>.');
const pool=getPool();
// Preserve stored UTC DATETIME text without the client machine timezone conversion.
pool.pool.config.connectionConfig.dateStrings=true;
const connection=await pool.getConnection();
try{
 await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
 await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
 const [tables]=await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
 const names=tables.map(t=>t.name).filter(name=>['products','packages','vendors','categories','price_lists','product_pricing_profiles','product_sales','product_images','product_media','square_variation_links','square_match_reviews'].includes(name)||name.startsWith('local_line_')||name.startsWith('square_catalog_')||name.startsWith('enterprise_'));
 const snapshot={database:process.env.STORE_DB_DATABASE,capturedAt:new Date().toISOString(),tables:{}};
 for(const name of names){const [rows]=await connection.query('SELECT * FROM `'+name+'`');snapshot.tables[name]=rows;}
 await connection.query('ROLLBACK');fs.writeFileSync(out,JSON.stringify(snapshot),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({out,database:snapshot.database,tables:names.length,products:snapshot.tables.products.length}));
}finally{connection.release();await pool.end();}
