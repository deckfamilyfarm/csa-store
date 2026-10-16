import { getPool } from "../db.js";
import {
  buildPackDayTeamViewReport,
  publishPackDayTeamView
} from "../lib/dashboardPublisher.js";

try {
  const dryRun = process.argv.includes("--dry-run");
  const result = dryRun
    ? await buildPackDayTeamViewReport()
    : await publishPackDayTeamView();
  if (dryRun) {
    console.log(JSON.stringify({
      throughDate: result.throughDate,
      cycleCount: result.cycles.length,
      targetMinutesPerOrder: result.scored.targetMinutesPerOrder,
      referenceCycleCount: result.scored.referenceCycleCount,
      displayedCycleCount: result.scored.rows.length,
      rows: result.scored.rows.map((cycle) => ({
        cycleDate: cycle.cycleDate,
        type: cycle.type,
        orders: cycle.orders,
        packMinutesPerOrder: cycle.packMinutesPerOrder,
        deliveryMinutesPerOrder: cycle.deliveryMinutesPerOrder,
        totalMinutesPerOrder: cycle.totalMinutesPerOrder
      }))
    }));
  } else {
    console.log(JSON.stringify(result));
  }
} finally {
  await getPool().end();
}
