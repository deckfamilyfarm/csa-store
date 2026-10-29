// Scheduled legacy importers must not overwrite the pricing manager's catalog.
// Explicit incoming Product Sync reviews remain available for supported repairs.
export async function catalogIsLocallyManaged(connection) {
  const [tables]=await connection.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('enterprise_pricing_product_state','enterprise_pricing_cutovers')");
  if(tables.some(t=>t.name==='enterprise_pricing_cutovers')){
    const [[row]]=await connection.query("SELECT COUNT(*) AS total FROM enterprise_pricing_cutovers WHERE status='applied'");
    if(Number(row.total))return true;
  }
  if(tables.some(t=>t.name==='enterprise_pricing_product_state')){
    const [[row]]=await connection.query('SELECT COUNT(*) AS total FROM enterprise_pricing_product_state WHERE active_revision_id IS NOT NULL');
    if(Number(row.total))return true;
  }
  return false;
}
