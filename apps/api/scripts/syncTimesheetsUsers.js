import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "../db.js";
import {
  applyTimesheetsUserSync,
  previewTimesheetsUserSync
} from "../lib/timesheetsUserSync.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function hasFlag(name) {
  return process.argv.includes(name);
}

function formatCandidate(candidate) {
  if (!candidate) return "";
  return [
    candidate.username,
    candidate.name,
    candidate.employeeId ? `employee:${candidate.employeeId}` : "",
    candidate.timesheetsUserId ? `user:${candidate.timesheetsUserId}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function printResult(result) {
  console.log("Timesheets user sync summary:");
  console.log(JSON.stringify(result.summary, null, 2));
  if (result.appliedCount !== undefined) {
    console.log(`Applied ${result.appliedCount} Timesheets link updates.`);
  }

  const rows = result.items.map((item) => ({
    csaUser: item.username,
    name: item.name || "",
    status: item.status,
    method: item.matchMethod || "",
    currentEmployeeId: item.current?.timesheetsEmployeeId || "",
    proposed: formatCandidate(item.proposed),
    candidates: (item.candidates || []).map(formatCandidate).join("; ")
  }));
  console.table(rows);

  if (result.applied?.length) {
    console.log("Applied links:");
    console.table(result.applied);
  }
}

async function main() {
  initDb();
  const includeAll = hasFlag("--all");
  const write = hasFlag("--write") || hasFlag("--apply");
  const result = write
    ? await applyTimesheetsUserSync({ includeAll })
    : await previewTimesheetsUserSync({ includeAll });
  printResult(result);

  if (!write) {
    console.log("Preview only. Re-run with --write to apply unique matches.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Timesheets user sync failed:", error.message);
    process.exit(1);
  });
