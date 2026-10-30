// Preview by default. --apply writes only dormant local discount fields and saves
// their original values first. No channel APIs or catalog cache writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool } from '../db.js';
const pool=getPool(), db=await pool.getConnection();
try {
  const [tables]=await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='enterprise_product_sales'");
  const desiredGuard=tables.length ? 'AND NOT EXISTS (SELECT 1 FROM enterprise_product_sales s WHERE s.product_id=p.id AND s.discount_bp>0)' : '';
  await db.beginTransaction();
  const [rows]=await db.query(`SELECT p.id,ps.sale_discount AS productDiscount,pp.sale_discount AS profileDiscount
    FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id
    WHERE COALESCE(ps.on_sale,0)=0 AND COALESCE(pp.on_sale,0)=0
    AND (COALESCE(ps.sale_discount,0)<>0 OR COALESCE(pp.sale_discount,0)<>0)
    ${desiredGuard}
    AND NOT EXISTS (SELECT 1 FROM enterprise_promotions ep JOIN packages k ON k.product_id=p.id
      WHERE ep.status IN ('pending','approved','scheduled','active','partial','cancelling')
      AND JSON_CONTAINS(ep.input_json,CAST(k.id AS CHAR),'$.packageIds')) FOR UPDATE`);
  const apply=process.argv.includes('--apply');
  console.log(JSON.stringify({mode:apply?'apply':'preview',products:rows},null,2));
  if(apply&&rows.length) {
    const folder=path.resolve('.local-pricing/sale-cleanup');await fs.mkdir(folder,{recursive:true,mode:0o700});
    const file=path.join(folder,`${Date.now()}-before.json`);
    await fs.writeFile(file,JSON.stringify({database:process.env.STORE_DB_DATABASE,rows},null,2),{mode:0o600});
    for(const row of rows) {
      await db.query('UPDATE product_sales SET sale_discount=0 WHERE product_id=? AND on_sale=0',[row.id]);
      await db.query('UPDATE product_pricing_profiles SET sale_discount=0 WHERE product_id=? AND on_sale=0',[row.id]);
    }
    await db.commit();console.log(`Saved rollback values: ${file}`);
  } else await db.rollback();
} catch(e) {await db.rollback();throw e;} finally {db.release();await pool.end();}
