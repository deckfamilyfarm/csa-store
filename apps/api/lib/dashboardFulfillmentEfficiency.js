export const FULFILLMENT_EFFICIENCY_LABEL = "Pack / Delivery / Pickup (min/order)";
export const FULFILLMENT_EFFICIENCY_NOTE = "Combined labor minutes for Packout, Dairy and Frozen Packing, Delivery, and Pick Ups divided by Num Orders for the same Monday–Sunday week. Uses labor time after breaks, not wage costs or elapsed route time. Weeks without recorded packing, delivery, or pickup labor stay blank. Total and quarter values divide summed labor minutes by summed orders for eligible completed weeks only; they are not averages of weekly ratios. Late timesheets are included on the next Dashboard refresh.";

export function getFulfillmentLaborMinutes(taskHours = {}) {
  const packing = Number(taskHours.packout || 0) + Number(taskHours.dairy_and_frozen_packing || 0);
  const delivery = Number(taskHours.delivery || 0);
  const pickup = Number(taskHours.pick_ups || 0);
  if (![packing, delivery, pickup].every((hours) => Number.isFinite(hours) && hours > 0)) return null;
  return Math.round((packing + delivery + pickup) * 6000) / 100;
}

export function buildFulfillmentEfficiencyFormula(observations = []) {
  const eligible = observations.filter(({ minutes, orders }) =>
    Number.isFinite(minutes) && minutes > 0 && Number.isFinite(orders) && orders > 0
  );
  if (!eligible.length) return "";
  const cells = eligible.map(({ orderCell }) => {
    if (!/^[A-Z]+[1-9]\d*$/.test(orderCell || "")) throw new Error("Invalid Dashboard order cell");
    return orderCell;
  }).join(",");
  const minutes = Math.round(eligible.reduce((sum, row) => sum + row.minutes, 0) * 100) / 100;
  return `=IF(OR(COUNT(${cells})<>${eligible.length},MIN(${cells})<=0),"",${minutes}/SUM(${cells}))`;
}
