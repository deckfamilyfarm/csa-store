import { pacificToday } from "./packDayEfficiency.js";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export function previousPacificDay(now = new Date()) {
  const today = pacificToday(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function isScheduledPackDayEmailTime(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return ["Wed", "Sun"].includes(parts.weekday) && parts.hour === "10" && parts.minute === "00";
}

function oneDecimal(value) {
  return Number(value).toFixed(1);
}

function cycleLabel(ymd) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric"
  }).format(new Date(`${ymd}T00:00:00Z`));
}

export function buildPackDayEfficiencyEmail(report, cycleDate, { spreadsheetId, sheetId = 1600261017 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cycleDate || ""))) {
    throw new Error("Pack day email cycle date must be YYYY-MM-DD");
  }
  const cycle = report?.scored?.rows?.find((row) => row.cycleDate === cycleDate);
  if (!cycle) throw new Error(`No paid pack-day cycle found for ${cycleDate}; email was not sent.`);
  const target = report.scored.targetMinutesPerOrder;
  const label = cycleLabel(cycleDate);
  const lines = [`${label} · ${cycle.orders} fulfilled orders`, ""];
  if (cycle.complete) {
    lines.push(
      `Packing: ${oneDecimal(cycle.packMinutesPerOrder)} min/order`,
      `Delivery: ${oneDecimal(cycle.deliveryMinutesPerOrder)} min/order`,
      `Total: ${oneDecimal(cycle.totalMinutesPerOrder)} min/order`
    );
  }
  if (cycle.complete && target !== null) {
    const gap = Math.round((cycle.totalMinutesPerOrder - target) * 10) / 10;
    const result = gap > 0
      ? `${oneDecimal(gap)} min slower than target`
      : gap < 0
        ? `${oneDecimal(Math.abs(gap))} min faster than target`
        : "On target";
    lines.push(
      `Target: ${oneDecimal(target)} min/order (top 25% of completed cycles)`,
      `Result: ${result}`
    );
  } else if (cycle.complete) {
    lines.push("Target pending: not enough completed cycles yet.");
  } else {
    lines.push("Efficiency pending: packing or delivery timesheet hours are not complete.");
  }
  if (spreadsheetId) {
    lines.push("", `Two-month view: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`);
  }
  lines.push("", "Timesheet entries may arrive late; delivery task time can include loading and stops.");
  return {
    subject: `CSA pack day efficiency — ${label}`,
    text: lines.join("\n")
  };
}
