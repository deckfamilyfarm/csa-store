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
