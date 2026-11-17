// Explicit, additive migration for operational order snapshots. Never run DDL
// from an order read/pull, and never truncate the provider's saved evidence.
const tables = ['local_line_orders', 'local_line_order_entries'];
export async function orderSnapshotPreflight(db) {
  const [columns] = await db.query(`SELECT TABLE_NAME tableName,DATA_TYPE dataType,
    IS_NULLABLE nullable,CHARACTER_SET_NAME charsetName,COLLATION_NAME collationName
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME IN (?) AND COLUMN_NAME='raw_json'`, [tables]);
  return { orderSnapshotsOnly: true, columns: tables.map(table => {
    const column = columns.find(c => c.tableName === table);
    if (!column || !['text','mediumtext','longtext'].includes(column.dataType)) throw new Error(`Review ${table}.raw_json before migrating.`);
    return { ...column, action: column.dataType === 'longtext' ? 'none' : 'widen to LONGTEXT' };
  }) };
}
export async function migrateOrderSnapshotSchema(db) {
  const [[lock]] = await db.query("SELECT GET_LOCK('csa-store:localline-automation',10) acquired");
  if (Number(lock.acquired) !== 1) throw new Error('Wait for the current Local Line automation to finish.');
  try {
    const plan = await orderSnapshotPreflight(db);
    for (const c of plan.columns.filter(c => c.action !== 'none')) {
      if (![c.charsetName,c.collationName].every(v => /^[a-zA-Z0-9_]+$/.test(v))) throw new Error('Unexpected snapshot character set.');
      await db.query(`ALTER TABLE \`${c.tableName}\` MODIFY COLUMN raw_json LONGTEXT
        CHARACTER SET ${c.charsetName} COLLATE ${c.collationName} ${c.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    }
    return { ...await orderSnapshotPreflight(db), widened: plan.columns.filter(c => c.action !== 'none').map(c => c.tableName) };
  } finally { await db.query("SELECT RELEASE_LOCK('csa-store:localline-automation')"); }
}
