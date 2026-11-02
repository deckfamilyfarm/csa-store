import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getLocalLineAccessToken, getLocalLineBaseUrl } from "../localLineAuth.js";

const require = createRequire(import.meta.url);

// Reuse the vendor reports' reviewed historical-cost rules and private ledger.
// Never replace saved order costs with today's catalog or retail prices.
export function loadDashboardOrderPricing() {
  return require(process.env.DASHBOARD_ORDER_PRICING_MODULE || fileURLToPath(
    new URL("../../../../ffcsa_scripts/localline/order_pricing.js", import.meta.url)
  ));
}

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const key = (order, product, name) => JSON.stringify([String(order), String(product?.id ?? product ?? 0), String(name || "").trim()]);
const cents = value => Math.round(Number(value) * 100);

export function planDashboardVendorCosts(rows, entries, priceOrderEntry) {
  const saved = new Map();
  for (const entryRow of entries) {
    const entry = parse(entryRow.raw_json);
    const k = key(entryRow.local_line_order_id, entry.product, entry.package_name);
    if (!saved.has(k)) saved.set(k, []);
    saved.get(k).push(entry);
  }
  const groups = new Map();
  const customRows = [];
  for (const row of rows) {
    // Membership purchases are revenue, never vendor COGS.
    if (String(row.category_name || "").trim().toLowerCase() === "membership") continue;
    if (!(Number(row.product_id) > 0)) { customRows.push(row.id); continue; }
    const k = key(row.local_line_order_id, row.product_id, row.package_name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const changes = [], issues = [], pricedRows = [];
  let correctedEntries = 0;
  for (const [k, group] of groups) {
    try {
      const matches = saved.get(k);
      if (!matches?.length) throw new Error("Saved order pricing is missing; refresh orders first");
      const priced = matches.map(priceOrderEntry);
      const retail = group.reduce((sum, row) => sum + cents(row.retail_amount), 0);
      if (Math.abs(retail - priced.reduce((sum, entry) => sum + cents(entry.retailTotal), 0)) > 1) {
        throw new Error("Order export differs from saved order details; refresh orders first");
      }
      // A repeated product/package must reconcile to its complete saved group.
      const quantity = group.reduce((sum, row) => sum + Number(row.quantity), 0);
      const charged = priced.reduce((sum, entry) => sum + entry.quantity, 0);
      // Export quantities can be packages while quantity_to_charge is pounds.
      // Preserve the export quantity and normalize its per-unit cost to the saved total.
      if (!quantity && charged) throw new Error("Missing reporting quantity");
      const totalCents = priced.reduce((sum, entry) => sum + cents(entry.totalPrice), 0);
      const unitCents = quantity ? Math.round(totalCents / quantity) : 0;
      correctedEntries += priced.filter(entry => entry.costCorrection).length;
      let allocated = 0;
      group.forEach((row, index) => {
        const total = index === group.length - 1 ? totalCents - allocated : (quantity ? Math.round(totalCents * Number(row.quantity) / quantity) : 0);
        allocated += total;
        pricedRows.push({ id: row.id, unit: unitCents / 100, total: total / 100, entries: matches });
        if (cents(row.purchase_unit_price) !== unitCents || cents(row.purchase_total) !== total) {
          changes.push({ id: row.id, month: row.fulfillment_month, orderId: row.local_line_order_id,
            product: row.product_name, beforeUnit: row.purchase_unit_price, beforeTotal: row.purchase_total,
            unit: unitCents / 100, total: total / 100 });
        }
      });
    } catch (error) {
      issues.push({ orderId: group[0].local_line_order_id, product: group[0].product_name, reason: error.message });
    }
  }
  return { changes, issues, correctedEntries, checkedRows: rows.length, customRows, pricedRows };
}


const snapshotFields = ["id", "product", "product_package", "product_name", "package_name",
  "package_unit_price", "quantity_to_charge", "total_price", "charge_type", "charge_unit",
  "created_at", "updated_at", "vendor_name"];

async function fetchPricingOrder(id, token) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(`${getLocalLineBaseUrl()}orders/${encodeURIComponent(id)}/`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000)
    });
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  if (!response.ok) throw new Error(`Order ${id}: Local Line HTTP ${response.status}`);
  const order = await response.json();
  if (Number(order.id) !== Number(id) || !Array.isArray(order.order_entries)) throw new Error(`Invalid pricing snapshot for order ${id}`);
  return order.order_entries.map(entry => ({ local_line_order_id: id,
    raw_json: Object.fromEntries(snapshotFields.filter(field => field in entry).map(field => [field, entry[field]])) }));
}

