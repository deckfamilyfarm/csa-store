export const INVENTORY_READ_ONLY_MESSAGE = 'Full Farm quantities must be changed through the reviewed Inventory save workflow with a fresh Local Line baseline. Legacy and Product Sync quantity publication remains blocked.';
export function assertNoUnsafeLocalLineStock(payload) {
  if (['set_inventory','inventory'].some(key => payload[key] !== undefined) ||
      payload.packages?.some(pkg => ['set_inventory','inventory','current_inventory'].some(key => pkg[key] !== undefined))) {
    throw Object.assign(new Error(INVENTORY_READ_ONLY_MESSAGE), {status:409,hold:true,code:'LOCAL_LINE_STOCK_READ_ONLY'});
  }
}
