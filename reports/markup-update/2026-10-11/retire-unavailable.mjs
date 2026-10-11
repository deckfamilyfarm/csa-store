import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getPool } from '../../../apps/api/db.js';
import { getLocalLineAccessToken, getLocalLineBaseUrl } from '../../../apps/api/localLineAuth.js';

const directory = new URL('./retirement/', import.meta.url), pool = getPool();
const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
const save = async (name, value) => writeFile(new URL(name, directory), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const tables = ['products','vendors','packages','product_pricing_profiles','product_sales','local_line_product_meta','local_line_package_meta','local_line_price_list_entries','product_price_list_memberships','package_price_list_memberships','product_images','product_tags','product_media'];
async function snapshot(connection = pool) {
  const result = {};
  for (const table of tables) [result[table]] = await connection.query(`SELECT * FROM ${table}`);
  return JSON.parse(JSON.stringify(result));
}
async function confirmMissing(plan) {
  const token = await getLocalLineAccessToken();
  let next = 0;
  const results = await Promise.allSettled(Array.from({length:4},async()=>{
    while (next < plan.length) {
      const row = plan[next++];
      const response = await fetch(new URL(`products/${row.remoteId}/?expand=packages`,getLocalLineBaseUrl()),{method:'GET',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
      await response.text();
      assert.equal(response.status,404,`Product ${row.id} is no longer confirmed unavailable; review before retirement (HTTP ${response.status})`);
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
async function preview() {
  await mkdir(directory,{recursive:true});
  const report=JSON.parse(await readFile(new URL('./discrepancies.json',import.meta.url),'utf8'));
  const rows=report.rows.filter(row=>row.issues.includes('Remote product unavailable'));
  assert.equal(rows.length,24);
  const before=await snapshot();
  const plan=rows.map(row=>{
    const product=before.products.find(p=>p.id===row.productId);
    const meta=before.local_line_product_meta.find(p=>p.product_id===row.productId);
    assert.ok(product && !product.is_deleted);
    assert.equal(Number(meta?.local_line_product_id)||product.id,Number(row.remoteId));
    assert.notEqual(product.id,1011876);
    assert.ok(!/deck|hyland|creamy cow|deposit/i.test(`${product.name} ${before.vendors.find(v=>v.id===product.vendor_id)?.name||''}`));
    return {id:product.id,name:product.name,remoteId:row.remoteId,isDeletedBefore:product.is_deleted,visibleBefore:product.visible,isDeletedAfter:1,visibleAfter:0};
  });
  await confirmMissing(plan);
  await save('before.json',before);await save('plan.json',{createdAt:new Date().toISOString(),reason:'User requested local retirement of the 24 missing/unavailable Local Line products while retaining searchable database records.',changes:plan});
  console.log(JSON.stringify({products:plan.length,remoteStillUnavailable:true,fields:['is_deleted','visible','updated_at'],physicalDeletes:0,remoteWrites:0,names:plan.map(p=>p.name)},null,2));
}
async function apply() {
  const before=await read('before.json'),plan=(await read('plan.json')).changes;
  assert.equal(plan.length,24);
  await confirmMissing(plan);
  const connection=await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT * FROM products WHERE id IN (?) FOR UPDATE',[plan.map(p=>p.id)]);
    const current=await snapshot(connection);
    for(const row of plan)assert.deepEqual(current.products.find(p=>p.id===row.id),before.products.find(p=>p.id===row.id),'Product changed after retirement preview');
    await save('apply-baseline.json',current);
    for(const row of plan){
      const [result]=await connection.query('UPDATE products SET is_deleted=1,visible=0,updated_at=UTC_TIMESTAMP() WHERE id=? AND is_deleted <=> ? AND visible <=> ?',[row.id,row.isDeletedBefore,row.visibleBefore]);
      assert.equal(result.affectedRows,1);
    }
    const after=await snapshot(connection),retired=new Set(plan.map(p=>p.id));
    assert.equal(after.products.length,current.products.length,'Product rows must be retained');
    const omit=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['is_deleted','visible','updated_at'].includes(key)));
    for(const product of current.products){
      const result=after.products.find(p=>p.id===product.id);
      if(retired.has(product.id)){assert.equal(result.is_deleted,1);assert.equal(result.visible,0);assert.deepEqual(omit(result),omit(product));}
      else assert.deepEqual(result,product);
    }
    for(const table of tables.filter(t=>t!=='products'))assert.deepEqual(after[table],current[table],`${table} must be retained unchanged`);
    await connection.commit();
    await save('after.json',after);
    const [readback]=await pool.query('SELECT id,name,is_deleted,visible FROM products WHERE id IN (?) ORDER BY id',[plan.map(p=>p.id)]);
    assert.equal(readback.length,24);assert.ok(readback.every(p=>p.is_deleted===1&&p.visible===0));
    const receipt={completedAt:new Date().toISOString(),productsSoftRetired:24,productRowsRetained:24,relatedTablesUnchanged:true,physicalDeletes:0,remoteWrites:0,readback};
    await save('receipt.json',receipt);console.log(JSON.stringify(receipt,null,2));
  } catch(error){await connection.rollback();throw error;}finally{connection.release();}
}
try {
  if(process.argv[2]==='preview')await preview();
  else if(process.argv[2]==='apply')await apply();
  else throw new Error('Expected preview or apply');
}finally{await pool.end();}
