// Shared local farm-count rules. Selling units and Full Farm stock are unrelated.
export const FARM_INVENTORY_FIELDS = ["stockOnFarm", "stockOnFarmLbs"];

export function farmPounds(value) {
  if (value === null || value === "") return null;
  if (!["number", "string"].includes(typeof value) || !/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(String(value))) {
    throw new Error("On-farm inventory must be nonnegative pounds with up to three decimal places.");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number > 9999999.999) throw new Error("On-farm inventory must be between 0 and 9,999,999.999 lbs.");
  return number;
}

export function farmInventorySnapshot(product) {
  return {
    stockOnFarm: product.stockOnFarm == null ? null : Boolean(Number(product.stockOnFarm)),
    stockOnFarmLbs: product.stockOnFarmLbs == null ? null : Number(product.stockOnFarmLbs),
    farmStockRevision: Number(product.farmStockRevision || 0),
  };
}

export function resolveFarmInventory(current, changes) {
  let { stockOnFarm, stockOnFarmLbs } = farmInventorySnapshot(current);
  if (Object.hasOwn(changes, "stockOnFarm")) {
    stockOnFarm = changes.stockOnFarm;
    if (stockOnFarm === false) stockOnFarmLbs = 0;
    else if (stockOnFarm === true && stockOnFarmLbs === 0) stockOnFarmLbs = null;
  }
  if (Object.hasOwn(changes, "stockOnFarmLbs")) {
    stockOnFarmLbs = farmPounds(changes.stockOnFarmLbs);
    if (stockOnFarmLbs !== null) {
      const status = stockOnFarmLbs > 0;
      if (Object.hasOwn(changes, "stockOnFarm") && changes.stockOnFarm !== status) {
        throw new Error("On-farm pounds and availability must agree.");
      }
      stockOnFarm = status;
    }
  }
  return { stockOnFarm, stockOnFarmLbs };
}
