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

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "Pending";
}

function cycleLabel(ymd) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric"
  }).format(new Date(`${ymd}T00:00:00Z`));
}

function fullCycleLabel(ymd) {
  const day = Number(ymd.slice(8, 10));
  const suffix = day % 100 >= 11 && day % 100 <= 13
    ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long"
  }).formatToParts(new Date(`${ymd}T00:00:00Z`)).map(({ type, value }) => [type, value]));
  return `${parts.weekday} ${parts.month} ${day}${suffix}`;
}

function monthDay(ymd) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric"
  }).format(new Date(`${ymd}T00:00:00Z`));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPackDayEfficiencyEmail(report, cycleDate, { spreadsheetId, sheetId = 1600261017 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cycleDate || ""))) {
    throw new Error("Pack day email cycle date must be YYYY-MM-DD");
  }
  const cycle = report?.scored?.rows?.find((row) => row.cycleDate === cycleDate);
  if (!cycle) throw new Error(`No paid pack-day cycle found for ${cycleDate}; email was not sent.`);
  const target = report.scored.targetMinutesPerOrder;
  const label = cycleLabel(cycleDate);
  const title = `DAILY ORDER REPORT · ${label}`;
  const averages = cycle.averages || {};
  const dailyOrderAverage = cycle.dailyOrderAverage || {};
  let resultText = "Time per order pending: packing, delivery, or pickup timesheets are missing.";
  let resultStyle = "pending";
  if (cycle.complete && Number.isFinite(target)) {
    const gap = Math.round((cycle.totalMinutesPerOrder - target) * 10) / 10;
    resultText = gap > 0
      ? `${formatNumber(gap)} min/order slower than target`
      : gap < 0
        ? `${formatNumber(Math.abs(gap))} min/order faster than target`
        : "On target";
    resultStyle = gap > 0 ? "slow" : "good";
  } else if (cycle.complete) {
    resultText = "Pending target: not enough completed cycles yet.";
  }
  const orders = [
    `${cycle.orders} fulfilled on ${fullCycleLabel(cycleDate)}.`,
    `Daily Average: ${formatNumber(dailyOrderAverage.orders)} orders (based on all ${cycleDate.slice(0, 4)} pack-day data through ${monthDay(cycleDate)})`
  ];
  const time = [
    ["Packing", cycle.packMinutesPerOrder > 0 ? cycle.packMinutesPerOrder : null, averages.packMinutesPerOrder],
    ["Delivery", cycle.deliveryMinutesPerOrder > 0 ? cycle.deliveryMinutesPerOrder : null, averages.deliveryMinutesPerOrder],
    ["Pickup", cycle.pickupMinutesPerOrder, averages.pickupMinutesPerOrder],
    ["Total", cycle.complete ? cycle.totalMinutesPerOrder : null, averages.totalMinutesPerOrder]
  ].map(([name, actual, average]) => `${name}: ${formatNumber(actual)} min/order · Average: ${formatNumber(average)} min/order`);
  const period = averages.startDate && averages.endDate
    ? ` (${monthDay(averages.startDate)}–${monthDay(averages.endDate)})` : "";
  const footer = [
    averages.operatingDays === 30
      ? `Time averages: previous 30 operating days${period}.`
      : averages.operatingDays > 0
        ? `Time averages: previous ${averages.operatingDays} operating days available${period} (up to 30).`
        : "Time averages: pending operating-day history.",
    "Each time average is the total labor minutes for that category divided by fulfilled orders over the same period.",
    "All times reflect labor minutes."
  ];
  const viewUrl = spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${encodeURIComponent(sheetId)}`
    : "";
  const notes = "Pickup means vendor collections. An operating day is a Tuesday or combined Friday/Saturday delivery cycle. " +
    "Target: top 25% of completed cycles since February 2026, including pickup. " +
    "Timesheet entries may arrive late.";
  const targetLine = `Target: ${formatNumber(target)} min/order`;
  const lines = [title, "", "ORDERS", ...orders,
    "", "TIME PER ORDER", ...time, "", targetLine, resultText, "", ...footer,
    ...(viewUrl ? ["", `Two-month view: ${viewUrl}`] : []), "", notes];
  const resultColors = {
    good: { background: "#DCFCE7", foreground: "#166534" },
    slow: { background: "#FEE2E2", foreground: "#991B1B" },
    pending: { background: "#F3F4F6", foreground: "#374151" }
  }[resultStyle];
  const section = (heading, body) =>
    `<p style="margin:0 0 18px"><strong style="font-size:12px;letter-spacing:1px">${heading}</strong><br>${body.map(escapeHtml).join("<br>")}</p>`;
  const html = [
    '<div style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;max-width:560px">',
    `<p style="margin:0 0 22px;font-weight:bold;font-size:18px">${escapeHtml(title)}</p>`,
    section("ORDERS", orders),
    section("TIME PER ORDER", time),
    `<p style="margin:0 0 8px">${escapeHtml(targetLine)}</p>`,
    `<p style="margin:0 0 20px;padding:8px 12px;background-color:${resultColors.background};color:${resultColors.foreground};font-weight:bold">${escapeHtml(resultText)}</p>`,
    `<p style="color:#6B7280;font-size:12px;margin:0 0 16px">${footer.map(escapeHtml).join("<br>")}</p>`,
    ...(viewUrl ? [`<p style="margin:0 0 16px"><a href="${escapeHtml(viewUrl)}">View the last two months</a></p>`] : []),
    `<p style="color:#6B7280;font-size:12px;margin:0">${escapeHtml(notes)}</p>`,
    "</div>"
  ].join("");
  return { subject: `CSA pack day efficiency — ${label}`, text: lines.join("\n"), html };
}
