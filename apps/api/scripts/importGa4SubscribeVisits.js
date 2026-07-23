import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { ensureMarketingSchema, getPool, initDb } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");

dotenv.config({ path: path.resolve(repoRoot, ".env"), override: false });

const DEFAULT_HOST = "subscribe.deckfamilyfarm.com";
const IMPORT_USER_AGENT = "ga4-subscribe-visits-backfill";
const IMPORT_IP = "ga4-backfill";

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstField(row, candidates = []) {
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeHeader(key);
    if (candidates.includes(normalizedKey)) return value;
  }
  return "";
}

function isGrandTotalRow(row = []) {
  return row.some((value) => normalizeHeader(value) === "grandtotal");
}

function assignGa4Cell(target, header, group, value) {
  const normalizedHeader = normalizeHeader(header);
  const normalizedGroup = normalizeHeader(group);
  if (!normalizedHeader) return;

  const dimensionHeaders = new Set([
    "city",
    "date",
    "pagelocation",
    "landingpageplusquerystring",
    "landingpage",
    "pagepathplusquerystring",
    "pagepath",
    "sessionsourcemedium",
    "sourcemedium",
    "manualsourcemedium",
    "sessioncampaign",
    "sessioncampaignname",
    "campaign",
    "utmcampaign",
    "pagereferrer",
    "referrer",
    "referrerurl"
  ]);
  const metricHeaders = new Set(["activeusers", "sessions", "views", "screenpageviews", "pageviews"]);

  if (dimensionHeaders.has(normalizedHeader) && typeof target[header] === "undefined") {
    target[header] = value;
    return;
  }

  if (!metricHeaders.has(normalizedHeader)) return;

  if (normalizedGroup === "totals") {
    target[header] = value;
    target[`Totals ${header}`] = value;
    return;
  }

  if (!normalizedGroup && typeof target[header] === "undefined") {
    target[header] = value;
  }
}

function cleanMetric(value) {
  const numeric = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function cleanText(value) {
  const text = String(value || "").trim();
  if (!text || /^\((not set|none|direct)\)$/i.test(text)) return "";
  return text;
}

function parseDateValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ymdCompact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdCompact) {
    return new Date(Date.UTC(Number(ymdCompact[1]), Number(ymdCompact[2]) - 1, Number(ymdCompact[3]), 12));
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    return new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function splitSourceMedium(value) {
  const text = cleanText(value);
  if (!text) return { source: "", medium: "" };
  const slashIndex = text.indexOf("/");
  if (slashIndex < 0) return { source: cleanText(text), medium: "" };
  return {
    source: cleanText(text.slice(0, slashIndex)),
    medium: cleanText(text.slice(slashIndex + 1))
  };
}

function normalizeUrl(value, defaultHost) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\//i.test(raw)) return `https://${raw}`;
  if (raw.startsWith("/")) return `https://${defaultHost}${raw}`;
  return `https://${defaultHost}/${raw.replace(/^#+/, "")}`;
}

function parseUrlParts(value, defaultHost) {
  const url = normalizeUrl(value, defaultHost);
  try {
    const parsed = new URL(url);
    return {
      url: parsed.toString(),
      host: parsed.host,
      path: parsed.pathname,
      params: parsed.searchParams
    };
  } catch (_error) {
    return {
      url: "",
      host: defaultHost,
      path: "",
      params: new URLSearchParams()
    };
  }
}

function makeRowHash(row) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(row))
    .digest("hex")
    .slice(0, 24);
}

function makeSessionToken(rowHash, index) {
  return `ga4_${rowHash}_${String(index).padStart(5, "0")}`;
}

function readSheetRows(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerIndex = matrix.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return (
      headers.includes("date") &&
      headers.some((header) =>
        [
          "pagelocation",
          "landingpageplusquerystring",
          "landingpage",
          "pagepathplusquerystring",
          "pagepath"
        ].includes(header)
      ) &&
      headers.some((header) => ["sessions", "views", "screenpageviews"].includes(header))
    );
  });

  if (headerIndex < 0) {
    return xlsx.utils.sheet_to_json(sheet, { defval: "", raw: false });
  }

  const groupRow = matrix[headerIndex - 1] || [];
  const headerRow = matrix[headerIndex] || [];
  return matrix
    .slice(headerIndex + 1)
    .filter((row) => row.some((value) => String(value || "").trim()) && !isGrandTotalRow(row))
    .map((row) => {
      const record = {};
      headerRow.forEach((header, index) => {
        assignGa4Cell(record, header, groupRow[index], row[index]);
      });
      return record;
    });
}

async function loadMarketingLookups(pool) {
  const [linkRows] = await pool.query(
    "SELECT id, slug, campaign_id AS campaignId, message_focus AS messageFocus, utm_source AS utmSource, utm_medium AS utmMedium, utm_campaign AS utmCampaign, utm_content AS utmContent, utm_term AS utmTerm FROM marketing_utm_links"
  );
  const [campaignRows] = await pool.query(
    "SELECT id, slug, message_focus AS messageFocus FROM marketing_campaigns"
  );
  return {
    linkBySlug: new Map(linkRows.map((row) => [String(row.slug || ""), row])),
    campaignBySlug: new Map(campaignRows.map((row) => [String(row.slug || ""), row]))
  };
}

