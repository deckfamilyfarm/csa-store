// Default preview is read-only. Apply writes pricing proposals only, never remote APIs.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { buildMigrationPlan, readMigrationCatalog, migrationFingerprint, MIGRATION_VERSION } from "../lib/enterprisePricingMigration.js";
import { DEFAULT_PRICING_SETTINGS, calculateEnterprisePricing, roundRatio } from "../lib/enterprisePricingEngine.js";

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const local = process.env.CSA_LOCAL_ONLY === "true";
const apply = process.argv.includes("--apply");
const localSeed = process.argv.includes("--local-seed");
const activate = process.argv.includes("--activate-local");
const rollback = arg("rollback");
if ((localSeed || activate) && !local) throw new Error("Local seeding and activation require the isolated local launcher.");
if (apply && !localSeed && !arg("plan")) throw new Error("Apply requires a reviewed --plan=<file>.");
if ((apply || rollback) && !local && arg("confirm-database") !== process.env.STORE_DB_DATABASE) {
  throw new Error("Explicit --confirm-database=<database> is required for connected migration writes.");
}
const config = { host: process.env.STORE_DB_HOST, port: Number(process.env.STORE_DB_PORT || 3306),
  user: process.env.STORE_DB_USER, password: process.env.STORE_DB_PASSWORD,
  database: process.env.STORE_DB_DATABASE, multipleStatements: false, dateStrings: true,
  supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true };
