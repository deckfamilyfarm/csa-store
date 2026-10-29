// Read-only deployment check. Does not import application bootstraps or API clients.
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
const db=await mysql.createConnection({host:process.env.STORE_DB_HOST,port:Number(process.env.STORE_DB_PORT||3306),user:process.env.STORE_DB_USER,password:process.env.STORE_DB_PASSWORD,database:process.env.STORE_DB_DATABASE,dateStrings:true,multipleStatements:false});
try{
 await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
 const [users]=await db.query("SELECT u.id,u.username,u.active,u.timesheets_user_id AS timesheetsUserId,GROUP_CONCAT(r.role_key ORDER BY r.role_key) AS roles FROM users u LEFT JOIN admin_user_roles ur ON ur.user_id=u.id LEFT JOIN admin_roles r ON r.id=ur.role_id GROUP BY u.id");
 const [legacy]=await db.query("SELECT b.id,b.status,COUNT(i.id) AS unfinishedItems FROM pricelist_change_batches b JOIN pricelist_change_items i ON i.batch_id=b.id WHERE b.status IN ('scheduled','running','partial','failed') AND i.status IN ('pending','local_applied','failed') GROUP BY b.id,b.status");
 const [releases]=await db.query("SELECT id,status FROM product_sync_releases WHERE status IN ('queued','scheduled','running','partial','held','failed')");
 const [tables]=await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
 const [[vendorless]]=await db.query("SELECT COUNT(*) AS total FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id WHERE COALESCE(p.is_deleted,0)=0 AND (v.id IS NULL OR TRIM(v.name)='')");
 const report={checkedAt:new Date().toISOString(),database:process.env.STORE_DB_DATABASE,readOnly:true,users:users.filter(u=>u.roles),legacyReleases:legacy,productReleases:releases,vendorlessProducts:Number(vendorless.total),
  configuration:{localIsolation:process.env.CSA_LOCAL_ONLY==='true',timesheetsConfigured:!!process.env.TIMESHEETS_API_URL,localLineConfigured:!!(process.env.LL_USERNAME&&process.env.LL_PASSWORD),squareConfigured:!!process.env.SQUARE_ACCESS_TOKEN,bundlePilotEnabled:process.env.LL_BUNDLE_PUBLICATION_ENABLED==='true',squarePOSVerified:process.env.SQUARE_PROMOTION_POS_VERIFIED==='true'},
  enterpriseSchemaPresent:tables.some(t=>t.name==='enterprise_pricing_product_state'),developmentAccountPresent:users.some(u=>u.username==='local.admin'),
  note:'This checks the supplied environment and database. Run on the deployed server to verify its environment; inspect PM2/systemd and crontab separately.'};
 await db.rollback();if(out)await fs.writeFile(out,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await db.end();}
