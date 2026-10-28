export const PACK_DAY_TEAM_VIEW_TITLE = "auto-pack-day-team";

const REPORTING_START = "2026-01-01";
const BASELINE_START = "2026-02-01";
const PACKING_TASKS = new Set(["packout", "dairy_and_frozen_packing"]);

function addDays(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function weekday(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function mondayOf(ymd) {
  return addDays(ymd, -((weekday(ymd) + 6) % 7));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toYmd(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
}

function workingHours(row) {
  const start = Date.parse(`${String(row.startTime || "").replace(" ", "T")}Z`);
  const end = Date.parse(`${String(row.endTime || "").replace(" ", "T")}Z`);
  const gross = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, (end - start) / 3_600_000)
    : 0;
  const computed = round(Math.max(0, gross - Number(row.breakMinutes || 0) / 60), 2);
  const supplied = Number(row.hours);
  if (row.hours !== null && row.hours !== undefined && Number.isFinite(supplied) && supplied > 0) {
    return computed <= 0 ? round(supplied, 2) : round(Math.min(supplied, computed), 2);
  }
  return computed;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function pacificToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function buildPackDayCycles({ orderRows = [], laborRows = [], throughDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || ""))) {
    throw new Error("Pack day throughDate must be YYYY-MM-DD");
  }
  const weeks = new Map();
  for (let monday = mondayOf(REPORTING_START); monday <= throughDate; monday = addDays(monday, 7)) {
    weeks.set(monday, {
      tuesday: { cycleDate: addDays(monday, 1), type: "Tuesday", orders: 0, packHours: 0, deliveryHours: 0, pickupHours: 0 },
      weekend: { cycleDate: addDays(monday, 5), type: "Friday/Saturday", orders: 0, packHours: 0, deliveryHours: 0, pickupHours: 0 }
    });
  }

  for (const row of orderRows) {
    const day = toYmd(row.fulfillmentDate);
    if (!day || day < REPORTING_START || day > throughDate) continue;
    const week = weeks.get(mondayOf(day));
    if (!week) continue;
    const dayNumber = weekday(day);
    if (dayNumber === 2) week.tuesday.orders += Number(row.orders || 0);
    if (dayNumber === 5 || dayNumber === 6) week.weekend.orders += Number(row.orders || 0);
  }

  for (const row of laborRows) {
    const day = toYmd(row.workDate);
    if (!day || day < REPORTING_START || day > throughDate) continue;
    const week = weeks.get(mondayOf(day));
    if (!week) continue;
    const dayNumber = weekday(day);
    const cycle = dayNumber === 1 || dayNumber === 2
      ? week.tuesday
      : dayNumber >= 4 && dayNumber <= 6
        ? week.weekend
        : null;
    if (!cycle) continue;
    const task = String(row.task || "").trim().toLowerCase();
    const hours = workingHours(row);
    if (PACKING_TASKS.has(task)) cycle.packHours += hours;
    if (task === "delivery") cycle.deliveryHours += hours;
    if (task === "pick_ups") cycle.pickupHours += hours;
  }

  return [...weeks.values()]
    .flatMap((week) => [week.tuesday, week.weekend])
    .filter((cycle) => cycle.cycleDate <= throughDate && cycle.orders > 0)
    .map((cycle) => ({
      ...cycle,
      packHours: round(cycle.packHours, 2),
      deliveryHours: round(cycle.deliveryHours, 2),
      pickupHours: round(cycle.pickupHours, 2)
    }));
}

function twoMonthsBefore(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 3, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

function cycleLabel(ymd) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric"
  }).format(new Date(`${ymd}T00:00:00Z`));
}

function hasCompleteLabor(cycle) {
  return [cycle.packHours, cycle.deliveryHours, cycle.pickupHours]
    .every((hours) => Number.isFinite(hours) && hours > 0);
}

function totalLaborMinutes(cycle) {
  return (cycle.packHours + cycle.deliveryHours + cycle.pickupHours) * 60;
}