export async function resolveDashboardVendorCosts(connection, rows, {
  refreshMissing = true, snapshots = {}, reportProgress = () => {}, pricing = loadDashboardOrderPricing()
} = {}) {
  const ids = [...new Set(rows.filter(row => !parse(row.raw_json || "{}")?._dashboardVendorCost?.entries?.length).map(row => row.local_line_order_id))];
  let entries = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const [saved] = await connection.query(`SELECT local_line_order_id,
      JSON_OBJECT(${snapshotFields.map(field => `'${field}',JSON_EXTRACT(raw_json,'$.${field}')`).join(",")}) raw_json
      FROM local_line_order_entries WHERE local_line_order_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    entries.push(...saved);
  }
  // Previously verified cost snapshots survive subsequent dashboard refreshes.
  const cachedGroups = new Map();
  for (const row of rows) {
    const cached = parse(row.raw_json || "{}")?._dashboardVendorCost;
    if (cached?.entries?.length) cachedGroups.set(key(row.local_line_order_id, row.product_id, row.package_name),
      cached.entries.map(entry => ({ local_line_order_id: row.local_line_order_id, raw_json: entry })));
  }
  entries = entries.filter(row => {
    const entry = parse(row.raw_json);
    return !cachedGroups.has(key(row.local_line_order_id, entry.product, entry.package_name));
  }).concat([...cachedGroups.values()].flat());
  const replaceOrders = fresh => {
    entries = entries.filter(row => !Object.hasOwn(fresh, row.local_line_order_id)).concat(Object.values(fresh).flat());
  };
  replaceOrders(snapshots);
  let plan = planDashboardVendorCosts(rows, entries, pricing.priceOrderEntry);
  if (refreshMissing && plan.issues.length) {
    const pending = [...new Set(plan.issues.map(issue => issue.orderId))];
    const total = pending.length, fresh = {}, failures = [];
    const token = await getLocalLineAccessToken();
    let completed = 0;
    async function worker() {
      while (pending.length) {
        const id = pending.shift();
        try { fresh[id] = await fetchPricingOrder(id, token); }
        catch (error) { failures.push(error.message); }
        reportProgress(`Checked historical prices for ${++completed}/${total} orders`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
    if (failures.length) throw new Error(`Could not refresh order pricing: ${failures.slice(0, 5).join("; ")}`);
    replaceOrders(fresh);
    plan = planDashboardVendorCosts(rows, entries, pricing.priceOrderEntry);
  }
  return { ...plan, pricingBasis: pricing.PRICING_BASIS };
}

export function dashboardCostRawJson(raw, priced, pricingBasis) {
  return JSON.stringify({ ...parse(raw || "{}"), _dashboardVendorCost: { pricingBasis, entries: priced.entries } });
}

export async function rebuildDashboardVendorCosts(connection, { apply = false, monthKeys = null, skipVerified = false, ...options } = {}) {
  if (skipVerified && !monthKeys) {
    const pricing = options.pricing || loadDashboardOrderPricing();
    const [[status]] = await connection.query(`SELECT COUNT(*) AS pending
      FROM local_line_order_reporting_entries WHERE product_id > 0
      AND LOWER(COALESCE(category_name, '')) <> 'membership'
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$._dashboardVendorCost.pricingBasis')), '') <> ?`, [pricing.PRICING_BASIS]);
    if (!Number(status.pending)) return { changes: [], issues: [], pricedRows: [], customRows: [], checkedRows: 0,
      correctedEntries: 0, pricingBasis: pricing.PRICING_BASIS, alreadyVerified: true };
  }
  const filter = monthKeys?.length ? ` WHERE fulfillment_month IN (${monthKeys.map(() => "?").join(",")})` : "";
  const sql = `SELECT id,fulfillment_month,local_line_order_id,product_id,product_name,
    package_name,category_name,quantity,retail_amount,purchase_unit_price,purchase_total,raw_json
    FROM local_line_order_reporting_entries${filter} ORDER BY id`;
  const [rows] = await connection.query(sql, monthKeys || []);
  const plan = await resolveDashboardVendorCosts(connection, rows, options);
  if (!apply) return plan;
  if (plan.issues.length) throw new Error(`Dashboard costs need review (${plan.issues.length} groups): ${JSON.stringify(plan.issues.slice(0, 5))}`);
  await connection.beginTransaction();
  try {
    const [locked] = await connection.query(`${sql} FOR UPDATE`, monthKeys || []);
    if (JSON.stringify(locked) !== JSON.stringify(rows)) throw new Error("Reporting cache changed during cost review; retry with current data");
    const byId = new Map(rows.map(row => [row.id, row]));
    const updates = plan.pricedRows.map(priced => {
      const before = byId.get(priced.id);
      const raw = dashboardCostRawJson(before.raw_json, priced, plan.pricingBasis);
      return { ...priced, raw, changed: cents(before.purchase_total) !== cents(priced.total) ||
        cents(before.purchase_unit_price) !== cents(priced.unit) || before.raw_json !== raw };
    }).filter(row => row.changed);
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100);
      await connection.query(`UPDATE local_line_order_reporting_entries SET
        purchase_unit_price = CASE id ${chunk.map(() => "WHEN ? THEN ?").join(" ")} END,
        purchase_total = CASE id ${chunk.map(() => "WHEN ? THEN ?").join(" ")} END,
        raw_json = CASE id ${chunk.map(() => "WHEN ? THEN ?").join(" ")} END
        WHERE id IN (${chunk.map(() => "?").join(",")})`, [
        ...chunk.flatMap(row => [row.id, row.unit]), ...chunk.flatMap(row => [row.id, row.total]),
        ...chunk.flatMap(row => [row.id, row.raw]), ...chunk.map(row => row.id)
      ]);
    }
    await connection.commit();
    return plan;
  } catch (error) { await connection.rollback(); throw error; }
}
