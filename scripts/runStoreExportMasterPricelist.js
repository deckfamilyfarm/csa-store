#!/usr/bin/env node

const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const apiDir = path.join(repoRoot, "apps/api");

function isScheduledExportTime(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return ["Thu", "Fri"].includes(parts.weekday) && parts.hour === "04" && parts.minute === "00";
}

function getExportInvocation(args, now = new Date()) {
  if (args.includes("--scheduled") && !isScheduledExportTime(now)) return null;
  return {
    command: process.execPath,
    args: [path.join(apiDir, "scripts/exportMasterPricelist.js"), ...args.filter(arg => arg !== "--scheduled")],
    cwd: apiDir
  };
}

function main() {
  const invocation = getExportInvocation(process.argv.slice(2));
  if (!invocation) {
    console.log(`${new Date().toISOString()} Master pricelist skipped: scheduled exports run Thursday and Friday at 4:00 AM America/Los_Angeles.`);
    return;
  }
  console.log(`${new Date().toISOString()} Starting CSA Store master pricelist export.`);
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: "inherit",
    env: process.env
  });
  child.on("error", error => {
    console.error(`Unable to start master pricelist export: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

module.exports = { isScheduledExportTime, getExportInvocation };
if (require.main === module) main();