export function scorePackDayCycles(cycles, { throughDate } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || ""))) {
    throw new Error("Pack day throughDate must be YYYY-MM-DD");
  }
  const windowStart = twoMonthsBefore(throughDate);
  const eligible = cycles.filter((cycle) =>
    cycle.cycleDate >= BASELINE_START && cycle.cycleDate <= throughDate &&
    cycle.orders > 0 && hasCompleteLabor(cycle)
  );
  const targetMinutesPerOrder = eligible.length
    ? percentile(eligible.map((cycle) =>
      totalLaborMinutes(cycle) / cycle.orders
    ), 0.25)
    : null;
  const allRows = cycles
    .filter((cycle) => cycle.orders > 0 && cycle.cycleDate <= throughDate)
    .sort((a, b) => b.cycleDate.localeCompare(a.cycleDate))
    .map((cycle) => {
      const complete = hasCompleteLabor(cycle);
      return {
        ...cycle,
        label: cycleLabel(cycle.cycleDate),
        complete,
        packMinutesPerOrder: cycle.packHours * 60 / cycle.orders,
        deliveryMinutesPerOrder: cycle.deliveryHours * 60 / cycle.orders,
        pickupMinutesPerOrder: cycle.pickupHours > 0 ? cycle.pickupHours * 60 / cycle.orders : null,
        ordersPerMinute: complete ? cycle.orders / totalLaborMinutes(cycle) : null,
        totalMinutesPerOrder: complete
          ? totalLaborMinutes(cycle) / cycle.orders
          : null
      };
    });
  const rows = allRows.filter((cycle) => cycle.cycleDate >= windowStart).map((cycle) => {
    // Select operating cycles before checking labor completeness: missing timesheets
    // must not silently change the requested 30-day comparison period.
    const previous = allRows.filter((row) => row.cycleDate < cycle.cycleDate).slice(0, 30);
    const orders = previous.reduce((sum, row) => sum + row.orders, 0);
    const complete = previous.length > 0 && previous.every(hasCompleteLabor);
    const averageMinutes = (field) => previous.length > 0 && previous.every((row) => row[field] > 0)
      ? previous.reduce((sum, row) => sum + row[field] * 60, 0) / orders
      : null;
    const year = cycle.cycleDate.slice(0, 4);
    const yearToDate = allRows.filter((row) => row.cycleDate.startsWith(`${year}-`) && row.cycleDate <= cycle.cycleDate);
    return {
      ...cycle,
      dailyOrderAverage: {
        year: Number(year),
        operatingDays: yearToDate.length,
        orders: yearToDate.length ? yearToDate.reduce((sum, row) => sum + row.orders, 0) / yearToDate.length : null
      },
      averages: {
        operatingDays: previous.length,
        startDate: previous.at(-1)?.cycleDate ?? null,
        endDate: previous[0]?.cycleDate ?? null,
        orders: previous.length ? orders / previous.length : null,
        ordersPerMinute: complete ? orders / previous.reduce((sum, row) => sum + totalLaborMinutes(row), 0) : null,
        packMinutesPerOrder: averageMinutes("packHours"),
        deliveryMinutesPerOrder: averageMinutes("deliveryHours"),
        pickupMinutesPerOrder: averageMinutes("pickupHours"),
        totalMinutesPerOrder: complete ? previous.reduce((sum, row) => sum + totalLaborMinutes(row), 0) / orders : null
      }
    };
  });
  return { targetMinutesPerOrder, referenceCycleCount: eligible.length, windowStart, throughDate, rows };
}

export function buildPackDayTeamViewValues(report, { asOfDate }) {
  const { targetMinutesPerOrder, referenceCycleCount, windowStart, rows } = report;
  const values = [
    ["CSA Packing, Delivery & Pickup Efficiency"],
    ["TARGET", targetMinutesPerOrder ?? "", "min/order"],
    [`Top 25% of ${referenceCycleCount} completed delivery cycles since Feb 2026`],
    [`Last two months: ${windowStart} to ${asOfDate} · most recent first`],
    [],
    ["Delivery cycle", "Orders", "Packing min/order", "Delivery min/order", "Pickup min/order", "Total min/order", "vs. Target"]
  ];
  rows.forEach((cycle, index) => {
    const rowNumber = 7 + index;
    values.push([
      cycle.label,
      cycle.orders,
      cycle.packHours > 0 ? cycle.packMinutesPerOrder : "",
      cycle.deliveryHours > 0 ? cycle.deliveryMinutesPerOrder : "",
      cycle.pickupMinutesPerOrder ?? "",
      cycle.complete ? `=SUM(C${rowNumber}:E${rowNumber})` : "",
      cycle.complete && targetMinutesPerOrder !== null
        ? `=IF(ROUND(F${rowNumber}-$B$2,1)>0,TEXT(ROUND(F${rowNumber}-$B$2,1),"0.0")&" min slower",IF(ROUND(F${rowNumber}-$B$2,1)<0,TEXT(ABS(ROUND(F${rowNumber}-$B$2,1)),"0.0")&" min faster","On target"))`
        : "Awaiting timesheets"
    ]);
  });
  values.push(
    [],
    ["Notes:"],
    ["Goal: Match or beat the top 25% most efficient completed delivery cycles."],
    ["vs. Target: Faster means less time per order; slower means more time per order."],
    ["Packing + Delivery + Pickup: Includes all three labor categories, measured in labor minutes per order. Pickup means vendor collections."],
    ["Why it matters: Reducing minutes per order lowers labor costs and improves CSA profitability."],
    ["Figures are rounded; small differences may occur."],
    ["Tuesday uses Monday–Tuesday labor and Tuesday orders. Saturday uses Thursday–Saturday labor and Friday–Saturday orders. Delivery task time can include loading and stops. Recent timesheets may arrive late."]
  );
  return values;
}
