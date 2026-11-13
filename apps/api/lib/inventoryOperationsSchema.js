import { FINANCIAL_TABLES } from './memberFinancialSchema.js';

const table='local_line_inventory_operations';
const columns='id,product_id,user_id,remote_id,request_hash,payload_json,status,receipt_json,created_at,updated_at';

// Readiness never performs DDL. Inventory requires its own receipts, not member billing tables.
export async function assertInventoryOperationsSchema(db) {
  try {await db.query(`SELECT ${columns} FROM ${table} LIMIT 0`);}
  catch(error) {
    if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(error.code))throw error;
    throw Object.assign(new Error('Inventory receipts are not ready. Run migrate:member-finances with --inventory-only --check, then --inventory-only --apply.'),{status:503});
  }
}

export async function inventoryOperationsPreflight(db) {
  const [rows]=await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
  if(!rows.length)return {inventoryOnly:true,table,exists:false,action:'create receipt table'};
  await assertInventoryOperationsSchema(db);
  const [indexes]=await db.query(`SHOW INDEX FROM ${table} WHERE Key_name='PRIMARY'`);
  if(indexes.length!==1||indexes[0].Column_name!=='id')throw new Error('Inventory receipt primary key needs manual review.');
  return {inventoryOnly:true,table,exists:true,action:'none'};
}

export async function migrateInventoryOperationsSchema(db) {
  const [[lock]]=await db.query("SELECT GET_LOCK('csa-store:member-financial-migration',10) AS acquired");
  if(Number(lock.acquired)!==1)throw new Error('Another schema migration is running.');
  try {
    const plan=await inventoryOperationsPreflight(db);
    if(!plan.exists)await db.query(FINANCIAL_TABLES.find(ddl=>ddl.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)));
    return {...await inventoryOperationsPreflight(db),created:!plan.exists};
  }finally{await db.query("SELECT RELEASE_LOCK('csa-store:member-financial-migration')");}
}