if (!config.host || !config.user || !config.database) throw new Error("Explicit database configuration is required.");
const connection = await mysql.createConnection(config);
let appPool;
try {
  await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const records = await readMigrationCatalog(connection);
  let settings = DEFAULT_PRICING_SETTINGS;
  const [[settingsTable]] = await connection.query(`SELECT COUNT(*) AS total FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='enterprise_pricing_settings_versions'`);
  if (Number(settingsTable.total)) {
    const [[row]] = await connection.query("SELECT settings_json FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1");
    if (row) settings = typeof row.settings_json === "string" ? JSON.parse(row.settings_json) : row.settings_json;
  }
  const plan = arg("plan") ? JSON.parse(await fs.readFile(arg("plan"), "utf8")) : buildMigrationPlan(records, { settings });
  await connection.query("ROLLBACK");
  if (plan.version !== MIGRATION_VERSION) throw new Error("Unsupported migration plan version.");
  if (JSON.stringify(plan.settings) !== JSON.stringify(settings)) throw new Error("Pricing settings differ from the reviewed plan. Generate a fresh preview.");
  // Re-preview accepts corrected inputs and rebuilds the monetary comparison.
  // Apply requires that exact regenerated output, never a stale comparison.
  if (arg("plan") && !apply && !rollback) for (const row of plan.rows.filter(row => row.action === "ready")) {
    const cost = row.input.purchaseCosts.find(cost => cost.enterpriseCode === "ffcsa");
    row.output = calculateEnterprisePricing({ ...row.input, buyFromPrice: cost.cost }, settings);
    row.output.wholesale = [];
    row.buyPrice.cents = Math.round(row.output.buyFromTenThousandths / 100);
    for (const pkg of row.comparisons) {
      const output = row.output.packages.find(item => item.packageId === pkg.packageId);
      const sale = row.sale?.discountBp || 0;
      pkg.proposedLocalLineRegularCents = output.localLineRegularCents;
      pkg.proposedLocalLineSaleCents = roundRatio(BigInt(output.localLineRegularCents) * BigInt(10000 - sale), 10000n);
      for (const price of pkg.currentLocalLine) {
        price.proposedCents = pkg.proposedLocalLineSaleCents;
        price.differenceCents = price.cents == null ? null : price.proposedCents - price.cents;
      }
      for (const price of pkg.currentSquare) {
        price.proposedRegularCents = output.squareVariationCents;
        price.proposedSaleCents = output.squareVariationCents == null ? null : roundRatio(BigInt(output.squareVariationCents) * BigInt(10000 - sale), 10000n);
      }
    }
  }
  const out = arg("out") || path.resolve(`.local-pricing/migration-${config.database}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  if (!arg("plan") || (!apply && !rollback)) await fs.writeFile(out, JSON.stringify(plan, null, 2), { mode: 0o600 });
  const csv = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [["Product ID", "Product", "Vendor", "Buy Price", "Unit", "Package", "Destination", "Current", "Proposed regular", "Proposed with existing sale", "Difference", "Action", "Review"]];
  for (const row of plan.rows) {
    const common = [row.productId, row.product, row.vendor, row.buyPrice ? (row.buyPrice.cents / 100).toFixed(2) : "", row.input?.pricingUnit || ""];
    if (!row.comparisons.length) lines.push([...common, "", "", "", "", "", "", row.action, row.blockers.join("; ")]);
    for (const pkg of row.comparisons) {
      const dollars = value => value == null ? "" : (value / 100).toFixed(2);
      for (const price of pkg.currentLocalLine) lines.push([...common, pkg.package, `Local Line: ${price.basket}`,
        dollars(price.cents), dollars(pkg.proposedLocalLineRegularCents), dollars(pkg.proposedLocalLineSaleCents),
        dollars(price.differenceCents), row.action, row.reviewReasons.join("; ")]);
      for (const price of pkg.currentSquare) lines.push([...common, pkg.package, "Square", dollars(price.cents),
        dollars(price.proposedRegularCents), dollars(price.proposedSaleCents),
        dollars(price.proposedSaleCents == null || price.cents == null ? null : price.proposedSaleCents - price.cents), row.action, row.reviewReasons.join("; ")]);
    }
  }
  await fs.writeFile(out.replace(/\.json$/, "") + ".csv", lines.map(row => row.map(csv).join(",")).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify(plan.summary));
  if (!apply && !rollback) { console.log(`Read-only migration preview: ${out}`); }
  else {
    const { ensureEnterprisePricingSchema } = await import("../lib/enterprisePricingSchema.js");
    const { getPool, ensureAdminAccessSchema } = await import("../db.js");
    appPool = getPool();
    await ensureEnterprisePricingSchema();
    await ensureAdminAccessSchema();
    let editorId = Number(arg("editor-id"));
    if (local && !editorId) {
      const { default: bcrypt } = await import("bcryptjs");
      const hash = await bcrypt.hash("local-pricing-admin", 10);
      await connection.query(`INSERT INTO users (username,email,password_hash,role,name,active,created_at,updated_at)
        VALUES ('local.admin','local-admin@example.invalid',?,'administrator','Local Pricing Admin',1,UTC_TIMESTAMP(),UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),active=1`, [hash]);
      const [[user]] = await connection.query("SELECT id FROM users WHERE username='local.admin'");
      editorId = Number(user.id);
      await connection.query(`INSERT IGNORE INTO admin_user_roles (user_id,role_id,created_at)
        SELECT ?,id,UTC_TIMESTAMP() FROM admin_roles WHERE role_key='admin'`, [editorId]);
    }
    if (!Number.isSafeInteger(editorId) || editorId <= 0) throw new Error("A valid --editor-id is required.");
    const [[editor]] = await connection.query(`SELECT u.id FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id
      JOIN admin_roles r ON r.id=ur.role_id WHERE u.id=? AND COALESCE(u.active,1)=1
      AND r.role_key IN ('admin','pricing_admin','pricing_editor','local_pricelist_admin') LIMIT 1`, [editorId]);
    if (!editor) throw new Error("Migration editor lacks pricing-edit permission.");
    await connection.beginTransaction();
    if (rollback) {
      const [receipts] = await connection.query("SELECT * FROM enterprise_pricing_migration_rows WHERE run_key=? AND status<>'rolled-back' FOR UPDATE", [rollback]);
      for (const receipt of receipts) {
        if (!receipt.revision_id) {
          const [[laterState]] = await connection.query("SELECT product_id FROM enterprise_pricing_product_state WHERE product_id=? FOR UPDATE", [receipt.product_id]);
          if (laterState) throw new Error(`Product ${receipt.product_id} gained a pricing proposal after migration; rollback held.`);
        }
        if (receipt.revision_id) {
          const [[state]] = await connection.query(`SELECT s.latest_revision_id,s.active_revision_id,r.status,
            b.revision AS buy_revision FROM enterprise_pricing_product_state s
            JOIN enterprise_pricing_revisions r ON r.id=s.latest_revision_id
            LEFT JOIN enterprise_pricing_buy_price_drafts b ON b.product_id=s.product_id WHERE s.product_id=? FOR UPDATE`, [receipt.product_id]);
          const [[publications]] = await connection.query("SELECT COUNT(*) AS total FROM enterprise_pricing_publications WHERE revision_id=?", [receipt.revision_id]);
          if (!state || Number(state.latest_revision_id) !== Number(receipt.revision_id) ||
              !["pending", "local-preview"].includes(state.status) || Number(state.buy_revision) !== 1 || Number(publications.total)) {
            throw new Error(`Product ${receipt.product_id} changed after migration; rollback held.`);
          }
          await connection.query("DELETE FROM enterprise_pricing_product_state WHERE product_id=?", [receipt.product_id]);
          await connection.query("DELETE FROM enterprise_pricing_revisions WHERE id=?", [receipt.revision_id]);
        }
        const [[draft]] = await connection.query("SELECT revision FROM enterprise_pricing_buy_price_drafts WHERE product_id=? FOR UPDATE", [receipt.product_id]);
        const originalPlan = typeof receipt.plan_json === "string" ? JSON.parse(receipt.plan_json) : receipt.plan_json;
        if (Boolean(draft) !== Boolean(originalPlan.buyPrice)) throw new Error(`Buy Price ${receipt.product_id} was added or removed after migration; rollback held.`);
        if (draft && Number(draft.revision) !== 1) throw new Error(`Buy Price ${receipt.product_id} changed after migration; rollback held.`);
        await connection.query("DELETE FROM enterprise_pricing_buy_price_drafts WHERE product_id=?", [receipt.product_id]);
        await connection.query("UPDATE enterprise_pricing_migration_rows SET status='rolled-back' WHERE id=?", [receipt.id]);
      }
      await connection.commit();
      console.log(`Rolled back ${receipts.length} untouched migration records; legacy tables preserved.`);
    } else {
      const selected = plan.rows.filter(row => localSeed || row.approvedForMigration === true);
      if (!selected.length) throw new Error("No reviewed products selected. Set approvedForMigration=true on reviewed plan rows.");
      const ids = selected.map(row => row.productId);
      await connection.query("SELECT id FROM products WHERE id IN (?) FOR UPDATE", [ids]);
      const current = new Map((await readMigrationCatalog(connection)).map(row => [Number(row.product.id), row]));
      const [[enterprise]] = await connection.query("SELECT id FROM enterprise_pricing_enterprises WHERE code='ffcsa'");
      const [[settingsVersion]] = await connection.query("SELECT id FROM enterprise_pricing_settings_versions WHERE status='active' ORDER BY id DESC LIMIT 1");
      const { previewEnterprisePricing } = await import("../lib/enterprisePricingService.js");
      const runKey = crypto.randomUUID();
      let seeded = 0, pending = 0, localActive = 0, held = 0, skipped = 0;
      for (const row of selected) {
        const [[existing]] = await connection.query(`SELECT product_id FROM enterprise_pricing_product_state WHERE product_id=?
          UNION SELECT product_id FROM enterprise_pricing_migration_rows WHERE product_id=? AND migration_version=?
          UNION SELECT product_id FROM enterprise_pricing_buy_price_drafts WHERE product_id=? LIMIT 1`, [row.productId, row.productId, MIGRATION_VERSION, row.productId]);
        if (existing) { skipped++; continue; }
        if (!current.has(row.productId) || migrationFingerprint(current.get(row.productId)) !== row.fingerprint) {
          throw new Error(`Source pricing changed for ${row.productId}; generate a fresh migration preview.`);
        }
        if (!localSeed && row.action !== "ready") throw new Error(`Product ${row.productId} has unresolved migration inputs.`);
        let revisionId = null, receiptStatus = "held";
        if (row.buyPrice) {
          await connection.query(`INSERT INTO enterprise_pricing_buy_price_drafts
            (product_id,purchasing_enterprise_id,price,revision,edited_by,updated_at) VALUES (?,?,?,1,?,UTC_TIMESTAMP())`,
          [row.productId, enterprise.id, (row.buyPrice.cents / 100).toFixed(2), editorId]);
        }
        if (row.action === "ready") {
          const input = { ...row.input, retailEnterpriseId: Number(enterprise.id),
            purchaseCosts: row.input.purchaseCosts.map(cost => ({ ...cost, enterpriseId: Number(enterprise.id) })) };
          const preview = await previewEnterprisePricing(row.productId, input);
          if (JSON.stringify(preview.output) !== JSON.stringify(row.output) ||
              preview.output.buyFromTenThousandths !== row.buyPrice.cents * 100) {
            throw new Error(`Product ${row.productId} inputs changed after comparison. Re-preview the edited plan before applying.`);
          }
          const status = activate && !row.sale?.onSale && !row.reviewReasons.length ? "local-preview" : "pending";
          const [insert] = await connection.query(`INSERT INTO enterprise_pricing_revisions
            (product_id,settings_version_id,status,input_json,output_json,editor_id,created_at)
            VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())`, [row.productId, settingsVersion.id, status,
            JSON.stringify(preview.input), JSON.stringify(preview.output), editorId]);
          revisionId = Number(insert.insertId);
          await connection.query(`INSERT INTO enterprise_pricing_product_state
            (product_id,latest_revision_id,active_revision_id,updated_at) VALUES (?,?,?,UTC_TIMESTAMP())`,
          [row.productId, revisionId, status === "local-preview" ? revisionId : null]);
          receiptStatus = status;
          status === "local-preview" ? localActive++ : pending++;
        } else held++;
        await connection.query(`INSERT INTO enterprise_pricing_migration_rows
          (migration_version,run_key,product_id,source_hash,source_json,plan_json,revision_id,status,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`, [MIGRATION_VERSION, runKey, row.productId, row.fingerprint,
          JSON.stringify(row.source), JSON.stringify(row), revisionId, receiptStatus, editorId]);
        seeded++;
      }
      await connection.commit();
      const receipt = { runKey, database: config.database, seeded, pending, localActive, held, skipped,
        productionWrites: !local, remotePublications: 0 };
      await fs.writeFile(out.replace(/\.json$/, "") + `.receipt-${runKey}.json`, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      if (seeded) await fs.writeFile(out.replace(/\.json$/, "") + ".receipt.json", JSON.stringify(receipt, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(receipt));
    }
  }
} catch (error) { await connection.query("ROLLBACK").catch(() => {}); throw error; }
finally { await connection.end(); if (appPool) await appPool.end(); }
