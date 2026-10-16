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
  const targetText = target === null
    ? "Pending: not enough completed cycles yet"
    : `${oneDecimal(target)} min/order (top 25% of completed cycles)`;
  let resultText = "Pending timesheets";
  let resultStyle = "pending";
  if (cycle.complete && target !== null) {
    const gap = Math.round((cycle.totalMinutesPerOrder - target) * 10) / 10;
    resultText = gap > 0
      ? `${oneDecimal(gap)} min slower than target`
      : gap < 0
        ? `${oneDecimal(Math.abs(gap))} min faster than target`
        : "On target";
    resultStyle = gap > 0 ? "slow" : "good";
  } else if (cycle.complete) {
    resultText = "Pending target";
  }
  const detailLines = cycle.complete
    ? [
      `Packing: ${oneDecimal(cycle.packMinutesPerOrder)} min/order`,
      `Delivery: ${oneDecimal(cycle.deliveryMinutesPerOrder)} min/order`,
      `Total: ${oneDecimal(cycle.totalMinutesPerOrder)} min/order`
    ]
    : ["Efficiency pending: packing or delivery timesheet hours are not complete."];
  const lines = [
    label,
    `${cycle.orders} fulfilled orders`,
    `Target: ${targetText}`,
    `Result: ${resultText}`,
    "",
    ...detailLines
  ];
  const viewUrl = spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${encodeURIComponent(sheetId)}`
    : "";
  if (spreadsheetId) {
    lines.push("", `Two-month view: ${viewUrl}`);
  }
  const caveat = "Timesheet entries may arrive late; delivery task time can include loading and stops.";
  lines.push("", caveat);
  const resultColors = {
    good: { background: "#DCFCE7", foreground: "#166534" },
    slow: { background: "#FEE2E2", foreground: "#991B1B" },
    pending: { background: "#F3F4F6", foreground: "#374151" }
  }[resultStyle];
  const html = [
    '<div style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.5;max-width:560px">',
    `<p style="margin:0 0 12px"><strong style="font-size:18px">${escapeHtml(label)}</strong><br>${escapeHtml(cycle.orders)} fulfilled orders</p>`,
    '<table role="presentation" style="border-collapse:collapse;margin:0 0 16px">',
    `<tr><td style="padding:3px 12px 3px 0">Target</td><td style="padding:3px 0"><strong>${escapeHtml(targetText)}</strong></td></tr>`,
    `<tr><td style="padding:3px 12px 3px 0">Result</td><td bgcolor="${resultColors.background}" style="padding:4px 8px;background-color:${resultColors.background};color:${resultColors.foreground};font-weight:bold">${escapeHtml(resultText)}</td></tr>`,
    "</table>",
    `<p style="margin:0 0 16px">${detailLines.map(escapeHtml).join("<br>")}</p>`,
    ...(viewUrl ? [`<p style="margin:0 0 16px"><a href="${escapeHtml(viewUrl)}">View the last two months</a></p>`] : []),
    `<p style="color:#6B7280;font-size:12px;margin:0">${escapeHtml(caveat)}</p>`,
    "</div>"
  ].join("");
  return {
    subject: `CSA pack day efficiency — ${label}`,
    text: lines.join("\n"),
    html
  };
}
