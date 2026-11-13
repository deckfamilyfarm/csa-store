// Keep each HTTP request short enough for the admin reverse proxy.
export const INVENTORY_REFRESH_BATCH_SIZE = 6;

export async function refreshInventoryBatches(ids, fetchBatch, receive, cancelled = () => false) {
  for (let offset = 0; offset < ids.length; offset += INVENTORY_REFRESH_BATCH_SIZE) {
    if (cancelled()) return;
    const batch = ids.slice(offset, offset + INVENTORY_REFRESH_BATCH_SIZE);
    let rows;
    try { rows = (await fetchBatch(batch)).rows; }
    catch (error) { rows = batch.map(productId => ({ productId, error: `FF inventory check failed: ${error.message}` })); }
    if (cancelled()) return;
    receive(rows, Math.min(offset + batch.length, ids.length), ids.length);
  }
}

export function applyInventorySaveToRow(row,result,submitted) {
  if(!result)return row;
  const next={...row};
  if(result.farmStock)Object.assign(next,{stockOnFarm:result.farmStock.stockOnFarm,stockOnFarmLbs:result.farmStock.stockOnFarmLbs,farmStockRevision:result.farmStock.farmStockRevision});
  if(result.currentInventory) {
    const stock=result.currentInventory;
    Object.assign(next,{inventory:stock.inventory,trackInventory:stock.trackInventory,inventoryType:stock.inventoryType || 'product',packageInventory:stock.packages || [],inventorySnapshot:stock,inventoryError:null});
  }
  if(result.savedFields.includes('visible'))next.visible=submitted.values.visible;
  return next;
}

export function trackedInventoryIds(rows,drafts={}) {
  return rows.filter(row=>Boolean(row.trackInventory ?? row.ffTrackInventory) &&
    (drafts[row.productId ?? row.id]?.values.trackInventory ?? true))
    .map(row=>row.productId ?? row.id);
}