function normalizeGaRow(row, { defaultHost, linkBySlug, campaignBySlug }) {
  const date = parseDateValue(firstField(row, ["date", "day"]));
  const pageValue = firstField(row, [
    "landingpageplusquerystring",
    "landingpage",
    "pagepathplusquerystring",
    "pagepath",
    "pagelocation",
    "fullpageurl"
  ]);
  const urlParts = parseUrlParts(pageValue, defaultHost);
  const sessions = cleanMetric(firstField(row, ["sessions", "session"]));
  const pageViews =
    cleanMetric(firstField(row, ["totalsviews", "views", "screenpageviews", "pageviews", "screenpageview"])) ||
    sessions;
  const sourceMedium = splitSourceMedium(
    firstField(row, ["sessionsourcemedium", "sourcemedium", "manualsourcemedium"])
  );
  const source =
    cleanText(firstField(row, ["sessionsource", "source", "manualsource"])) ||
    sourceMedium.source;
  const medium =
    cleanText(firstField(row, ["sessionmedium", "medium", "manualmedium"])) ||
    sourceMedium.medium;
  const campaign =
    cleanText(firstField(row, ["sessioncampaign", "sessioncampaignname", "campaign", "utmcampaign"])) ||
    cleanText(urlParts.params.get("utm_campaign"));
  const city = cleanText(firstField(row, ["city"]));
  const content =
    cleanText(firstField(row, ["utmcontent", "manualadcontent", "sessionmanualadcontent", "adcontent"])) ||
    cleanText(urlParts.params.get("utm_content"));
  const term =
    cleanText(firstField(row, ["utmterm", "manualterm", "sessionmanualterm", "term"])) ||
    cleanText(urlParts.params.get("utm_term"));
  const csaLinkSlug = cleanText(urlParts.params.get("csa_link"));
  const csaCampaignSlug = cleanText(urlParts.params.get("csa_campaign"));
  const link = csaLinkSlug ? linkBySlug.get(csaLinkSlug) || null : null;
  const campaignRow =
    (csaCampaignSlug ? campaignBySlug.get(csaCampaignSlug) : null) ||
    (link?.campaignId ? { id: Number(link.campaignId), messageFocus: link.messageFocus || "" } : null);
  const messageFocus =
    cleanText(urlParts.params.get("csa_message_focus")) ||
    cleanText(link?.messageFocus) ||
    cleanText(campaignRow?.messageFocus);
  const referrerUrl = cleanText(firstField(row, ["pagereferrer", "referrer", "referrerurl"]));

  if (!date || !sessions || !urlParts.url) {
    return null;
  }

  const rowIdentity = {
    city,
    date: dateKey(date),
    url: urlParts.url,
    source,
    medium,
    campaign,
    content,
    term,
    csaLinkSlug,
    csaCampaignSlug
  };

  return {
    rowHash: makeRowHash(rowIdentity),
    date,
    sessions,
    pageViews,
    pageUrl: urlParts.url,
    sourceHost: urlParts.host,
    sourcePath: urlParts.path,
    referrerUrl,
    campaignId: campaignRow?.id || null,
    utmLinkId: link?.id || null,
    utmSource: cleanText(urlParts.params.get("utm_source")) || source || cleanText(link?.utmSource),
    utmMedium: cleanText(urlParts.params.get("utm_medium")) || medium || cleanText(link?.utmMedium),
    utmCampaign: cleanText(urlParts.params.get("utm_campaign")) || campaign || cleanText(link?.utmCampaign),
    utmContent: cleanText(urlParts.params.get("utm_content")) || content || cleanText(link?.utmContent),
    utmTerm: cleanText(urlParts.params.get("utm_term")) || term || cleanText(link?.utmTerm),
    messageFocus
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function aggregateRowsByHash(rows = []) {
  const rowsByHash = new Map();
  for (const row of rows) {
    const existing = rowsByHash.get(row.rowHash);
    if (!existing) {
      rowsByHash.set(row.rowHash, { ...row });
      continue;
    }
    existing.sessions += row.sessions;
    existing.pageViews += row.pageViews;
  }
  return [...rowsByHash.values()];
}

async function selectSessionIds(pool, tokens) {
  const sessionIds = [];
  for (const tokenChunk of chunk(tokens, 500)) {
    const [rows] = await pool.query(
      "SELECT id FROM marketing_sessions WHERE session_token IN (?)",
      [tokenChunk]
    );
    sessionIds.push(...rows.map((row) => Number(row.id)).filter(Number.isFinite));
  }
  return sessionIds;
}

async function deleteExistingSyntheticRow(pool, rowHash) {
  const [rows] = await pool.query(
    "SELECT id FROM marketing_sessions WHERE session_token LIKE ?",
    [`ga4_${rowHash}_%`]
  );
  const sessionIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);
  if (!sessionIds.length) return;
  for (const idChunk of chunk(sessionIds, 500)) {
    await pool.query("DELETE FROM marketing_click_events WHERE session_id IN (?)", [idChunk]);
    await pool.query("DELETE FROM marketing_sessions WHERE id IN (?)", [idChunk]);
  }
}

async function importRows(rows, { write = false }) {
  initDb();
  await ensureMarketingSchema();
  const pool = getPool();
  const { linkBySlug, campaignBySlug } = await loadMarketingLookups(pool);
  const defaultHost = getArg("host", DEFAULT_HOST);
  const parsedRows = rows
    .map((row) => normalizeGaRow(row, { defaultHost, linkBySlug, campaignBySlug }))
    .filter(Boolean);
  const normalizedRows = aggregateRowsByHash(parsedRows);
  const skipped = rows.length - parsedRows.length;
  const sessionTotal = normalizedRows.reduce((sum, row) => sum + row.sessions, 0);
  const pageViewTotal = normalizedRows.reduce((sum, row) => sum + row.pageViews, 0);

  const summary = {
    inputRows: rows.length,
    importRows: parsedRows.length,
    uniqueImportRows: normalizedRows.length,
    skippedRows: skipped,
    sessions: sessionTotal,
    pageViews: pageViewTotal,
    write
  };

  if (!write) return summary;

  for (const row of normalizedRows) {
    await deleteExistingSyntheticRow(pool, row.rowHash);
    const tokens = Array.from({ length: row.sessions }, (_value, index) =>
      makeSessionToken(row.rowHash, index)
    );
    const sessionValues = tokens.map((token) => [
      token,
      row.campaignId,
      row.utmLinkId,
      row.sourceHost,
      row.sourcePath,
      row.pageUrl,
      row.referrerUrl || null,
      row.utmSource || null,
      row.utmMedium || null,
      row.utmCampaign || null,
      row.utmContent || null,
      row.utmTerm || null,
      row.messageFocus || null,
      IMPORT_IP,
      IMPORT_USER_AGENT,
      row.date,
      row.date,
      row.date,
      row.date
    ]);

    for (const valueChunk of chunk(sessionValues, 500)) {
      await pool.query(
        `
          INSERT INTO marketing_sessions (
            session_token, campaign_id, utm_link_id, source_host, source_path,
            landing_url, referrer_url, utm_source, utm_medium, utm_campaign,
            utm_content, utm_term, message_focus, client_ip, user_agent,
            first_seen_at, last_seen_at, created_at, updated_at
          )
          VALUES ?
          ON DUPLICATE KEY UPDATE
            campaign_id = VALUES(campaign_id),
            utm_link_id = VALUES(utm_link_id),
            source_host = VALUES(source_host),
            source_path = VALUES(source_path),
            landing_url = VALUES(landing_url),
            referrer_url = VALUES(referrer_url),
            utm_source = VALUES(utm_source),
            utm_medium = VALUES(utm_medium),
            utm_campaign = VALUES(utm_campaign),
            utm_content = VALUES(utm_content),
            utm_term = VALUES(utm_term),
            message_focus = VALUES(message_focus),
            client_ip = VALUES(client_ip),
            user_agent = VALUES(user_agent),
            first_seen_at = VALUES(first_seen_at),
            last_seen_at = VALUES(last_seen_at),
            updated_at = VALUES(updated_at)
        `,
        [valueChunk]
      );
    }

    const sessionIds = await selectSessionIds(pool, tokens);

    const eventValues = Array.from({ length: row.pageViews }, (_value, index) => {
      const sessionId = sessionIds[index % Math.max(sessionIds.length, 1)] || null;
      return [
        sessionId,
        row.campaignId,
        row.utmLinkId,
        "page_view",
        row.pageUrl,
        row.referrerUrl || null,
        row.pageUrl,
        row.sourceHost,
        row.sourcePath,
        row.utmSource || null,
        row.utmMedium || null,
        row.utmCampaign || null,
        row.utmContent || null,
        row.utmTerm || null,
        row.messageFocus || null,
        row.date,
        row.date
      ];
    });

    for (const valueChunk of chunk(eventValues, 500)) {
      await pool.query(
        `
          INSERT INTO marketing_click_events (
            session_id, campaign_id, utm_link_id, event_type, page_url,
            referrer_url, destination_url, source_host, source_path, utm_source,
            utm_medium, utm_campaign, utm_content, utm_term, message_focus,
            occurred_at, created_at
          )
          VALUES ?
        `,
        [valueChunk]
      );
    }
  }

  return summary;
}

async function main() {
  const filePath = getArg("file");
  const write = hasFlag("write") || hasFlag("apply");
  if (!filePath) {
    throw new Error("Usage: npm run import:ga4-subscribe-visits -- --file=/path/to/ga4.csv [--write]");
  }
  const absolutePath = path.resolve(process.cwd(), filePath);
  const rows = readSheetRows(absolutePath);
  const summary = await importRows(rows, { write });
  console.log("GA4 subscribe visit import summary:");
  console.log(JSON.stringify(summary, null, 2));
  if (!write) {
    console.log("Preview only. Re-run with --write to import.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("GA4 subscribe visit import failed:", error.message);
    process.exit(1);
  });
