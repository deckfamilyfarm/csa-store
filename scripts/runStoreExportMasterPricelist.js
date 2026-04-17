#!/usr/bin/env node

const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const repoRoot = path.resolve(__dirname, "..");
const apiDir = path.join(repoRoot, "apps/api");

const child = spawn(
  process.execPath,
  [path.join(apiDir, "scripts/exportMasterPricelist.js"), ...args],
  {
    cwd: apiDir,
    stdio: "inherit",
    env: process.env
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
