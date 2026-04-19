#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(`--${flag}`);
}

function getArg(name) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function resolveFromRepoRoot(repoRoot, targetPath) {
  if (!targetPath) return null;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(repoRoot, targetPath);
}

const repoRoot = path.resolve(__dirname, "..");
const killdeerRoot = path.resolve(repoRoot, "../killdeer");
const killdeerScriptsDir = path.join(killdeerRoot, "scripts");
const exportScriptName = "export_master_pricelist.js";
const exportScriptPath = path.join(killdeerScriptsDir, exportScriptName);

const envFile = resolveFromRepoRoot(repoRoot, getArg("env-file") || ".env");
const inferredNodeEnv =
  (path.basename(envFile).match(/^\.env\.(.+)$/) || [])[1] ||
  process.env.NODE_ENV ||
  "production";
const nodeEnv = getArg("node-env") || inferredNodeEnv;
const skipGoogle = !hasFlag("google-sync");
const dryRun = hasFlag("dry-run");

if (!fs.existsSync(killdeerRoot)) {
  console.error(`Killdeer repo not found at ${killdeerRoot}`);
  process.exit(1);
}

if (!fs.existsSync(exportScriptPath)) {
  console.error(`Killdeer export script not found at ${exportScriptPath}`);
  process.exit(1);
}

if (!fs.existsSync(envFile)) {
  console.error(`Env file not found at ${envFile}`);
  process.exit(1);
}

const envResult = dotenv.config({ path: envFile });
if (envResult.error) {
  console.error(`Failed to load env file at ${envFile}`);
  console.error(envResult.error.message);
  process.exit(1);
}

const childEnv = {
  ...process.env,
  DOTENV_CONFIG_PATH: envFile,
  NODE_ENV: nodeEnv
};

childEnv.DFF_DB_HOST = childEnv.DFF_DB_HOST || childEnv.STORE_DB_HOST || "";
childEnv.DFF_DB_PORT = childEnv.DFF_DB_PORT || childEnv.STORE_DB_PORT || "3306";
childEnv.DFF_DB_USER = childEnv.DFF_DB_USER || childEnv.STORE_DB_USER || "";
childEnv.DFF_DB_PASSWORD = childEnv.DFF_DB_PASSWORD || childEnv.STORE_DB_PASSWORD || "";
childEnv.DFF_DB_DATABASE = childEnv.DFF_DB_DATABASE || childEnv.STORE_DB_DATABASE || "";

if (skipGoogle) {
  childEnv.GOOGLE_APPLICATION_CREDENTIALS = "";
  childEnv.GOOGLE_SHEETS_SPREADSHEET_ID = "";
  childEnv.GOOGLE_SHEETS_TAB_NAME = "";
  childEnv.GOOGLE_SHEETS_INTRO_TAB_NAME = "";
}

const nodeArgs = ["-r", "dotenv/config", exportScriptName];

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        cwd: killdeerScriptsDir,
        command: process.execPath,
        args: nodeArgs,
        envFile,
        nodeEnv,
        googleSyncEnabled: !skipGoogle
      },
      null,
      2
    )
  );
  process.exit(0);
}

const child = spawn(process.execPath, nodeArgs, {
  cwd: killdeerScriptsDir,
  env: childEnv,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
