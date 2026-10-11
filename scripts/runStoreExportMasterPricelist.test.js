const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { isScheduledExportTime, getExportInvocation } = require("./runStoreExportMasterPricelist.js");

test("scheduled exports run at 4 AM Pacific on Thursdays and Fridays across DST changes", () => {
  for (const instant of [
    "2026-01-08T12:00:00Z", "2026-01-09T12:00:00Z",
    "2026-03-05T12:00:00Z", "2026-03-06T12:00:00Z",
    "2026-03-12T11:00:00Z", "2026-03-13T11:00:00Z",
    "2026-10-29T11:00:00Z", "2026-10-30T11:00:00Z",
    "2026-11-05T12:00:00Z", "2026-11-06T12:00:00Z"
  ]) assert.equal(isScheduledExportTime(new Date(instant)), true, instant);
});

test("the alternate UTC hour, old 5 AM slot, other days, and other minutes do not publish", () => {
  for (const instant of [
    "2026-01-08T11:00:00Z", "2026-01-08T13:00:00Z",
    "2026-07-09T12:00:00Z", "2026-07-09T13:00:00Z",
    "2026-07-08T11:00:00Z", "2026-07-11T11:00:00Z",
    "2026-07-09T11:01:00Z"
  ]) {
    assert.equal(isScheduledExportTime(new Date(instant)), false, instant);
    assert.equal(getExportInvocation(["--scheduled"], new Date(instant)), null, instant);
  }
});

test("scheduled and manual runs use only the CSA Store exporter and retain preview options", () => {
  const flags = ["--dry-run", "--skip-google"];
  const due = getExportInvocation(["--scheduled", ...flags], new Date("2026-07-09T11:00:00Z"));
  const manual = getExportInvocation(flags, new Date("2026-07-08T19:30:00Z"));
  assert.deepEqual(due, manual);
  assert.equal(due.command, process.execPath);
  assert.equal(due.cwd, path.resolve(__dirname, "../apps/api"));
  assert.deepEqual(due.args, [path.join(due.cwd, "scripts/exportMasterPricelist.js"), ...flags]);
});
