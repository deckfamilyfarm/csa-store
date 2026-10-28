import { createHash } from "node:crypto";
import { getPool } from "../db.js";
import { DASHBOARD_SHEET_ID, buildPackDayTeamViewReport } from "../lib/dashboardPublisher.js";
import { sendOperationalEmail } from "../lib/email.js";
import {
  buildPackDayEfficiencyEmail,
  isScheduledPackDayEmailTime,
  previousPacificDay
} from "../lib/packDayEfficiencyEmail.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const scheduled = args.includes("--scheduled");
const sample = args.includes("--sample");
const dateArgs = args.filter((arg) => arg.startsWith("--cycle-date="));
const invalid = args.filter((arg) =>
  !["--dry-run", "--scheduled", "--sample"].includes(arg) && !arg.startsWith("--cycle-date=")
);
if (invalid.length || dateArgs.length > 1 || (scheduled && (dateArgs.length || sample))) {
  throw new Error("Usage: emailPackDayEfficiency.js [--scheduled | --sample] [--dry-run] [--cycle-date=YYYY-MM-DD]");
}

const now = new Date();
if (scheduled && !isScheduledPackDayEmailTime(now)) {
  console.log("Pack day email skipped: scheduled sends run Wednesday and Sunday at 10:00 AM Pacific.");
} else {
  const cycleDate = dateArgs.length ? dateArgs[0].slice("--cycle-date=".length) : previousPacificDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)) throw new Error("--cycle-date must be YYYY-MM-DD");
  const dayAfterCycle = new Date(Date.parse(`${cycleDate}T00:00:00Z`) + 86_400_000)
    .toISOString().slice(0, 10);
  const reportNow = dateArgs.length ? new Date(`${dayAfterCycle}T20:00:00Z`) : now;
  try {
    const report = await buildPackDayTeamViewReport({ now: reportNow });
    if (report.throughDate !== cycleDate) throw new Error("Pack day report date did not match the requested cycle date.");
    const email = buildPackDayEfficiencyEmail(report, cycleDate, { spreadsheetId: DASHBOARD_SHEET_ID });
    if (sample) email.subject = `[Sample] ${email.subject}`;
    const to = process.env.PACK_DAY_EFFICIENCY_EMAIL_TO || "jdeck88@gmail.com";
    if (dryRun) {
      console.log(JSON.stringify({ to, ...email }, null, 2));
    } else {
      await sendOperationalEmail({
        to,
        ...email,
        messageId: `<pack-day-efficiency-${sample ? `sample-${createHash("sha256").update(email.text).digest("hex").slice(0, 12)}-` : ""}${cycleDate}@deckfamilyfarm.com>`
      });
      console.log(`Pack day efficiency email sent to ${to} for ${cycleDate}.`);
    }
  } finally {
    await getPool().end();
  }
}
