export const INVENTORY_READ_ONLY_MESSAGE = 'Full Farm quantity changes are paused because Local Line has no verified atomic stock-update capability. Change quantities in Local Line, then refresh here. On-farm inventory, visibility, and tracking remain separate.';
export function assertNoUnsafeLocalLineStock(payload) {
  if (['set_inventory','inventory'].some(key => payload[key] !== undefined) ||
      payload.packages?.some(pkg => ['set_inventory','inventory','current_inventory'].some(key => pkg[key] !== undefined))) {
    throw Object.assign(new Error(INVENTORY_READ_ONLY_MESSAGE), {status:409,hold:true,code:'LOCAL_LINE_STOCK_READ_ONLY'});
  }
}
