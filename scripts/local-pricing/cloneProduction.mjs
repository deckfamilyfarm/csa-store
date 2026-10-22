import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const database = `csa_pricing_local_${stamp}`;
const snapshot = path.join(root, ".local-pricing", "snapshots", stamp);
const run = (script, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${script} failed (${code}). Previous local database remains selected.`)));
});
await run("apps/api/scripts/exportProductionSnapshotReadOnly.js", [`--out=${snapshot}`]);
await run("scripts/local-pricing/restoreProduction.mjs", [`--snapshot=${snapshot}`, `--database=${database}`]);
await run("scripts/local-pricing/migrate.mjs", [`--database=${database}`, "--apply", "--local-seed", "--activate-local"]);
await run("scripts/local-pricing/verifyProductionClone.mjs", [`--database=${database}`,
  `--plan=${path.join(root, ".local-pricing", `migration-${database}.json`)}`]);
await run("scripts/local-pricing/selectDatabase.mjs", [`--database=${database}`]);
