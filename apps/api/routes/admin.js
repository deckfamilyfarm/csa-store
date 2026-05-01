import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import multer from "multer";
import sharp from "sharp";
import { DeleteObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  ensureAdminAccessSchema,
  ensureAdminPricelistIndexes,
  ensureLocalLineSyncSchema,
  ensureProductPricingSchema,
  ensureVendorPricingSchema,
  getDb,
  getPool,
  isMissingTableError
} from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  dropSites,
  localLinePackageMeta,
  localLinePriceListEntries,
  localLineProductMeta,
  localLineSyncCursors,
  localLineSyncIssues,
  packagePriceListMemberships,
  packages,
  productMedia,
  productImages,
  productPricingProfiles,
  products,
  productSales,
  recipes,
  reviews,
  tags,
  users,
  vendors
} from "../schema.js";
import { requireAdmin, requireAdminPermission } from "../middleware/auth.js";
import {
  createLocalLineProductFromStoreProduct,
  fetchAllLocalLineFulfillmentStrategies,
  fetchLocalLineOrdersPage,
  isLocalLineEnabled,
  updateLocalLineForProduct
} from "../localLine.js";
import {
  getLatestLocalLinePullJob,
  getLatestLocalLinePullJobs,
  getLocalLinePullJob,
  startLocalLinePullJob
} from "../lib/localLinePullJobs.js";
import {
  getLatestLocalLineFullSyncJob,
  getLocalLineFullSyncJob,
  startLocalLineFullSyncJob
} from "../lib/localLineFullSyncJobs.js";
import {
  computeProductPricingSnapshot,
  isNoMarkupProduct,
  isSourcePricingVendor
} from "../lib/productPricing.js";
import { runLocalLineAudit } from "../scripts/auditLocalLineSync.js";
import {
  exportMasterPricelist,
  isGooglePricelistVendorName
} from "../scripts/exportMasterPricelist.js";
import {
  ADMIN_ROLE_DEFINITIONS,
  normalizeAdminRoleKeys
} from "../lib/adminRoles.js";
import { sendPasswordResetForUser } from "../lib/passwordReset.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(async (_req, _res, next) => {
  await ensureProductPricingSchema().catch((error) => {
    console.warn("Product pricing schema bootstrap skipped:", error.message);
  });
  await ensureVendorPricingSchema().catch((error) => {
    console.warn("Vendor pricing schema bootstrap skipped:", error.message);
  });
  next();
});

let spacesClient = null;

function getSpacesClient() {
  if (!spacesClient) {
    spacesClient = new S3Client({
      region: process.env.DO_SPACES_REGION || "sfo3",
      endpoint: process.env.DO_SPACES_ENDPOINT,
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET
      }
    });
  }
  return spacesClient;
}

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

function extractSpacesKeyFromPublicUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(String(url));
    const configuredPublicBase = process.env.DO_SPACES_PUBLIC_BASE_URL;
    if (configuredPublicBase) {
      const baseUrl = new URL(configuredPublicBase);
      const basePath = baseUrl.pathname.replace(/\/$/, "");
      const urlPath = parsed.pathname || "";
      if (parsed.origin === baseUrl.origin && urlPath.startsWith(`${basePath}/`)) {
        return decodeURIComponent(urlPath.slice(basePath.length + 1));
      }
    }

    const endpoint = process.env.DO_SPACES_ENDPOINT;
    const bucket = process.env.DO_SPACES_BUCKET;
    if (endpoint && bucket) {
      const endpointUrl = new URL(endpoint);
      const bucketPath = `/${bucket}/`;
      if (parsed.origin === endpointUrl.origin && parsed.pathname.startsWith(bucketPath)) {
        return decodeURIComponent(parsed.pathname.slice(bucketPath.length));
      }
      if (
        parsed.protocol === endpointUrl.protocol &&
        parsed.hostname === `${bucket}.${endpointUrl.hostname}`
      ) {
        return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      }
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function hasSpacesUploadConfig() {
  return Boolean(
    process.env.DO_SPACES_BUCKET &&
    process.env.DO_SPACES_ENDPOINT &&
    process.env.DO_SPACES_KEY &&
    process.env.DO_SPACES_SECRET
  );
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toDbDecimal(value) {
  const numeric = toNumber(value);
  return numeric === null ? null : numeric;
}

function normalizeVendorMarkupInput(value) {
  const numeric = toNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric;
}

function normalizeVendorSourceMultiplierInput(value) {
  const numeric = toNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric;
}

function isSourcePricingVendorName(value) {
  return isSourcePricingVendor({ name: value });
}

async function syncVendorPricingDefaultsForProducts(connection, vendorRecord, defaults = {}) {
  const vendorId = Number(vendorRecord?.id);
  const priceListMarkup = normalizeVendorMarkupInput(defaults.priceListMarkup);
  const sourceMultiplier = normalizeVendorSourceMultiplierInput(defaults.sourceMultiplier);
  if (!Number.isFinite(vendorId) || (!priceListMarkup && !sourceMultiplier)) {
    return 0;
  }

  const isSourceVendor = isSourcePricingVendorName(vendorRecord?.name);
  const updates = [];
  const params = [];

  if (priceListMarkup !== null) {
    updates.push(
      "pp.guest_markup = CASE WHEN LOWER(p.name) LIKE '%deposit%' THEN 0 ELSE ? END",
      "pp.member_markup = CASE WHEN LOWER(p.name) LIKE '%deposit%' THEN 0 ELSE ? END",
      "pp.herd_share_markup = CASE WHEN LOWER(p.name) LIKE '%deposit%' THEN 0 ELSE ? END",
      "pp.snap_markup = CASE WHEN LOWER(p.name) LIKE '%deposit%' THEN 0 ELSE ? END"
    );
    params.push(priceListMarkup, priceListMarkup, priceListMarkup, priceListMarkup);
  }

  if (isSourceVendor && sourceMultiplier !== null) {
    updates.push(
      "pp.source_multiplier = CASE WHEN LOWER(p.name) LIKE '%deposit%' THEN pp.source_multiplier ELSE ? END"
    );
    params.push(sourceMultiplier);
  }

  updates.push(
    "pp.remote_sync_status = 'pending'",
    "pp.remote_sync_message = 'Vendor pricing defaults updated. Apply to remote store pending.'",
    "pp.price_changed_at = NOW()",
    "pp.updated_at = NOW()"
  );
  params.push(vendorId);

  const [result] = await connection.query(
    `
      UPDATE product_pricing_profiles pp
      JOIN products p ON p.id = pp.product_id
      SET ${updates.join(", ")}
      WHERE p.vendor_id = ?
    `,
    params
  );

  return Number(result?.affectedRows || 0);
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMembershipCategoryName(value) {
  return normalizeCategoryName(value) === "membership";
}

function toActiveFlag(value) {
  return value === false || value === 0 || value === "0" ? 0 : 1;
}

function toBooleanFlag(value, fallback = false) {
  if (value === null || typeof value === "undefined" || value === "") {
    return fallback;
  }
  return Number(value) ? true : Boolean(value);
}

function toInventoryValue(value, fallback = 0) {
  const numeric = toOptionalInteger(value, fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function toOptionalInteger(value, fallback = null) {
  if (value === null || value === "" || typeof value === "undefined") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableString(value) {
  if (value === null || typeof value === "undefined") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function abbreviateRepeatDays(availability = {}) {
  const flags = [
    ["repeat_on_monday", "Mon"],
    ["repeat_on_tuesday", "Tue"],
    ["repeat_on_wednesday", "Wed"],
    ["repeat_on_thursday", "Thu"],
    ["repeat_on_friday", "Fri"],
    ["repeat_on_saturday", "Sat"],
    ["repeat_on_sunday", "Sun"]
  ];
  return flags
    .filter(([key]) => Boolean(availability?.[key]))
    .map(([, label]) => label);
}

function deriveDropSiteDayLabel(availability = {}) {
  if (!availability || typeof availability !== "object") return null;
  if (availability.type === "repeat") {
    const repeatDays = abbreviateRepeatDays(availability);
    if (repeatDays.length === 7) return "Daily";
    if (repeatDays.join(",") === "Mon,Tue,Wed,Thu,Fri") return "Weekdays";
    if (repeatDays.join(",") === "Sat,Sun") return "Weekends";
    if (repeatDays.length > 3) return "Multi-day";
    if (repeatDays.length) return repeatDays.join("/");
    if (Array.isArray(availability.repeat_on_dates) && availability.repeat_on_dates.length) {
      return "Dates";
    }
    if (availability.repeat_frequency_unit === "monthly_by_weekday_occurrence") {
      return "Monthly";
    }
    return "Repeat";
  }
  if (availability.type === "custom") return "Custom";
  if (availability.type === "flexible") return "Flexible";
  return null;
}

function deriveDropSiteTimeRange(availability = {}) {
  const timeSlots = Array.isArray(availability?.time_slots) ? availability.time_slots : [];
  if (!timeSlots.length) {
    return { openTime: null, closeTime: null };
  }

  const starts = timeSlots.map((slot) => String(slot?.start || "").trim()).filter(Boolean).sort();
  const ends = timeSlots.map((slot) => String(slot?.end || "").trim()).filter(Boolean).sort();

  return {
    openTime: starts[0] || null,
    closeTime: ends[ends.length - 1] || null
  };
}

function stringifyJson(value) {
  if (value === null || typeof value === "undefined") return null;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
}

function toDateOrNull(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      const year = Number(dateOnlyMatch[1]);
      const monthIndex = Number(dateOnlyMatch[2]) - 1;
      const day = Number(dateOnlyMatch[3]);
      const localDate = new Date(year, monthIndex, day);
      return Number.isNaN(localDate.getTime()) ? null : localDate;
    }
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatOrderCustomerName(customer = {}) {
  const fullName = [customer?.first_name, customer?.last_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  return (
    fullName ||
    toNullableString(customer?.name) ||
    toNullableString(customer?.business_name) ||
    toNullableString(customer?.email) ||
    null
  );
}

async function getLocalLineSyncCursorRow(connection, syncKey) {
  const [rows] = await connection.query(
    `
      SELECT
        sync_key AS syncKey,
        cursor_value AS cursorValue,
        synced_through_at AS syncedThroughAt,
        last_started_at AS lastStartedAt,
        last_finished_at AS lastFinishedAt,
        last_status AS lastStatus,
        last_message AS lastMessage,
        summary_json AS summaryJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM local_line_sync_cursors
      WHERE sync_key = ?
      LIMIT 1
    `,
    [syncKey]
  );
  return rows[0] || null;
}

async function upsertLocalLineSyncCursor(connection, syncKey, values = {}) {
  const now = new Date();
  await connection.query(
    `
      INSERT INTO local_line_sync_cursors (
        sync_key,
        cursor_value,
        synced_through_at,
        last_started_at,
        last_finished_at,
        last_status,
        last_message,
        summary_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        cursor_value = VALUES(cursor_value),
        synced_through_at = VALUES(synced_through_at),
        last_started_at = VALUES(last_started_at),
        last_finished_at = VALUES(last_finished_at),
        last_status = VALUES(last_status),
        last_message = VALUES(last_message),
        summary_json = VALUES(summary_json),
        updated_at = VALUES(updated_at)
    `,
    [
      syncKey,
      values.cursorValue ?? null,
      values.syncedThroughAt ?? null,
      values.lastStartedAt ?? null,
      values.lastFinishedAt ?? null,
      values.lastStatus ?? null,
      values.lastMessage ?? null,
      values.summaryJson ?? null,
      values.createdAt ?? now,
      values.updatedAt ?? now
    ]
  );
}

async function backfillLocalLineOrderFulfillmentFields(connection) {
  const [result] = await connection.query(
    `
      UPDATE local_line_orders
      SET
        fulfillment_strategy_id = COALESCE(
          fulfillment_strategy_id,
          CAST(NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.fulfillment_strategy'))), ''), 'null') AS UNSIGNED)
        ),
        fulfillment_strategy_name = COALESCE(
          NULLIF(TRIM(fulfillment_strategy_name), ''),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.fulfillment_strategy_name'))), ''), 'null')
        ),
        fulfillment_type = COALESCE(
          NULLIF(TRIM(fulfillment_type), ''),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.type_display'))), ''), 'null'),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.fulfillment_strategy_type'))), ''), 'null')
        ),
        fulfillment_status = COALESCE(
          NULLIF(TRIM(fulfillment_status), ''),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.status'))), ''), 'null')
        ),
        fulfillment_date = COALESCE(
          fulfillment_date,
          STR_TO_DATE(NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.fulfillment_date'))), ''), 'null'), '%Y-%m-%d')
        ),
        pickup_start_time = COALESCE(
          NULLIF(TRIM(pickup_start_time), ''),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.pickup_start_time'))), ''), 'null')
        ),
        pickup_end_time = COALESCE(
          NULLIF(TRIM(pickup_end_time), ''),
          NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.fulfillment.pickup_end_time'))), ''), 'null')
        ),
        updated_at = ?
      WHERE raw_json IS NOT NULL
        AND (
          fulfillment_strategy_id IS NULL OR
          fulfillment_strategy_name IS NULL OR TRIM(fulfillment_strategy_name) = '' OR
          fulfillment_type IS NULL OR TRIM(fulfillment_type) = '' OR
          fulfillment_status IS NULL OR TRIM(fulfillment_status) = '' OR
          fulfillment_date IS NULL OR
          pickup_start_time IS NULL OR
          pickup_end_time IS NULL
        )
    `,
    [new Date()]
  );
  return Number(result?.affectedRows || 0);
}

function getOrderCycleSql(alias = "o") {
  return {
    cycleType: `CASE WHEN DAYOFWEEK(${alias}.created_at_remote) IN (1, 6, 7) THEN 'tuesday' ELSE 'fridaySaturday' END`,
    cycleLabel: `CASE WHEN DAYOFWEEK(${alias}.created_at_remote) IN (1, 6, 7) THEN 'Tuesday Drops' ELSE 'Friday/Saturday Drops' END`,
    cycleStartDate: `CASE
      WHEN DAYOFWEEK(${alias}.created_at_remote) = 6 THEN DATE(${alias}.created_at_remote)
      WHEN DAYOFWEEK(${alias}.created_at_remote) = 7 THEN DATE_SUB(DATE(${alias}.created_at_remote), INTERVAL 1 DAY)
      WHEN DAYOFWEEK(${alias}.created_at_remote) = 1 THEN DATE_SUB(DATE(${alias}.created_at_remote), INTERVAL 2 DAY)
      ELSE DATE_SUB(DATE(${alias}.created_at_remote), INTERVAL DAYOFWEEK(${alias}.created_at_remote) - 2 DAY)
    END`
  };
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function startOfWeek(date) {
  const current = startOfDay(date);
  const day = current.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(current, diff);
}

function getCurrentAndLastOrderCycle(referenceDate = new Date()) {
  const current = startOfDay(referenceDate);
  const day = current.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(current, mondayOffset);
  const friday = addDays(monday, 4);
  const weekendCycle = day === 5 || day === 6 || day === 0;

  if (weekendCycle) {
    return {
      current: {
        type: "tuesday",
        label: "Tuesday Drops",
        startDate: friday
      },
      last: {
        type: "fridaySaturday",
        label: "Friday/Saturday Drops",
        startDate: monday
      }
    };
  }

  return {
    current: {
      type: "fridaySaturday",
      label: "Friday/Saturday Drops",
      startDate: monday
    },
    last: {
      type: "tuesday",
      label: "Tuesday Drops",
      startDate: addDays(monday, -3)
    }
  };
}

function formatMonthKey(value) {
  const date = toDateOrNull(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function formatDateKey(value) {
  const date = toDateOrNull(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseJsonValue(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function getJsonTrimmedStringSql(orderAlias = "o", jsonPath = "$") {
  return `NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${orderAlias}.raw_json, '${jsonPath}'))), ''), 'null')`;
}

function getFulfillmentStrategyIdSql(orderAlias = "o") {
  return `COALESCE(${orderAlias}.fulfillment_strategy_id, CAST(${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_strategy")} AS UNSIGNED))`;
}

function getFulfillmentTypeSql(orderAlias = "o") {
  return `COALESCE(NULLIF(TRIM(${orderAlias}.fulfillment_type), ''), ${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.type_display")}, ${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_strategy_type")}, 'Unknown')`;
}

function getFulfillmentStatusSql(orderAlias = "o") {
  return `COALESCE(NULLIF(TRIM(${orderAlias}.fulfillment_status), ''), ${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.status")}, 'Unknown')`;
}

function getFulfillmentDateSql(orderAlias = "o") {
  return `COALESCE(${orderAlias}.fulfillment_date, STR_TO_DATE(${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_date")}, '%Y-%m-%d'))`;
}

function getPickupTimeSql(orderAlias = "o", fieldName) {
  return `COALESCE(NULLIF(TRIM(${orderAlias}.${fieldName}), ''), ${getJsonTrimmedStringSql(orderAlias, `$.fulfillment.${fieldName}`)})`;
}

function getFulfillmentSiteNameSql(orderAlias = "o", dropSiteAlias = "ds") {
  return `COALESCE(NULLIF(TRIM(${orderAlias}.fulfillment_strategy_name), ''), ${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_strategy_name")}, NULLIF(TRIM(${dropSiteAlias}.name), ''), 'Unassigned')`;
}

function isMembershipPurchaseDropSite(site = {}) {
  const name = String(site?.name || "").trim().toLowerCase();
  if (name.includes("membership purchase")) return true;

  const raw = parseJsonValue(site?.rawJson || site?.raw_json, {});
  const formattedAddress = String(
    raw?.address?.formatted_address ||
    raw?.address?.street_address ||
    site?.address ||
    ""
  ).trim().toLowerCase();
  const instructions = String(
    raw?.availability?.instructions ||
    site?.instructions ||
    ""
  ).trim().toLowerCase();

  return (
    formattedAddress.includes("online delivery") &&
    instructions.includes("subscribing to a full farm csa membership")
  );
}

function stripHtmlToText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHostContactName(value) {
  const cleaned = String(value || "")
    .replace(/^[,;:.\s]+|[,;:.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const lowered = cleaned.toLowerCase();
  if (
    lowered.includes("dropsite") ||
    lowered.includes("host info") ||
    lowered.includes("call ") ||
    lowered.includes("text ") ||
    lowered.includes("reach out") ||
    lowered.includes("csa manager at")
  ) {
    return null;
  }

  return cleaned;
}

function extractDropSiteHostContact(site = {}) {
  const raw = parseJsonValue(site?.rawJson || site?.raw_json, {});
  const instructionText = stripHtmlToText(
    raw?.availability?.instructions ||
    site?.instructions ||
    ""
  );
  if (!instructionText) return null;

  const phonePattern = String.raw`(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})`;
  const patterns = [
    new RegExp(String.raw`hosts?\s+info\s+is:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*[,;]?\s*(${phonePattern})`, "i"),
    new RegExp(String.raw`reach out to (?:your )?host,\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*,?\s*at\s*(${phonePattern})`, "i"),
    new RegExp(String.raw`reach out to (?:the )?host(?: and csa manager)?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+at\s+(${phonePattern})`, "i"),
    new RegExp(String.raw`call or text\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*(${phonePattern})`, "i"),
    new RegExp(String.raw`text\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+at\s+(${phonePattern})`, "i"),
    new RegExp(String.raw`host(?: and csa manager)?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+at\s+(${phonePattern})`, "i")
  ];

  for (const pattern of patterns) {
    const match = instructionText.match(pattern);
    if (!match) continue;
    const contactName = normalizeHostContactName(match[1]);
    const phone = String(match[2] || "").trim();
    if (!phone) continue;
    if (!contactName) {
      return {
        name: null,
        phone,
        source: "instructions"
      };
    }
    return {
      name: contactName,
      phone,
      source: "instructions"
    };
  }

  return null;
}

function parseMonthKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  return {
    year,
    monthIndex,
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    start: new Date(year, monthIndex, 1),
    end: new Date(year, monthIndex + 1, 1)
  };
}

function isDateInMonth(date, monthInfo) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !monthInfo) return false;
  return date >= monthInfo.start && date < monthInfo.end;
}

function isDateInRange(date, rangeStart, rangeEnd) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  return date >= rangeStart && date < rangeEnd;
}

function countAvailableDatesInMonth(availability = {}, monthInfo) {
  const dates = Array.isArray(availability?.available_dates) ? availability.available_dates : [];
  const matchingDates = new Set();
  for (const item of dates) {
    const parsed = toDateOrNull(item?.available_date);
    if (isDateInMonth(parsed, monthInfo)) {
      matchingDates.add(formatDateKey(parsed));
    }
  }
  return matchingDates.size;
}

function countCustomDatesInMonth(availability = {}, monthInfo) {
  const dates = Array.isArray(availability?.custom_dates) ? availability.custom_dates : [];
  const matchingDates = new Set();
  for (const item of dates) {
    const parsed = toDateOrNull(item?.available_date || item?.date || item);
    if (isDateInMonth(parsed, monthInfo)) {
      matchingDates.add(formatDateKey(parsed));
    }
  }
  return matchingDates.size;
}

function getAvailabilityWeekdayNumbers(availability = {}) {
  const pairs = [
    ["repeat_on_sunday", 0],
    ["repeat_on_monday", 1],
    ["repeat_on_tuesday", 2],
    ["repeat_on_wednesday", 3],
    ["repeat_on_thursday", 4],
    ["repeat_on_friday", 5],
    ["repeat_on_saturday", 6]
  ];
  return pairs.filter(([key]) => Boolean(availability?.[key])).map(([, value]) => value);
}

function getWeekdayNumbersFromDayLabel(value) {
  const normalized = String(value || "").toLowerCase();
  const matches = [];
  const pairs = [
    ["sun", 0],
    ["mon", 1],
    ["tue", 2],
    ["wed", 3],
    ["thu", 4],
    ["fri", 5],
    ["sat", 6]
  ];
  for (const [token, weekday] of pairs) {
    if (normalized.includes(token)) {
      matches.push(weekday);
    }
  }
  return [...new Set(matches)];
}

function countWeekdayOccurrencesInMonth(monthInfo, weekdayNumbers = [], repeatStartDate = null) {
  if (!monthInfo || !weekdayNumbers.length) return 0;
  const allowedWeekdays = new Set(weekdayNumbers);
  const startDate = toDateOrNull(repeatStartDate);
  let count = 0;

  for (let day = 1; day <= 31; day += 1) {
    const current = new Date(monthInfo.year, monthInfo.monthIndex, day);
    if (current.getMonth() !== monthInfo.monthIndex) break;
    if (startDate && current < startDate) continue;
    if (allowedWeekdays.has(current.getDay())) {
      count += 1;
    }
  }

  return count;
}

function countMonthlyDateOccurrences(monthInfo, repeatOnDates = [], repeatStartDate = null) {
  if (!monthInfo || !Array.isArray(repeatOnDates) || !repeatOnDates.length) return 0;
  const startDate = toDateOrNull(repeatStartDate);
  let count = 0;

  for (const dateValue of repeatOnDates) {
    const day = Number(dateValue);
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    const current = new Date(monthInfo.year, monthInfo.monthIndex, day);
    if (current.getMonth() !== monthInfo.monthIndex) continue;
    if (startDate && current < startDate) continue;
    count += 1;
  }

  return count;
}

function countAvailableDatesInRange(availability = {}, rangeStart, rangeEnd) {
  const dates = Array.isArray(availability?.available_dates) ? availability.available_dates : [];
  const matchingDates = new Set();
  for (const item of dates) {
    const parsed = toDateOrNull(item?.available_date);
    if (isDateInRange(parsed, rangeStart, rangeEnd)) {
      matchingDates.add(formatDateKey(parsed));
    }
  }
  return matchingDates.size;
}

function countCustomDatesInRange(availability = {}, rangeStart, rangeEnd) {
  const dates = Array.isArray(availability?.custom_dates) ? availability.custom_dates : [];
  const matchingDates = new Set();
  for (const item of dates) {
    const parsed = toDateOrNull(item?.available_date || item?.date || item);
    if (isDateInRange(parsed, rangeStart, rangeEnd)) {
      matchingDates.add(formatDateKey(parsed));
    }
  }
  return matchingDates.size;
}

function countWeekdayOccurrencesInRange(rangeStart, rangeEnd, weekdayNumbers = [], repeatStartDate = null) {
  if (!weekdayNumbers.length) return 0;
  const allowedWeekdays = new Set(weekdayNumbers);
  const startDate = toDateOrNull(repeatStartDate);
  let count = 0;
  for (let current = new Date(rangeStart); current < rangeEnd; current = addDays(current, 1)) {
    if (startDate && current < startDate) continue;
    if (allowedWeekdays.has(current.getDay())) {
      count += 1;
    }
  }
  return count;
}

function countMonthlyDateOccurrencesInRange(rangeStart, rangeEnd, repeatOnDates = [], repeatStartDate = null) {
  if (!Array.isArray(repeatOnDates) || !repeatOnDates.length) return 0;
  const validDays = new Set(
    repeatOnDates
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 1 && value <= 31)
  );
  if (!validDays.size) return 0;
  const startDate = toDateOrNull(repeatStartDate);
  let count = 0;
  for (let current = new Date(rangeStart); current < rangeEnd; current = addDays(current, 1)) {
    if (startDate && current < startDate) continue;
    if (validDays.has(current.getDate())) {
      count += 1;
    }
  }
  return count;
}

function getDropSiteScheduledDropCountForRange(site = {}, rangeStart, rangeEnd, fallbackOrderDates = []) {
  const availability =
    parseJsonValue(site?.availabilityJson || site?.availability_json, null) ||
    parseJsonValue(site?.rawJson || site?.raw_json, {})?.availability ||
    {};

  const customDateCount = countCustomDatesInRange(availability, rangeStart, rangeEnd);
  if (customDateCount > 0) return customDateCount;

  const repeatOnDates = Array.isArray(availability?.repeat_on_dates) ? availability.repeat_on_dates : [];
  const repeatStartDate = availability?.repeat_start_date || null;
  const monthlyDateCount = countMonthlyDateOccurrencesInRange(
    rangeStart,
    rangeEnd,
    repeatOnDates,
    repeatStartDate
  );
  if (monthlyDateCount > 0) return monthlyDateCount;

  const weekdayNumbers = getAvailabilityWeekdayNumbers(availability);
  const weeklyCount = countWeekdayOccurrencesInRange(rangeStart, rangeEnd, weekdayNumbers, repeatStartDate);
  if (weeklyCount > 0) return weeklyCount;

  const availableDateCount = countAvailableDatesInRange(availability, rangeStart, rangeEnd);
  if (availableDateCount > 0) return availableDateCount;

  const labelWeekdays = getWeekdayNumbersFromDayLabel(site?.dayOfWeek);
  const labelWeekdayCount = countWeekdayOccurrencesInRange(rangeStart, rangeEnd, labelWeekdays);
  if (labelWeekdayCount > 0) return labelWeekdayCount;

  return new Set(
    (fallbackOrderDates || [])
      .filter((value) => isDateInRange(value, rangeStart, rangeEnd))
      .map((value) => formatDateKey(value))
      .filter(Boolean)
  ).size;
}

function getDropSiteScheduledDropCount(site = {}, monthKey, fallbackOrderDates = []) {
  const monthInfo = parseMonthKey(monthKey);
  if (!monthInfo) return 0;
  return getDropSiteScheduledDropCountForRange(
    site,
    monthInfo.start,
    monthInfo.end,
    fallbackOrderDates
  );
}

function getDropSitePerformanceTier(averageWeeklyOrders) {
  const numeric = Number(averageWeeklyOrders) || 0;
  if (numeric > 5) return "good";
  if (numeric >= 4) return "warn";
  return "bad";
}

function normalizeDraftPackage(payload = {}, fallbackName = "ea") {
  const price = Number(payload.price);
  return {
    name: String(payload.name || fallbackName).trim() || fallbackName,
    price: Number.isFinite(price) ? Number(price.toFixed(2)) : NaN,
    packageCode: toNullableString(payload.packageCode),
    unit: toNullableString(payload.unit),
    numOfItems: toOptionalInteger(payload.numOfItems, 1) || 1,
    visible: payload.visible === false || payload.visible === 0 || payload.visible === "0" ? 0 : 1,
    trackInventory:
      payload.trackInventory === true || payload.trackInventory === 1 || payload.trackInventory === "1"
        ? 1
        : 0,
    inventory: toOptionalInteger(payload.inventory, 0) || 0,
    trackType: toNullableString(payload.trackType) || "package",
    chargeType: toNullableString(payload.chargeType) || "package"
  };
}

async function getNextManualId(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM ${tableName}`
  );
  return Number(rows?.[0]?.nextId || 1);
}

async function upsertLocalOnlyProductMeta(db, productId, productRow = {}) {
  const now = new Date();
  const existingRows = await db
    .select()
    .from(localLineProductMeta)
    .where(eq(localLineProductMeta.productId, productId))
    .catch(() => []);

  const payload = {
    localLineProductId: 0,
    status: "local-only",
    visible: typeof productRow.visible === "undefined" ? null : Number(productRow.visible) ? 1 : 0,
    trackInventory:
      typeof productRow.trackInventory === "undefined"
        ? null
        : Number(productRow.trackInventory)
          ? 1
          : 0,
    inventoryType: "package",
    productInventory: toOptionalInteger(productRow.inventory, 0),
    packageCodesEnabled: 0,
    rawJson: null,
    updatedAt: now,
    lastSyncedAt: null
  };

  if (existingRows.length) {
    await db
      .update(localLineProductMeta)
      .set(payload)
      .where(eq(localLineProductMeta.productId, productId));
    return;
  }

  await db.insert(localLineProductMeta).values({
    productId,
    createdAt: now,
    ...payload
  });
}

async function createLocalProductRecord(connection, payload) {
  const now = new Date();
  const productId = await getNextManualId(connection, "products");
  const normalizedPackages = (Array.isArray(payload.packages) ? payload.packages : [])
    .map((pkg, index) => normalizeDraftPackage(pkg, index === 0 ? "ea" : `Package ${index + 1}`))
    .filter((pkg) => Number.isFinite(pkg.price));

  if (!normalizedPackages.length) {
    throw new Error("At least one package with a valid price is required");
  }

  const productRecord = {
    id: productId,
    name: String(payload.name || "").trim(),
    description: payload.description || "",
    visible: payload.visible ? 1 : 0,
    trackInventory: payload.trackInventory ? 1 : 0,
    inventory: toOptionalInteger(payload.inventory, 0) || 0,
    categoryId: toOptionalInteger(payload.categoryId, null),
    vendorId: toOptionalInteger(payload.vendorId, null),
    thumbnailUrl: toNullableString(payload.thumbnailUrl),
    createdAt: now,
    updatedAt: now,
    isDeleted: 0
  };

  if (!productRecord.name) {
    throw new Error("Product name is required");
  }

  await connection.query(
    `
      INSERT INTO products (
        id, name, description, visible, track_inventory, inventory,
        category_id, vendor_id, thumbnail_url, created_at, updated_at, is_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      productRecord.id,
      productRecord.name,
      productRecord.description,
      productRecord.visible,
      productRecord.trackInventory,
      productRecord.inventory,
      productRecord.categoryId,
      productRecord.vendorId,
      productRecord.thumbnailUrl,
      productRecord.createdAt,
      productRecord.updatedAt,
      productRecord.isDeleted
    ]
  );

  let nextPackageId = await getNextManualId(connection, "packages");
  const createdPackages = [];
  for (const draftPackage of normalizedPackages) {
    const packageRecord = {
      id: nextPackageId,
      productId,
      name: draftPackage.name,
      price: draftPackage.price,
      packageCode: draftPackage.packageCode,
      unit: draftPackage.unit,
      numOfItems: draftPackage.numOfItems,
      trackType: draftPackage.trackType,
      chargeType: draftPackage.chargeType,
      visible: draftPackage.visible,
      trackInventory: draftPackage.trackInventory,
      inventory: draftPackage.inventory
    };
    createdPackages.push(packageRecord);
    nextPackageId += 1;
  }

  for (const pkg of createdPackages) {
    await connection.query(
      `
        INSERT INTO packages (
          id, product_id, name, price, package_code, unit, num_of_items,
          track_type, charge_type, visible, track_inventory, inventory
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        pkg.id,
        pkg.productId,
        pkg.name,
        pkg.price,
        pkg.packageCode,
        pkg.unit,
        pkg.numOfItems,
        pkg.trackType,
        pkg.chargeType,
        pkg.visible,
        pkg.trackInventory,
        pkg.inventory
      ]
    );
  }

  await connection.query(
    `
      INSERT INTO product_sales (product_id, on_sale, sale_discount, updated_at)
      VALUES (?, ?, ?, ?)
    `,
    [
      productId,
      payload.onSale ? 1 : 0,
      typeof payload.saleDiscount === "number" ? payload.saleDiscount : 0,
      now
    ]
  );

  return {
    productId,
    productRecord,
    packages: createdPackages
  };
}

function normalizePricingUnitOfMeasure(value) {
  return String(value || "each").trim().toLowerCase() === "lbs" ? "lbs" : "each";
}

function normalizePricingProfileInput(payload = {}) {
  return {
    unitOfMeasure:
      typeof payload.unitOfMeasure === "undefined"
        ? undefined
        : normalizePricingUnitOfMeasure(payload.unitOfMeasure),
    sourceUnitPrice:
      typeof payload.sourceUnitPrice === "undefined"
        ? undefined
        : (payload.sourceUnitPrice === null ? null : Number(payload.sourceUnitPrice)),
    minWeight:
      typeof payload.minWeight === "undefined"
        ? undefined
        : (payload.minWeight === null ? null : Number(payload.minWeight)),
    maxWeight:
      typeof payload.maxWeight === "undefined"
        ? undefined
        : (payload.maxWeight === null ? null : Number(payload.maxWeight)),
    avgWeightOverride:
      typeof payload.avgWeightOverride === "undefined"
        ? undefined
        : (payload.avgWeightOverride === null ? null : Number(payload.avgWeightOverride)),
    sourceMultiplier:
      typeof payload.sourceMultiplier === "undefined"
        ? undefined
        : (payload.sourceMultiplier === null ? null : Number(payload.sourceMultiplier))
  };
}

function validateSourcePricingProfile(pricingProfile) {
  const sourceUnitPrice = toNumber(pricingProfile.sourceUnitPrice);
  if (sourceUnitPrice === null || sourceUnitPrice <= 0) {
    throw new Error("DFF source price is required for source-pricing vendors.");
  }
}

async function upsertProductPricingProfileRecord(connection, productId, payload = {}, options = {}) {
  const now = new Date();
  const normalized = normalizePricingProfileInput(payload);
  const vendorSourceMultiplier =
    isSourcePricingVendor(options.vendor)
      ? normalizeVendorSourceMultiplierInput(options.vendor?.sourceMultiplier)
      : null;
  const [existingRows] = await connection.query(
    "SELECT * FROM product_pricing_profiles WHERE product_id = ? LIMIT 1",
    [productId]
  );
  const existing = existingRows[0] || null;

  const record = {
    unit_of_measure: normalized.unitOfMeasure ?? existing?.unit_of_measure ?? "each",
    source_unit_price:
      typeof normalized.sourceUnitPrice === "undefined"
        ? (existing?.source_unit_price ?? null)
        : normalized.sourceUnitPrice,
    min_weight:
      typeof normalized.minWeight === "undefined"
        ? (existing?.min_weight ?? null)
        : normalized.minWeight,
    max_weight:
      typeof normalized.maxWeight === "undefined"
        ? (existing?.max_weight ?? null)
        : normalized.maxWeight,
    avg_weight_override:
      typeof normalized.avgWeightOverride === "undefined"
        ? (existing?.avg_weight_override ?? null)
        : normalized.avgWeightOverride,
    source_multiplier:
      vendorSourceMultiplier !== null
        ? vendorSourceMultiplier
        : (
            typeof normalized.sourceMultiplier === "undefined" ||
            normalized.sourceMultiplier === null ||
            !Number.isFinite(Number(normalized.sourceMultiplier))
              ? (existing?.source_multiplier ?? 0.5412)
              : normalized.sourceMultiplier
          ),
    price_changed_at: now,
    remote_sync_status: "pending",
    remote_sync_message: "Local source pricing updated. Apply to remote store pending.",
    remote_synced_at: null,
    updated_at: now
  };

  if (existing) {
    await connection.query(
      `
        UPDATE product_pricing_profiles
        SET unit_of_measure = ?, source_unit_price = ?, min_weight = ?, max_weight = ?,
            avg_weight_override = ?, source_multiplier = ?, price_changed_at = ?,
            remote_sync_status = ?, remote_sync_message = ?, remote_synced_at = ?, updated_at = ?
        WHERE product_id = ?
      `,
      [
        record.unit_of_measure,
        record.source_unit_price,
        record.min_weight,
        record.max_weight,
        record.avg_weight_override,
        record.source_multiplier,
        record.price_changed_at,
        record.remote_sync_status,
        record.remote_sync_message,
        record.remote_synced_at,
        record.updated_at,
        productId
      ]
    );
    return;
  }

  await connection.query(
    `
      INSERT INTO product_pricing_profiles (
        product_id, unit_of_measure, source_unit_price, min_weight, max_weight,
        avg_weight_override, source_multiplier, on_sale, sale_discount, price_changed_at,
        remote_sync_status, remote_sync_message, remote_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      productId,
      record.unit_of_measure,
      record.source_unit_price,
      record.min_weight,
      record.max_weight,
      record.avg_weight_override,
      record.source_multiplier,
      0,
      0,
      record.price_changed_at,
      record.remote_sync_status,
      record.remote_sync_message,
      record.remote_synced_at,
      now,
      now
    ]
  );
}

async function markProductRemoteSyncPending(connection, productId, message) {
  const now = new Date();
  const remoteSyncMessage =
    String(message || "").trim() || "Local changes updated. Apply to remote store pending.";
  const [existingRows] = await connection.query(
    "SELECT product_id FROM product_pricing_profiles WHERE product_id = ? LIMIT 1",
    [productId]
  );

  if (existingRows[0]) {
    await connection.query(
      `
        UPDATE product_pricing_profiles
        SET remote_sync_status = ?, remote_sync_message = ?, remote_synced_at = ?, updated_at = ?
        WHERE product_id = ?
      `,
      ["pending", remoteSyncMessage, null, now, productId]
    );
    return;
  }

  await connection.query(
    `
      INSERT INTO product_pricing_profiles (
        product_id, unit_of_measure, source_unit_price, min_weight, max_weight,
        avg_weight_override, source_multiplier, on_sale, sale_discount,
        remote_sync_status, remote_sync_message, remote_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      productId,
      "each",
      null,
      null,
      null,
      null,
      0.5412,
      0,
      0,
      "pending",
      remoteSyncMessage,
      null,
      now,
      now
    ]
  );
}

async function duplicateLocalProductRecord(connection, sourceProductId) {
  const [productRows] = await connection.query(
    "SELECT * FROM products WHERE id = ? LIMIT 1",
    [sourceProductId]
  );
  const sourceProduct = productRows[0];
  if (!sourceProduct) {
    throw new Error("Product not found");
  }

  const [packageRows] = await connection.query(
    "SELECT * FROM packages WHERE product_id = ? ORDER BY id",
    [sourceProductId]
  );
  const [saleRows] = await connection.query(
    "SELECT * FROM product_sales WHERE product_id = ? LIMIT 1",
    [sourceProductId]
  );
  const [profileRows] = await connection.query(
    "SELECT * FROM product_pricing_profiles WHERE product_id = ? LIMIT 1",
    [sourceProductId]
  );
  const [vendorRows] = sourceProduct.vendor_id
    ? await connection.query(
        `
          SELECT
            member_markup AS memberMarkup,
            price_list_markup AS priceListMarkup,
            source_multiplier AS sourceMultiplier
          FROM vendors
          WHERE id = ? LIMIT 1
        `,
        [sourceProduct.vendor_id]
      )
    : [[]];
  const [imageRows] = await connection.query(
    "SELECT url, url_hash FROM product_images WHERE product_id = ? ORDER BY id",
    [sourceProductId]
  );
  const [mediaRows] = await connection.query(
    `
      SELECT source_url, remote_url, storage_key, public_url, thumbnail_url, sort_order,
             is_primary, alt_text, content_hash, width, height, mime_type
      FROM product_media
      WHERE product_id = ?
      ORDER BY sort_order, id
    `,
    [sourceProductId]
  );
  const [tagRows] = await connection.query(
    "SELECT tag_id AS tagId FROM product_tags WHERE product_id = ?",
    [sourceProductId]
  );
  const created = await createLocalProductRecord(connection, {
    name: `${sourceProduct.name} Copy`,
    description: sourceProduct.description || "",
    visible: Boolean(sourceProduct.visible),
    trackInventory: Boolean(sourceProduct.track_inventory),
    inventory: Number(sourceProduct.inventory || 0),
    categoryId: sourceProduct.category_id,
    vendorId: sourceProduct.vendor_id,
    thumbnailUrl: sourceProduct.thumbnail_url,
    onSale: Boolean(saleRows[0]?.on_sale),
    saleDiscount:
      saleRows[0]?.sale_discount === null || typeof saleRows[0]?.sale_discount === "undefined"
        ? 0
        : Number(saleRows[0].sale_discount),
    packages: packageRows.map((pkg) => ({
      name: pkg.name,
      price: Number(pkg.price),
      packageCode: pkg.package_code,
      unit: pkg.unit,
      numOfItems: pkg.num_of_items,
      visible: pkg.visible,
      trackInventory: pkg.track_inventory,
      inventory: pkg.inventory,
      trackType: pkg.track_type,
      chargeType: pkg.charge_type
    }))
  });

  const now = new Date();
  const profile = profileRows[0] || null;
  const vendor = vendorRows[0] || null;
  const forceNoMarkup = isNoMarkupProduct({ name: created.productRecord.name });
  const defaultCsaMarkup = forceNoMarkup
    ? 0
    : (
        Number.isFinite(Number(vendor?.priceListMarkup))
          ? Number(vendor.priceListMarkup)
          : Number.isFinite(Number(vendor?.memberMarkup))
            ? Number(vendor.memberMarkup)
          : (Number.isFinite(Number(profile?.member_markup)) ? Number(profile.member_markup) : 0.4)
      );
  const defaultSaleDiscount =
    profile?.sale_discount === null || typeof profile?.sale_discount === "undefined"
      ? (
          saleRows[0]?.sale_discount === null || typeof saleRows[0]?.sale_discount === "undefined"
            ? 0
            : Number(saleRows[0].sale_discount)
        )
      : Number(profile.sale_discount);

  await connection.query(
    `
      INSERT INTO product_pricing_profiles (
        product_id, unit_of_measure, source_unit_price, min_weight, max_weight,
        avg_weight_override, source_multiplier, guest_markup, member_markup,
        herd_share_markup, snap_markup, on_sale, sale_discount,
        price_changed_at, remote_sync_status, remote_sync_message, remote_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      created.productId,
      profile?.unit_of_measure || "each",
      profile?.source_unit_price ?? null,
      profile?.min_weight ?? null,
      profile?.max_weight ?? null,
      profile?.avg_weight_override ?? null,
      Number.isFinite(Number(vendor?.sourceMultiplier))
        ? Number(vendor.sourceMultiplier)
        : (Number.isFinite(Number(profile?.source_multiplier)) ? Number(profile.source_multiplier) : 0.5412),
      defaultCsaMarkup,
      defaultCsaMarkup,
      defaultCsaMarkup,
      defaultCsaMarkup,
      profile ? profile.on_sale : (saleRows[0]?.on_sale ? 1 : 0),
      defaultSaleDiscount,
      now,
      "pending",
      "Duplicate created with default CSA markup applied to all price lists. Apply to remote store pending.",
      null,
      now,
      now
    ]
  );

  for (const row of imageRows) {
    await connection.query(
      "INSERT INTO product_images (product_id, url, url_hash) VALUES (?, ?, ?)",
      [created.productId, row.url, row.url_hash]
    );
  }

  for (const row of mediaRows) {
    await connection.query(
      `
        INSERT INTO product_media (
          product_id, source, source_media_id, source_url, remote_url, storage_key,
          public_url, thumbnail_url, sort_order, is_primary, alt_text, content_hash,
          width, height, mime_type, created_at, updated_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        created.productId,
        "local-copy",
        null,
        row.source_url,
        row.remote_url,
        row.storage_key,
        row.public_url,
        row.thumbnail_url,
        row.sort_order,
        row.is_primary,
        row.alt_text,
        row.content_hash,
        row.width,
        row.height,
        row.mime_type,
        now,
        now,
        null
      ]
    );
  }

  for (const row of tagRows) {
    await connection.query(
      "INSERT INTO product_tags (product_id, tag_id) VALUES (?, ?)",
      [created.productId, row.tagId]
    );
  }

  return created;
}

async function deleteLocalOnlyProductRecord(connection, productId) {
  const [productRows] = await connection.query(
    "SELECT id FROM products WHERE id = ? LIMIT 1",
    [productId]
  );
  if (!productRows[0]) {
    throw new Error("Product not found");
  }

  const [productMetaRows] = await connection.query(
    "SELECT local_line_product_id AS localLineProductId FROM local_line_product_meta WHERE product_id = ? LIMIT 1",
    [productId]
  ).catch((error) => {
    if (isMissingTableError(error, "local_line_product_meta")) return [[]];
    throw error;
  });
  if (Number(productMetaRows?.[0]?.localLineProductId || 0) > 0) {
    throw new Error("Only local-only products can be deleted. This product is linked to Local Line.");
  }

  const [packageRows] = await connection.query(
    "SELECT id FROM packages WHERE product_id = ?",
    [productId]
  );
  const packageIds = packageRows
    .map((row) => Number(row.id))
    .filter((value) => Number.isFinite(value));

  if (packageIds.length) {
    const placeholders = packageIds.map(() => "?").join(", ");
    await connection.query(
      `DELETE FROM package_price_list_memberships WHERE package_id IN (${placeholders})`,
      packageIds
    );
  }

  await connection.query("DELETE FROM product_price_list_memberships WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM product_pricing_profiles WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM product_sales WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM product_images WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM product_tags WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM reviews WHERE product_id = ?", [productId]);
  await connection.query("DELETE FROM packages WHERE product_id = ?", [productId]);

  await connection.query("DELETE FROM local_line_price_list_entries WHERE product_id = ?", [productId]).catch((error) => {
    if (isMissingTableError(error, "local_line_price_list_entries")) return;
    throw error;
  });
  await connection.query("DELETE FROM local_line_package_meta WHERE product_id = ?", [productId]).catch((error) => {
    if (isMissingTableError(error, "local_line_package_meta")) return;
    throw error;
  });
  await connection.query("DELETE FROM local_line_sync_issues WHERE product_id = ?", [productId]).catch((error) => {
    if (isMissingTableError(error, "local_line_sync_issues")) return;
    throw error;
  });
  await connection.query("DELETE FROM product_media WHERE product_id = ?", [productId]).catch((error) => {
    if (isMissingTableError(error, "product_media")) return;
    throw error;
  });
  await connection.query("DELETE FROM local_line_product_meta WHERE product_id = ?", [productId]).catch((error) => {
    if (isMissingTableError(error, "local_line_product_meta")) return;
    throw error;
  });
  await connection.query("DELETE FROM products WHERE id = ?", [productId]);

  return { productId };
}

async function loadAdminRoleKeysForUser(userId) {
  if (!Number.isFinite(Number(userId))) return [];
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT r.role_key AS roleKey
      FROM admin_user_roles ur
      JOIN admin_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key
    `,
    [Number(userId)]
  );
  return rows.map((row) => row.roleKey).filter(Boolean);
}

async function replaceAdminRolesForUser(userId, roleKeys) {
  const normalized = normalizeAdminRoleKeys(roleKeys);
  const pool = getPool();
  await ensureAdminAccessSchema();
  await pool.query("DELETE FROM admin_user_roles WHERE user_id = ?", [userId]);
  if (!normalized.length) return normalized;
  await pool.query(
    `
      INSERT INTO admin_user_roles (user_id, role_id, created_at)
      SELECT ?, id, ?
      FROM admin_roles
      WHERE role_key IN (?)
    `,
    [userId, new Date(), normalized]
  );
  return normalized;
}

async function countOtherActiveFullAdmins(userId) {
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT COUNT(*) AS count
      FROM users u
      JOIN admin_user_roles ur ON ur.user_id = u.id
      JOIN admin_roles r ON r.id = ur.role_id
      WHERE r.role_key = 'admin'
        AND COALESCE(u.active, 1) = 1
        AND u.id <> ?
    `,
    [Number(userId) || 0]
  );
  return Number(rows[0]?.count || 0);
}

async function assertAdminRoleChangeSafe(userId, active, roleKeys) {
  const normalized = normalizeAdminRoleKeys(roleKeys);
  if (active && normalized.includes("admin")) return;
  const otherAdmins = await countOtherActiveFullAdmins(userId);
  if (otherAdmins <= 0) {
    const error = new Error("At least one active full admin user is required.");
    error.status = 400;
    throw error;
  }
}

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const { password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    const db = getDb();
    await ensureAdminAccessSchema().catch((error) => {
      console.warn("Admin access schema bootstrap skipped for /admin/login:", error.message);
    });
    const rows = await db.select().from(users).where(eq(users.username, username));
    if (!rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (rows[0].active === 0) {
      return res.status(403).json({ error: "User is inactive" });
    }

    const valid = await bcrypt.compare(password, rows[0].passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const adminRoles = await loadAdminRoleKeysForUser(Number(rows[0].id));
    const hasLegacyAdminRole = rows[0].role === "administrator" || rows[0].role === "admin";
    if (!hasLegacyAdminRole && !adminRoles.length) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const token = jwt.sign(
      { adminId: rows[0].id, userId: rows[0].id, role: rows[0].role, adminRoles },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "30d" }
    );

    return res.json({
      token,
      user: {
        id: rows[0].id,
        username: rows[0].username,
        email: rows[0].email,
        name: rows[0].name || "",
        role: rows[0].role,
        adminRoles
      }
    });
  } catch (error) {
    console.error("Admin login failed:", error.message);
    return res.status(500).json({ error: "Server login error" });
  }
});

router.get("/me", requireAdmin, async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const userId = Number(req.admin?.userId || req.admin?.adminId);
  const rows = await db.select().from(users).where(eq(users.id, userId));
  if (!rows.length) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({
    user: {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      name: rows[0].name || "",
      role: rows[0].role,
      active: rows[0].active !== 0,
      adminRoles: await loadAdminRoleKeysForUser(Number(rows[0].id))
    }
  });
});

router.get("/admin-users", requireAdminPermission("user_admin"), async (_req, res) => {
  await ensureAdminAccessSchema();
  const [userRows] = await getPool().query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.name,
        u.role,
        COALESCE(u.active, 1) AS active,
        u.timesheets_user_id AS timesheetsUserId,
        u.timesheets_employee_id AS timesheetsEmployeeId,
        u.created_at AS createdAt,
        u.updated_at AS updatedAt,
        GROUP_CONCAT(r.role_key ORDER BY r.role_key SEPARATOR ',') AS adminRoleKeys
      FROM users u
      JOIN admin_user_roles ur ON ur.user_id = u.id
      JOIN admin_roles r ON r.id = ur.role_id
      GROUP BY u.id
      ORDER BY u.username
    `
  );

  res.json({
    roles: ADMIN_ROLE_DEFINITIONS,
    users: userRows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      name: row.name || "",
      role: row.role,
      active: Boolean(row.active),
      timesheetsUserId: row.timesheetsUserId || "",
      timesheetsEmployeeId: row.timesheetsEmployeeId || "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      adminRoles: String(row.adminRoleKeys || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    }))
  });
});

router.post("/admin-users", requireAdminPermission("user_admin"), async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const payload = req.body || {};
  const username = String(payload.username || "").trim();
  const email = String(payload.email || "").trim().toLowerCase() || null;
  const adminRoles = normalizeAdminRoleKeys(payload.adminRoles);

  if (!username || !adminRoles.length) {
    return res.status(400).json({ error: "Username and at least one role are required." });
  }
  if (email && !isEmailAddress(email)) {
    return res.status(400).json({ error: "Password reset email must be a valid email address." });
  }

  const existing = await db.select().from(users).where(eq(users.username, username));
  if (existing.length) {
    return res.status(409).json({ error: "A user with this username already exists." });
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const active = toActiveFlag(payload.active);
  const name = String(payload.name || "").trim() || null;
  const result = await db.insert(users).values({
    username,
    email,
    passwordHash,
    name,
    role: adminRoles.includes("admin") ? "admin" : "member",
    active,
    timesheetsUserId: payload.timesheetsUserId || null,
    timesheetsEmployeeId: payload.timesheetsEmployeeId || null,
    createdAt: now,
    updatedAt: now
  });

  const userId = Number(result[0]?.insertId);
  await replaceAdminRolesForUser(userId, adminRoles);

  let resetResult = { emailSent: false, emailReason: "User is inactive." };
  if (active && !isEmailAddress(email)) {
    resetResult = { emailSent: false, emailReason: "Password reset email is not set." };
  } else if (active) {
    resetResult = await sendPasswordResetForUser(
      { id: userId, username, email, name },
      {
        req,
        requestedByUserId: Number(req.admin?.userId || req.admin?.adminId) || null,
        requestedByAdmin: true
      }
    );
  }

  res.json({ ok: true, userId, ...resetResult });
});

router.post(
  "/admin-users/:id/reset-password",
  requireAdminPermission("user_admin"),
  async (req, res) => {
    await ensureAdminAccessSchema();
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const [rows] = await getPool().query(
      `
        SELECT id, username, email, name, COALESCE(active, 1) AS active
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
      [userId]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    if (!isEmailAddress(user.email)) {
      return res.status(400).json({
        error: "This user does not have a deliverable password reset email. Save a real reset email first."
      });
    }
    if (Number(user.active) === 0) {
      return res.status(400).json({ error: "Inactive users cannot receive password reset email." });
    }

    const resetResult = await sendPasswordResetForUser(user, {
      req,
      requestedByUserId: Number(req.admin?.userId || req.admin?.adminId) || null,
      requestedByAdmin: true
    });

    res.json({ ok: true, ...resetResult });
  }
);

router.put("/admin-users/:id", requireAdminPermission("user_admin"), async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id." });
  }

  const payload = req.body || {};
  const active = toActiveFlag(payload.active);
  const adminRoles = normalizeAdminRoleKeys(payload.adminRoles);
  if (!adminRoles.length) {
    return res.status(400).json({ error: "At least one role is required." });
  }

  try {
    await assertAdminRoleChangeSafe(userId, Boolean(active), adminRoles);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }

  const updatePayload = {
    username: payload.username ? String(payload.username).trim() : undefined,
    email:
      payload.email === undefined
        ? undefined
        : String(payload.email || "").trim().toLowerCase() || null,
    name: payload.name === undefined ? undefined : String(payload.name || "").trim() || null,
    role: adminRoles.includes("admin") ? "admin" : "member",
    active,
    timesheetsUserId:
      payload.timesheetsUserId === undefined ? undefined : payload.timesheetsUserId || null,
    timesheetsEmployeeId:
      payload.timesheetsEmployeeId === undefined ? undefined : payload.timesheetsEmployeeId || null,
    updatedAt: new Date()
  };

  if (!updatePayload.username) {
    return res.status(400).json({ error: "Username is required." });
  }
  if (updatePayload.email && !isEmailAddress(updatePayload.email)) {
    return res.status(400).json({ error: "Password reset email must be a valid email address." });
  }

  const duplicateUsername = await db
    .select()
    .from(users)
    .where(eq(users.username, updatePayload.username));
  if (duplicateUsername.some((row) => Number(row.id) !== userId)) {
    return res.status(409).json({ error: "A user with this username already exists." });
  }

  if (payload.password) {
    updatePayload.passwordHash = await bcrypt.hash(String(payload.password), 10);
  }

  await db.update(users).set(updatePayload).where(eq(users.id, userId));
  await replaceAdminRolesForUser(userId, adminRoles);
  res.json({ ok: true });
});

router.get("/products", requireAdmin, async (_req, res) => {
  const db = getDb();
  const productRows = await db.select().from(products);
  const productIds = productRows.map((row) => row.id);

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/products:", error.message);
  });

  const imageRows = productIds.length
    ? await db.select().from(productImages).where(inArray(productImages.productId, productIds))
    : [];
  let mediaRows = [];
  let productMetaRows = [];
  let syncIssueRows = [];
  if (productIds.length) {
    try {
      mediaRows = await db.select().from(productMedia).where(inArray(productMedia.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "product_media")) throw error;
    }
    try {
      productMetaRows = await db
        .select()
        .from(localLineProductMeta)
        .where(inArray(localLineProductMeta.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "local_line_product_meta")) throw error;
    }
    try {
      syncIssueRows = await db
        .select()
        .from(localLineSyncIssues)
        .where(inArray(localLineSyncIssues.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "local_line_sync_issues")) throw error;
    }
  }

  const packageRows = productIds.length
    ? await db.select().from(packages).where(inArray(packages.productId, productIds))
    : [];
  const pricingProfileRows = productIds.length
    ? await db
        .select()
        .from(productPricingProfiles)
        .where(inArray(productPricingProfiles.productId, productIds))
    : [];

  const saleRows = productIds.length
    ? await db.select().from(productSales).where(inArray(productSales.productId, productIds))
    : [];

  const imagesByProduct = imageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row.url);
    return acc;
  }, {});

  const normalizeUrl = (url) => (url ? url.split("?")[0] : url);
  const isThumbnailUrl = (url) => /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(url || "");
  const baseKeyForUrl = (url) => {
    try {
      const normalized = normalizeUrl(url);
      if (!normalized) return url;
      const parsed = new URL(normalized);
      const file = parsed.pathname.split("/").pop() || normalized;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    } catch (err) {
      const file = (normalizeUrl(url) || "").split("/").pop() || url;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    }
  };

  const imageObjectsByProduct = {};
  for (const productId of Object.keys(imagesByProduct)) {
    const groups = new Map();
    const urls = imagesByProduct[productId];
    urls.forEach((url) => {
      const key = baseKeyForUrl(url);
      if (!groups.has(key)) {
        groups.set(key, { url: null, thumbnailUrl: null });
      }
      const entry = groups.get(key);
      if (isThumbnailUrl(url)) {
        entry.thumbnailUrl = entry.thumbnailUrl || url;
      } else {
        entry.url = entry.url || url;
      }
    });

    imageObjectsByProduct[productId] = [...groups.values()]
      .map((entry) => ({
        url: entry.url || entry.thumbnailUrl,
        thumbnailUrl: entry.thumbnailUrl || entry.url
      }))
      .filter((entry) => entry.url);
  }

  const mediaObjectsByProduct = mediaRows
    .slice()
    .sort((left, right) => {
      const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
      if (primaryDelta !== 0) return primaryDelta;
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    })
    .reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      const url = row.publicUrl || row.remoteUrl || row.sourceUrl;
      if (!url) return acc;
      acc[row.productId].push({
        url,
        thumbnailUrl: row.thumbnailUrl || url
      });
      return acc;
    }, {});

  const packagesByProduct = packageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row);
    return acc;
  }, {});
  const productMetaByProduct = productMetaRows.reduce((acc, row) => {
    acc[row.productId] = row;
    return acc;
  }, {});
  const pricingProfileByProduct = pricingProfileRows.reduce((acc, row) => {
    acc[row.productId] = row;
    return acc;
  }, {});
  const syncIssueCountsByProduct = syncIssueRows.reduce((acc, row) => {
    acc[row.productId] = (acc[row.productId] || 0) + 1;
    return acc;
  }, {});

  const salesByProduct = saleRows.reduce((acc, row) => {
    acc[row.productId] = {
      onSale: Boolean(row.onSale),
      saleDiscount: row.saleDiscount !== null ? Number(row.saleDiscount) : null
    };
    return acc;
  }, {});

  res.json({
    products: productRows.map((row) => ({
      ...row,
      images:
        imageObjectsByProduct[row.id] ||
        mediaObjectsByProduct[row.id] ||
        (imagesByProduct[row.id] || []).map((url) => ({ url, thumbnailUrl: url })),
      localLineMeta: productMetaByProduct[row.id] || null,
      pricingProfile: pricingProfileByProduct[row.id] || null,
      localLineSyncIssueCount: syncIssueCountsByProduct[row.id] || 0,
      packages: packagesByProduct[row.id] || [],
      onSale: salesByProduct[row.id]?.onSale ?? false,
      saleDiscount: salesByProduct[row.id]?.saleDiscount ?? null
    }))
  });
});

router.get("/products/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  const productRows = await db.select().from(products).where(eq(products.id, productId));
  const product = productRows[0] || null;
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/products/:id GET:", error.message);
  });

  const imageRows = await db.select().from(productImages).where(eq(productImages.productId, productId));
  let mediaRows = [];
  let productMetaRows = [];
  let syncIssueRows = [];
  try {
    mediaRows = await db.select().from(productMedia).where(eq(productMedia.productId, productId));
  } catch (error) {
    if (!isMissingTableError(error, "product_media")) throw error;
  }
  try {
    productMetaRows = await db
      .select()
      .from(localLineProductMeta)
      .where(eq(localLineProductMeta.productId, productId));
  } catch (error) {
    if (!isMissingTableError(error, "local_line_product_meta")) throw error;
  }
  try {
    syncIssueRows = await db
      .select()
      .from(localLineSyncIssues)
      .where(eq(localLineSyncIssues.productId, productId));
  } catch (error) {
    if (!isMissingTableError(error, "local_line_sync_issues")) throw error;
  }

  const [packageRows, pricingProfileRows, saleRows] = await Promise.all([
    db.select().from(packages).where(eq(packages.productId, productId)),
    db.select().from(productPricingProfiles).where(eq(productPricingProfiles.productId, productId)),
    db.select().from(productSales).where(eq(productSales.productId, productId))
  ]);

  const imagesByProduct = imageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row.url);
    return acc;
  }, {});

  const normalizeUrl = (url) => (url ? url.split("?")[0] : url);
  const isThumbnailUrl = (url) => /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(url || "");
  const baseKeyForUrl = (url) => {
    try {
      const normalized = normalizeUrl(url);
      if (!normalized) return url;
      const parsed = new URL(normalized);
      const file = parsed.pathname.split("/").pop() || normalized;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    } catch (err) {
      const file = (normalizeUrl(url) || "").split("/").pop() || url;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    }
  };

  const imageObjectsByProduct = {};
  for (const groupedProductId of Object.keys(imagesByProduct)) {
    const groups = new Map();
    const urls = imagesByProduct[groupedProductId];
    urls.forEach((url) => {
      const key = baseKeyForUrl(url);
      if (!groups.has(key)) {
        groups.set(key, { url: null, thumbnailUrl: null });
      }
      const entry = groups.get(key);
      if (isThumbnailUrl(url)) {
        entry.thumbnailUrl = entry.thumbnailUrl || url;
      } else {
        entry.url = entry.url || url;
      }
    });

    imageObjectsByProduct[groupedProductId] = [...groups.values()]
      .map((entry) => ({
        url: entry.url || entry.thumbnailUrl,
        thumbnailUrl: entry.thumbnailUrl || entry.url
      }))
      .filter((entry) => entry.url);
  }

  const mediaObjectsByProduct = mediaRows
    .slice()
    .sort((left, right) => {
      const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
      if (primaryDelta !== 0) return primaryDelta;
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    })
    .reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      const url = row.publicUrl || row.remoteUrl || row.sourceUrl;
      if (!url) return acc;
      acc[row.productId].push({
        url,
        thumbnailUrl: row.thumbnailUrl || url
      });
      return acc;
    }, {});

  const packagesByProduct = packageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row);
    return acc;
  }, {});
  const productMetaByProduct = productMetaRows.reduce((acc, row) => {
    acc[row.productId] = row;
    return acc;
  }, {});
  const pricingProfileByProduct = pricingProfileRows.reduce((acc, row) => {
    acc[row.productId] = row;
    return acc;
  }, {});
  const syncIssueCountsByProduct = syncIssueRows.reduce((acc, row) => {
    acc[row.productId] = (acc[row.productId] || 0) + 1;
    return acc;
  }, {});
  const salesByProduct = saleRows.reduce((acc, row) => {
    acc[row.productId] = {
      onSale: Boolean(row.onSale),
      saleDiscount: row.saleDiscount !== null ? Number(row.saleDiscount) : null
    };
    return acc;
  }, {});

  return res.json({
    product: {
      ...product,
      images:
        imageObjectsByProduct[product.id] ||
        mediaObjectsByProduct[product.id] ||
        (imagesByProduct[product.id] || []).map((url) => ({ url, thumbnailUrl: url })),
      localLineMeta: productMetaByProduct[product.id] || null,
      pricingProfile: pricingProfileByProduct[product.id] || null,
      localLineSyncIssueCount: syncIssueCountsByProduct[product.id] || 0,
      packages: packagesByProduct[product.id] || [],
      onSale: salesByProduct[product.id]?.onSale ?? false,
      saleDiscount: salesByProduct[product.id]?.saleDiscount ?? null
    }
  });
});

router.get("/local-pricelist-products", requireAdmin, async (req, res) => {
  const db = getDb();
  const pool = getPool();
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/local-pricelist-products:", error.message);
  });

  const [vendorRows, categoryRows] = await Promise.all([
    db.select().from(vendors),
    db.select().from(categories)
  ]);

  const localVendorIds = vendorRows
    .filter((vendor) => isSourcePricingVendor(vendor))
    .map((vendor) => Number(vendor.id))
    .filter((value) => Number.isFinite(value));

  if (!localVendorIds.length) {
    return res.json({
      categories: [],
      products: [],
      pagination: {
        page: 1,
        pageSize: PRICELIST_DEFAULT_PAGE_SIZE,
        totalRows: 0,
        totalPages: 1
      }
    });
  }

  const search = String(req.query?.search || "").trim().toLowerCase();
  const categoryId = toOptionalInteger(req.query?.categoryId, null);
  const vendorId = toOptionalInteger(req.query?.vendorId, null);
  const visibility = String(req.query?.visibility || "visible").trim();
  const saleFilter = String(req.query?.sale || "all").trim();
  const requestedPageSize = parsePositiveInteger(req.query?.pageSize, PRICELIST_DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(PRICELIST_MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
  const requestedPage = parsePositiveInteger(req.query?.page, 1);
  const whereClauses = ["p.vendor_id IN (?)"];
  const whereParams = [localVendorIds];

  if (search) {
    whereClauses.push("LOWER(TRIM(p.name)) LIKE ?");
    whereParams.push(`%${search}%`);
  }
  if (Number.isFinite(categoryId)) {
    whereClauses.push("p.category_id = ?");
    whereParams.push(categoryId);
  }
  if (Number.isFinite(vendorId)) {
    whereClauses.push("p.vendor_id = ?");
    whereParams.push(vendorId);
  }
  if (visibility === "visible") {
    whereClauses.push("COALESCE(p.visible, 0) = 1");
  } else if (visibility === "hidden") {
    whereClauses.push("COALESCE(p.visible, 0) = 0");
  }
  if (saleFilter === "onSale") {
    whereClauses.push("COALESCE(ps.on_sale, 0) = 1");
  } else if (saleFilter === "notOnSale") {
    whereClauses.push("COALESCE(ps.on_sale, 0) = 0");
  }

  const whereSql = `WHERE ${whereClauses.join(" AND ")}`;
  const [categoryOptionRows] = await pool.query(
    `
      SELECT DISTINCT c.id, c.name
      FROM categories c
      JOIN products p ON p.category_id = c.id
      WHERE p.vendor_id IN (?)
      ORDER BY c.name ASC
    `,
    [localVendorIds]
  );

  const [[countRow]] = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      ${whereSql}
    `,
    whereParams
  );
  const totalRows = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  const [pagedProductRows] = await pool.query(
    `
      SELECT
        p.*,
        COALESCE(ps.on_sale, 0) AS onSale,
        ps.sale_discount AS saleDiscount,
        c.name AS categoryName
      FROM products p
      LEFT JOIN product_sales ps ON ps.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereSql}
      ORDER BY p.name ASC
      LIMIT ? OFFSET ?
    `,
    [...whereParams, pageSize, offset]
  );
  const pagedProductIds = pagedProductRows
    .map((row) => Number(row.id))
    .filter((value) => Number.isFinite(value));

  const [packageRows, pricingProfileRows] = pagedProductIds.length
    ? await Promise.all([
        db.select().from(packages).where(inArray(packages.productId, pagedProductIds)),
        db.select().from(productPricingProfiles).where(inArray(productPricingProfiles.productId, pagedProductIds))
      ])
    : [[], []];

  let productMetaRows = [];
  if (pagedProductIds.length) {
    try {
      productMetaRows = await db
        .select()
        .from(localLineProductMeta)
        .where(inArray(localLineProductMeta.productId, pagedProductIds));
    } catch (error) {
      if (!isMissingTableError(error, "local_line_product_meta")) throw error;
    }
  }

  const categoryMap = new Map(categoryRows.map((row) => [Number(row.id), row.name]));
  const availableCategories = categoryOptionRows.map((row) => ({
    id: Number(row.id),
    name: row.name
  }));
  const packagesByProduct = packageRows.reduce((acc, row) => {
    const productId = Number(row.productId);
    if (!acc[productId]) acc[productId] = [];
    acc[productId].push(row);
    return acc;
  }, {});
  const pricingProfileByProduct = pricingProfileRows.reduce((acc, row) => {
    acc[Number(row.productId)] = row;
    return acc;
  }, {});
  const productMetaByProduct = productMetaRows.reduce((acc, row) => {
    acc[Number(row.productId)] = row;
    return acc;
  }, {});

  const imageRows = pagedProductIds.length
    ? await db.select().from(productImages).where(inArray(productImages.productId, pagedProductIds))
    : [];
  let mediaRows = [];
  if (pagedProductIds.length) {
    try {
      mediaRows = await db.select().from(productMedia).where(inArray(productMedia.productId, pagedProductIds));
    } catch (error) {
      if (!isMissingTableError(error, "product_media")) throw error;
    }
  }

  const imagesByProduct = imageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row.url);
    return acc;
  }, {});

  const normalizeUrl = (url) => (url ? url.split("?")[0] : url);
  const isThumbnailUrl = (url) => /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(url || "");
  const baseKeyForUrl = (url) => {
    try {
      const normalized = normalizeUrl(url);
      if (!normalized) return url;
      const parsed = new URL(normalized);
      const file = parsed.pathname.split("/").pop() || normalized;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    } catch (_error) {
      const file = (normalizeUrl(url) || "").split("/").pop() || url;
      return file
        .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
        .replace(/\.(jpg|jpeg|png|webp)$/i, "");
    }
  };

  const imageObjectsByProduct = {};
  for (const productId of Object.keys(imagesByProduct)) {
    const groups = new Map();
    const urls = imagesByProduct[productId];
    urls.forEach((url) => {
      const key = baseKeyForUrl(url);
      if (!groups.has(key)) {
        groups.set(key, { url: null, thumbnailUrl: null });
      }
      const entry = groups.get(key);
      if (isThumbnailUrl(url)) {
        entry.thumbnailUrl = entry.thumbnailUrl || url;
      } else {
        entry.url = entry.url || url;
      }
    });

    imageObjectsByProduct[productId] = [...groups.values()]
      .map((entry) => ({
        url: entry.url || entry.thumbnailUrl,
        thumbnailUrl: entry.thumbnailUrl || entry.url
      }))
      .filter((entry) => entry.url);
  }

  const mediaObjectsByProduct = mediaRows
    .slice()
    .sort((left, right) => {
      const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
      if (primaryDelta !== 0) return primaryDelta;
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    })
    .reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      const url = row.publicUrl || row.remoteUrl || row.sourceUrl;
      if (!url) return acc;
      acc[row.productId].push({
        url,
        thumbnailUrl: row.thumbnailUrl || url
      });
      return acc;
    }, {});

  return res.json({
    categories: availableCategories,
    products: pagedProductRows.map((product) => ({
      ...product,
      categoryName: product.categoryName || categoryMap.get(Number(product.categoryId)) || "Uncategorized",
      packages: packagesByProduct[Number(product.id)] || [],
      pricingProfile: pricingProfileByProduct[Number(product.id)] || null,
      localLineMeta: productMetaByProduct[Number(product.id)] || null,
      onSale: Boolean(product.onSale),
      saleDiscount:
        product.saleDiscount === null || typeof product.saleDiscount === "undefined"
          ? null
          : Number(product.saleDiscount),
      images:
        imageObjectsByProduct[product.id] ||
        mediaObjectsByProduct[product.id] ||
        (imagesByProduct[product.id] || []).map((url) => ({ url, thumbnailUrl: url }))
    })),
    pagination: {
      page,
      pageSize,
      totalRows,
      totalPages
    }
  });
});

router.get("/localline/products/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/localline/products/:id:", error.message);
  });

  try {
    const [productMetaRows, packageMetaRows, priceListEntryRows, syncIssueRows, mediaRows] =
      await Promise.all([
        db.select().from(localLineProductMeta).where(eq(localLineProductMeta.productId, productId)),
        db
          .select()
          .from(localLinePackageMeta)
          .where(eq(localLinePackageMeta.productId, productId)),
        db
          .select()
          .from(localLinePriceListEntries)
          .where(eq(localLinePriceListEntries.productId, productId)),
        db
          .select()
          .from(localLineSyncIssues)
          .where(eq(localLineSyncIssues.productId, productId)),
        db.select().from(productMedia).where(eq(productMedia.productId, productId))
      ]);

    res.json({
      productId,
      productMeta: productMetaRows[0] || null,
      packageMeta: packageMetaRows,
      priceListEntries: priceListEntryRows
        .slice()
        .sort((left, right) => {
          const priceListDelta = Number(left.priceListId || 0) - Number(right.priceListId || 0);
          if (priceListDelta !== 0) return priceListDelta;
          return Number(left.packageId || 0) - Number(right.packageId || 0);
        }),
      syncIssues: syncIssueRows
        .slice()
        .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)),
      media: mediaRows
        .slice()
        .sort((left, right) => {
          const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
          if (primaryDelta !== 0) return primaryDelta;
          return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
        })
    });
  } catch (error) {
    if (
      isMissingTableError(error, "local_line_product_meta") ||
      isMissingTableError(error, "local_line_package_meta") ||
      isMissingTableError(error, "local_line_price_list_entries") ||
      isMissingTableError(error, "local_line_sync_issues") ||
      isMissingTableError(error, "product_media")
    ) {
      return res.json({
        productId,
        productMeta: null,
        packageMeta: [],
        priceListEntries: [],
        syncIssues: [],
        media: []
      });
    }
    throw error;
  }
});

router.put("/localline/products/:id/price-list-entries", requireAdminPermission("pricing_admin"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];

  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  if (!entries.length) {
    return res.json({ ok: true, updated: 0 });
  }

  const updatedAt = new Date();
  let updated = 0;

  for (const entry of entries) {
    const entryId = Number(entry.id);
    if (!Number.isFinite(entryId)) continue;

    const payload = {
      visible:
        typeof entry.visible === "boolean" || entry.visible === null
          ? (entry.visible === null ? null : (entry.visible ? 1 : 0))
          : undefined,
      onSale:
        typeof entry.onSale === "boolean" || entry.onSale === null
          ? (entry.onSale === null ? null : (entry.onSale ? 1 : 0))
          : undefined,
      onSaleToggle:
        typeof entry.onSaleToggle === "boolean" || entry.onSaleToggle === null
          ? (entry.onSaleToggle === null ? null : (entry.onSaleToggle ? 1 : 0))
          : undefined,
      finalPriceCache:
        entry.finalPriceCache === null || typeof entry.finalPriceCache === "undefined"
          ? undefined
          : entry.finalPriceCache,
      strikethroughDisplayValue:
        entry.strikethroughDisplayValue === null ||
        typeof entry.strikethroughDisplayValue === "undefined"
          ? undefined
          : entry.strikethroughDisplayValue,
      maxUnitsPerOrder:
        entry.maxUnitsPerOrder === null || typeof entry.maxUnitsPerOrder === "undefined"
          ? undefined
          : entry.maxUnitsPerOrder,
      updatedAt,
      lastSyncedAt: updatedAt
    };

    Object.keys(payload).forEach((key) => {
      if (typeof payload[key] === "undefined") {
        delete payload[key];
      }
    });

    if (!Object.keys(payload).length) continue;

    await db
      .update(localLinePriceListEntries)
      .set(payload)
      .where(and(eq(localLinePriceListEntries.id, entryId), eq(localLinePriceListEntries.productId, productId)));

    const packageId = Number(entry.packageId);
    const priceListId = Number(entry.priceListId);
    if (Number.isFinite(packageId) && Number.isFinite(priceListId)) {
      await db
        .update(packagePriceListMemberships)
        .set({
          onSale: payload.onSale ?? undefined,
          onSaleToggle: payload.onSaleToggle ?? undefined,
          finalPriceCache: payload.finalPriceCache ?? undefined,
          strikethroughDisplayValue: payload.strikethroughDisplayValue ?? undefined,
          maxUnitsPerOrder: payload.maxUnitsPerOrder ?? undefined,
          updatedAt,
          lastSyncedAt: updatedAt
        })
        .where(
          and(
            eq(packagePriceListMemberships.packageId, packageId),
            eq(packagePriceListMemberships.priceListId, priceListId)
          )
        );
    }

    updated += 1;
  }

  return res.json({ ok: true, updated });
});

const PRICELIST_DEFAULT_PAGE_SIZE = 50;
const PRICELIST_MAX_PAGE_SIZE = 200;
const PRICELIST_SQL_SORT_MAP = Object.freeze({
  product: "p.name",
  sourceUnitPrice: "pp.source_unit_price",
  unit: "pp.unit_of_measure",
  category: "c.name",
  vendor: "v.name",
  minWeight: "pp.min_weight",
  maxWeight: "pp.max_weight",
  avgWeightOverride: "pp.avg_weight_override",
  sourceMultiplier: "pp.source_multiplier",
  guestMarkup: "pp.guest_markup",
  memberMarkup: "pp.member_markup",
  herdShareMarkup: "pp.herd_share_markup",
  snapMarkup: "pp.snap_markup",
  onSale: "pp.on_sale",
  saleDiscount: "pp.sale_discount",
  status: "COALESCE(pp.remote_sync_status, 'not-applied')",
  lastRemote: "pp.remote_synced_at"
});
const PRICELIST_PENDING_REMOTE_APPLY_SQL =
  "(" +
    "pp.product_id IS NOT NULL AND (" +
    "pp.remote_sync_status IN ('pending', 'failed') " +
    "OR COALESCE(pp.updated_at, '1970-01-01 00:00:00') > COALESCE(pp.remote_synced_at, '1970-01-01 00:00:00')" +
    ")" +
  ")";
const PRICELIST_COMPUTED_SORT_KEYS = new Set([
  "pricingRule",
  "basePrice",
  "guestPrice",
  "memberPrice",
  "herdSharePrice",
  "snapPrice",
  "packages"
]);

function parsePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizePricelistSortKey(value) {
  const key = String(value || "product").trim();
  if (Object.prototype.hasOwnProperty.call(PRICELIST_SQL_SORT_MAP, key)) {
    return key;
  }
  return PRICELIST_COMPUTED_SORT_KEYS.has(key) ? key : "product";
}

function normalizePricelistSortDirection(value) {
  return String(value || "").trim().toLowerCase() === "desc" ? "desc" : "asc";
}

function buildPricelistWhereClause({
  search,
  categoryId,
  vendorId,
  saleFilter,
  statusFilter,
  membershipCategoryIds = []
}) {
  const clauses = [];
  const params = [];

  if (membershipCategoryIds.length) {
    clauses.push("(p.category_id IS NULL OR p.category_id NOT IN (?))");
    params.push(membershipCategoryIds);
  }

  if (search) {
    clauses.push("LOWER(TRIM(p.name)) LIKE ?");
    params.push(`%${String(search).trim().toLowerCase()}%`);
  }

  if (Number.isFinite(categoryId)) {
    clauses.push("p.category_id = ?");
    params.push(categoryId);
  }

  if (Number.isFinite(vendorId)) {
    clauses.push("p.vendor_id = ?");
    params.push(vendorId);
  }

  if (saleFilter === "onSale") {
    clauses.push("COALESCE(ps.on_sale, 0) = 1");
  } else if (saleFilter === "notOnSale") {
    clauses.push("COALESCE(ps.on_sale, 0) = 0");
  }

  switch (statusFilter) {
    case "needsApply":
      clauses.push(PRICELIST_PENDING_REMOTE_APPLY_SQL);
      break;
    case "applied":
    case "pending":
    case "failed":
      clauses.push("COALESCE(pp.remote_sync_status, 'not-applied') = ?");
      params.push(statusFilter);
      break;
    case "not-applied":
      clauses.push(
        "(" +
          "pp.product_id IS NULL " +
          "OR pp.remote_sync_status IS NULL " +
          "OR TRIM(pp.remote_sync_status) = '' " +
          "OR pp.remote_sync_status = 'not-applied'" +
        ")"
      );
      break;
    default:
      break;
  }

  return {
    clauses,
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function buildPendingPricelistClauses(clauses = [], statusFilter = "all") {
  return statusFilter === "needsApply"
    ? [...clauses]
    : [...clauses, PRICELIST_PENDING_REMOTE_APPLY_SQL];
}

function compareNullableNumbers(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareNullableStrings(left, right) {
  const leftValue = String(left || "").trim();
  const rightValue = String(right || "").trim();
  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return 1;
  if (!rightValue) return -1;
  return leftValue.localeCompare(rightValue, undefined, { sensitivity: "base", numeric: true });
}

function getPricelistSortValue(row, columnKey) {
  switch (columnKey) {
    case "product":
      return row.name || "";
    case "sourceUnitPrice":
      return toNumber(row.sourceUnitPrice);
    case "unit":
      return row.unitOfMeasure || "";
    case "category":
      return row.categoryName || "";
    case "vendor":
      return row.vendorName || "";
    case "pricingRule":
      return row.pricingRuleLabel || "";
    case "minWeight":
      return toNumber(row.minWeight);
    case "maxWeight":
      return toNumber(row.maxWeight);
    case "avgWeightOverride":
      return toNumber(row.avgWeightOverride);
    case "sourceMultiplier":
      return toNumber(row.sourceMultiplier);
    case "basePrice":
      return toNumber(row.basePrice);
    case "guestMarkup":
      return toNumber(row.guestMarkup);
    case "guestPrice":
      return toNumber(row.guestPrice);
    case "memberMarkup":
      return toNumber(row.memberMarkup);
    case "memberPrice":
      return toNumber(row.memberPrice);
    case "herdShareMarkup":
      return toNumber(row.herdShareMarkup);
    case "herdSharePrice":
      return toNumber(row.herdSharePrice);
    case "snapMarkup":
      return toNumber(row.snapMarkup);
    case "snapPrice":
      return toNumber(row.snapPrice);
    case "saleDiscount":
      return toNumber(row.saleDiscount);
    case "onSale":
      return row.onSale ? 1 : 0;
    case "packages":
      return row.packageSummary || "";
    case "status":
      return row.remoteSyncStatus || "";
    case "lastRemote":
      return row.remoteSyncedAt ? new Date(row.remoteSyncedAt).getTime() : null;
    default:
      return null;
  }
}

function comparePricelistRows(left, right, columnKey, direction) {
  const leftValue = getPricelistSortValue(left, columnKey);
  const rightValue = getPricelistSortValue(right, columnKey);
  const multiplier = direction === "desc" ? -1 : 1;

  if (
    typeof leftValue === "number" ||
    typeof rightValue === "number" ||
    leftValue === null ||
    rightValue === null
  ) {
    return compareNullableNumbers(
      typeof leftValue === "number" ? leftValue : null,
      typeof rightValue === "number" ? rightValue : null
    ) * multiplier;
  }

  return compareNullableStrings(leftValue, rightValue) * multiplier;
}

function hasPendingRemoteApply(pricingProfile) {
  if (!pricingProfile) return false;
  return (
    ["pending", "failed"].includes(String(pricingProfile.remoteSyncStatus || "")) ||
    toTimestamp(pricingProfile.updatedAt) > toTimestamp(pricingProfile.remoteSyncedAt)
  );
}

function hasRecentPriceOrSaleChange(pricingProfile, saleRow, windowDays = 1) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const pricingUpdatedAt = toTimestamp(pricingProfile?.updatedAt);
  const saleUpdatedAt = toTimestamp(saleRow?.updatedAt);
  return pricingUpdatedAt >= cutoff || saleUpdatedAt >= cutoff;
}

function normalizeSaleFlag(value) {
  return Number(value || 0) ? 1 : 0;
}

function normalizeSaleDiscountComparable(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(4));
}

function saleValuesMatch(left = {}, right = {}) {
  return (
    normalizeSaleFlag(left.onSale) === normalizeSaleFlag(right.onSale) &&
    normalizeSaleDiscountComparable(left.saleDiscount) ===
      normalizeSaleDiscountComparable(right.saleDiscount)
  );
}

async function fetchPricelistSupportingRows(db, productRows) {
  const productIds = [...new Set(
    productRows
      .map((row) => Number(row.id))
      .filter((value) => Number.isFinite(value))
  )];
  const vendorIds = [...new Set(
    productRows
      .map((row) => Number(row.vendorId))
      .filter((value) => Number.isFinite(value))
  )];

  if (!productIds.length) {
    return {
      packageRows: [],
      profileRows: [],
      saleRows: [],
      packageMetaRows: [],
      productMetaRows: [],
      vendorRows: []
    };
  }

  const [packageRows, profileRows, saleRows, vendorRows] = await Promise.all([
    db.select().from(packages).where(inArray(packages.productId, productIds)),
    db.select().from(productPricingProfiles).where(inArray(productPricingProfiles.productId, productIds)),
    db.select().from(productSales).where(inArray(productSales.productId, productIds)),
    vendorIds.length
      ? db.select().from(vendors).where(inArray(vendors.id, vendorIds))
      : Promise.resolve([])
  ]);

  let packageMetaRows = [];
  let productMetaRows = [];
  try {
    packageMetaRows = await db
      .select()
      .from(localLinePackageMeta)
      .where(inArray(localLinePackageMeta.productId, productIds));
  } catch (error) {
    if (!isMissingTableError(error, "local_line_package_meta")) throw error;
  }
  try {
    productMetaRows = await db
      .select()
      .from(localLineProductMeta)
      .where(inArray(localLineProductMeta.productId, productIds));
  } catch (error) {
    if (!isMissingTableError(error, "local_line_product_meta")) throw error;
  }

  return {
    packageRows,
    profileRows,
    saleRows,
    packageMetaRows,
    productMetaRows,
    vendorRows
  };
}

function buildPricelistRows(productRows, supportingRows) {
  const vendorMap = new Map(
    (supportingRows.vendorRows || []).map((row) => [Number(row.id), row])
  );
  const packagesByProductId = (supportingRows.packageRows || []).reduce((acc, row) => {
    const list = acc.get(Number(row.productId)) || [];
    list.push(row);
    acc.set(Number(row.productId), list);
    return acc;
  }, new Map());
  const packageMetaByPackageId = new Map(
    (supportingRows.packageMetaRows || []).map((row) => [Number(row.packageId), row])
  );
  const productMetaByProductId = new Map(
    (supportingRows.productMetaRows || []).map((row) => [Number(row.productId), row])
  );
  const profileByProductId = new Map(
    (supportingRows.profileRows || []).map((row) => [Number(row.productId), row])
  );
  const saleByProductId = new Map(
    (supportingRows.saleRows || []).map((row) => [Number(row.productId), row])
  );

  return productRows.map((product) => {
    const productId = Number(product.id);
    const pricingProfile = profileByProductId.get(productId) || null;
    const saleRow = saleByProductId.get(productId) || null;
    const vendor = vendorMap.get(Number(product.vendorId)) || null;
    const productMeta = productMetaByProductId.get(productId) || null;
    const visibleSource =
      product.visible === null || typeof product.visible === "undefined"
        ? productMeta?.visible
        : product.visible;
    const trackInventorySource =
      product.trackInventory === null || typeof product.trackInventory === "undefined"
        ? productMeta?.trackInventory
        : product.trackInventory;
    const inventorySource =
      product.inventory === null || typeof product.inventory === "undefined"
        ? productMeta?.productInventory
        : product.inventory;
    const mergedProfile = pricingProfile
      ? {
          ...pricingProfile,
          onSale: saleRow?.onSale ?? pricingProfile.onSale ?? 0,
          saleDiscount: saleRow?.saleDiscount ?? pricingProfile.saleDiscount ?? 0
        }
      : {
          productId,
          onSale: saleRow?.onSale ?? 0,
          saleDiscount: saleRow?.saleDiscount ?? 0
        };
    const snapshot = computeProductPricingSnapshot({
      product,
      packages: packagesByProductId.get(productId) || [],
      packageMetaByPackageId,
      vendor,
      profile: mergedProfile
    });
    const usesSourcePricing = isSourcePricingVendor(vendor);

    return {
      productId,
      name: product.name,
      categoryId: product.categoryId,
      categoryName: product.categoryName || "Uncategorized",
      vendorId: product.vendorId,
      vendorName: product.vendorName || vendor?.name || "N/A",
      visible: toBooleanFlag(visibleSource, true),
      trackInventory: toBooleanFlag(trackInventorySource, false),
      inventory: toInventoryValue(inventorySource, 0),
      usesSourcePricing,
      usesNoMarkupPricing: snapshot.profile.usesNoMarkupPricing,
      pricingRule: snapshot.profile.pricingRule,
      pricingRuleLabel: snapshot.profile.usesNoMarkupPricing ? "Deposit / no markup" : "Standard",
      packageCount: snapshot.packageRows.length,
      packages: snapshot.packageRows,
      packageSummary: snapshot.packageRows
        .map((row) => {
          const details = [];
          if (snapshot.profile.unitOfMeasure === "lbs" && row.averageWeight !== null) {
            details.push(`${row.averageWeight} lb avg`);
          }
          if (row.quantity > 1) details.push(`${row.quantity} ea`);
          return `${row.name || `Package ${row.id}`}${details.length ? ` (${details.join(" · ")})` : ""}`;
        })
        .join(", "),
      unitOfMeasure: usesSourcePricing ? snapshot.profile.unitOfMeasure : null,
      sourceUnitPrice: usesSourcePricing ? snapshot.profile.sourceUnitPrice : null,
      minWeight: usesSourcePricing ? snapshot.profile.minWeight : null,
      maxWeight: usesSourcePricing ? snapshot.profile.maxWeight : null,
      avgWeightOverride: usesSourcePricing ? snapshot.profile.avgWeightOverride : null,
      sourceMultiplier: usesSourcePricing ? snapshot.profile.sourceMultiplier : null,
      localLineProductId: Number(productMeta?.localLineProductId || 0),
      guestMarkup: snapshot.profile.guestMarkup,
      memberMarkup: snapshot.profile.memberMarkup,
      herdShareMarkup: snapshot.profile.herdShareMarkup,
      snapMarkup: snapshot.profile.snapMarkup,
      onSale: Boolean(snapshot.profile.onSale),
      saleDiscount: snapshot.profile.saleDiscount,
      basePrice: snapshot.basePrice,
      guestPrice: snapshot.guestPrice,
      memberPrice: snapshot.memberPrice,
      herdSharePrice: snapshot.herdSharePrice,
      snapPrice: snapshot.snapPrice,
      remoteSyncStatus: mergedProfile?.remoteSyncStatus || "not-applied",
      remoteSyncMessage: mergedProfile?.remoteSyncMessage || "",
      remoteSyncedAt: mergedProfile?.remoteSyncedAt || null,
      updatedAt: mergedProfile?.updatedAt || product.pricingUpdatedAt || null,
      saleUpdatedAt: saleRow?.updatedAt || null,
      hasRecentPriceOrSaleChange: hasRecentPriceOrSaleChange(mergedProfile, saleRow),
      hasPendingRemoteApply: hasPendingRemoteApply(mergedProfile)
    };
  });
}

router.get("/pricelist", requireAdmin, async (req, res) => {
  const db = getDb();
  const pool = getPool();
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/pricelist:", error.message);
  });
  await ensureAdminPricelistIndexes().catch((error) => {
    console.warn("Pricelist index bootstrap skipped for /admin/pricelist:", error.message);
  });

  const search = String(req.query?.search || "").trim();
  const categoryId = toOptionalInteger(req.query?.categoryId, null);
  const vendorId = toOptionalInteger(req.query?.vendorId, null);
  const saleFilter = String(req.query?.sale || "all").trim();
  const statusFilter = String(req.query?.status || "all").trim();
  const requestedPageSize = parsePositiveInteger(req.query?.pageSize, PRICELIST_DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(PRICELIST_MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
  const requestedPage = parsePositiveInteger(req.query?.page, 1);
  const sortKey = normalizePricelistSortKey(req.query?.sortKey);
  const sortDirection = normalizePricelistSortDirection(req.query?.sortDirection);
  const sqlSortExpression = PRICELIST_SQL_SORT_MAP[sortKey] || null;

  const categoryRows = await db.select().from(categories);
  const membershipCategoryIds = categoryRows
    .filter((row) => isMembershipCategoryName(row.name))
    .map((row) => Number(row.id))
    .filter((value) => Number.isFinite(value));

  const { clauses, whereSql, params } = buildPricelistWhereClause({
    search,
    categoryId,
    vendorId,
    saleFilter,
    statusFilter,
    membershipCategoryIds
  });

  const baseFromSql = `
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id = p.id
    LEFT JOIN product_sales ps ON ps.product_id = p.id
  `;
  const selectSql = `
    SELECT
      p.id,
      p.name,
      p.description,
      p.visible,
      p.track_inventory AS trackInventory,
      p.inventory,
      p.category_id AS categoryId,
      p.vendor_id AS vendorId,
      p.thumbnail_url AS thumbnailUrl,
      p.created_at AS createdAt,
      p.updated_at AS updatedAt,
      p.is_deleted AS isDeleted,
      c.name AS categoryName,
      v.name AS vendorName,
      pp.remote_sync_status AS remoteSyncStatus,
      pp.remote_sync_message AS remoteSyncMessage,
      pp.remote_synced_at AS remoteSyncedAt,
      pp.updated_at AS pricingUpdatedAt
    ${baseFromSql}
    ${whereSql}
  `;

  const countSql = `
    SELECT COUNT(*) AS total
    ${baseFromSql}
    ${whereSql}
  `;
  const [[countRow]] = await pool.query(countSql, params);
  const totalRows = Number(countRow?.total || 0);
  const pendingCountClauses = buildPendingPricelistClauses(clauses, statusFilter);
  const pendingCountWhereSql = pendingCountClauses.length
    ? `WHERE ${pendingCountClauses.join(" AND ")}`
    : "";
  const pendingCountParams = [...params];
  const pendingCountSql = `
    SELECT COUNT(*) AS total
    ${baseFromSql}
    ${pendingCountWhereSql}
  `;
  const [[pendingCountRow]] = await pool.query(pendingCountSql, pendingCountParams);
  const pendingRemoteApplyRows = Number(pendingCountRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(requestedPage, totalPages);

  let rows = [];
  let sortMode = "server";

  if (sqlSortExpression) {
    const directionSql = sortDirection === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [pageProductRows] = await pool.query(
      `
        ${selectSql}
        ORDER BY ${sqlSortExpression} ${directionSql}, p.name ASC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );
    const supportingRows = await fetchPricelistSupportingRows(db, pageProductRows);
    rows = buildPricelistRows(pageProductRows, supportingRows);
  } else {
    sortMode = "computed";
    const [matchingProductRows] = await pool.query(
      `
        ${selectSql}
        ORDER BY p.name ASC
      `,
      params
    );
    const supportingRows = await fetchPricelistSupportingRows(db, matchingProductRows);
    const computedRows = buildPricelistRows(matchingProductRows, supportingRows);
    computedRows.sort((left, right) => {
      const sortDelta = comparePricelistRows(left, right, sortKey, sortDirection);
      if (sortDelta !== 0) return sortDelta;
      return String(left.name || "").localeCompare(String(right.name || ""), undefined, {
        sensitivity: "base",
        numeric: true
      });
    });
    const offset = (page - 1) * pageSize;
    rows = computedRows.slice(offset, offset + pageSize);
  }

  res.json({
    rows,
    pagination: {
      page,
      pageSize,
      totalRows,
      totalPages
    },
    summary: {
      pendingRemoteApplyRows
    },
    sort: {
      key: sortKey,
      direction: sortDirection,
      mode: sortMode
    }
  });
});

router.get("/pricelist/pending-remote", requireAdmin, async (req, res) => {
  const db = getDb();
  const pool = getPool();
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/pricelist/pending-remote:", error.message);
  });
  await ensureAdminPricelistIndexes().catch((error) => {
    console.warn("Pricelist index bootstrap skipped for /admin/pricelist/pending-remote:", error.message);
  });

  const search = String(req.query?.search || "").trim();
  const categoryId = toOptionalInteger(req.query?.categoryId, null);
  const vendorId = toOptionalInteger(req.query?.vendorId, null);
  const saleFilter = String(req.query?.sale || "all").trim();
  const statusFilter = String(req.query?.status || "all").trim();

  const categoryRows = await db.select().from(categories);
  const membershipCategoryIds = categoryRows
    .filter((row) => isMembershipCategoryName(row.name))
    .map((row) => Number(row.id))
    .filter((value) => Number.isFinite(value));

  const { clauses, params } = buildPricelistWhereClause({
    search,
    categoryId,
    vendorId,
    saleFilter,
    statusFilter,
    membershipCategoryIds
  });
  const pendingClauses = buildPendingPricelistClauses(clauses, statusFilter);
  const pendingWhereSql = pendingClauses.length
    ? `WHERE ${pendingClauses.join(" AND ")}`
    : "";

  const [matchingProductRows] = await pool.query(
    `
      SELECT
        p.id,
        p.name,
        p.description,
        p.visible,
        p.track_inventory AS trackInventory,
        p.inventory,
        p.category_id AS categoryId,
        p.vendor_id AS vendorId,
        p.thumbnail_url AS thumbnailUrl,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        p.is_deleted AS isDeleted,
        c.name AS categoryName,
        v.name AS vendorName,
        pp.remote_sync_status AS remoteSyncStatus,
        pp.remote_sync_message AS remoteSyncMessage,
        pp.remote_synced_at AS remoteSyncedAt,
        pp.updated_at AS pricingUpdatedAt
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN product_pricing_profiles pp ON pp.product_id = p.id
      ${pendingWhereSql}
      ORDER BY p.name ASC
    `,
    params
  );

  const supportingRows = await fetchPricelistSupportingRows(db, matchingProductRows);
  const rows = buildPricelistRows(matchingProductRows, supportingRows);

  res.json({
    productIds: rows.map((row) => row.productId),
    rows,
    totalRows: rows.length
  });
});

router.post("/pricelist/bulk-save", requireAdminPermission("pricing_admin"), async (req, res) => {
  const db = getDb();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const now = new Date();
  const savedProductIds = [];

  for (const row of rows) {
    const productId = Number(row?.productId);
    if (!Number.isFinite(productId)) {
      continue;
    }

    const productRows = await db.select().from(products).where(eq(products.id, productId));
    const product = productRows[0] || null;
    const vendorRows = product?.vendorId
      ? await db.select().from(vendors).where(eq(vendors.id, product.vendorId))
      : [];
    const vendor = vendorRows[0] || null;
    const forceNoMarkup = isNoMarkupProduct(productRows[0] || { id: productId });
    const vendorPriceListMarkup = normalizeVendorMarkupInput(vendor?.priceListMarkup);
    const vendorSourceMultiplier = normalizeVendorSourceMultiplierInput(vendor?.sourceMultiplier);

    const payload = {
      unitOfMeasure: String(row.unitOfMeasure || "each").toLowerCase() === "lbs" ? "lbs" : "each",
      sourceUnitPrice: toDbDecimal(row.sourceUnitPrice),
      minWeight: toDbDecimal(row.minWeight),
      maxWeight: toDbDecimal(row.maxWeight),
      avgWeightOverride: toDbDecimal(row.avgWeightOverride),
      sourceMultiplier:
        isSourcePricingVendor(vendor) && vendorSourceMultiplier !== null
          ? vendorSourceMultiplier
          : toDbDecimal(row.sourceMultiplier),
      guestMarkup: forceNoMarkup ? 0 : (vendorPriceListMarkup ?? toDbDecimal(row.guestMarkup)),
      memberMarkup: forceNoMarkup ? 0 : (vendorPriceListMarkup ?? toDbDecimal(row.memberMarkup)),
      herdShareMarkup: forceNoMarkup ? 0 : (vendorPriceListMarkup ?? toDbDecimal(row.herdShareMarkup)),
      snapMarkup: forceNoMarkup ? 0 : (vendorPriceListMarkup ?? toDbDecimal(row.snapMarkup)),
      onSale: row.onSale ? 1 : 0,
      saleDiscount: toDbDecimal(row.saleDiscount),
      priceChangedAt: now,
      remoteSyncStatus: "pending",
      remoteSyncMessage: "Local pricing updated. Apply to remote store pending.",
      updatedAt: now
    };

    const existing = await db
      .select()
      .from(productPricingProfiles)
      .where(eq(productPricingProfiles.productId, productId));

    if (existing.length) {
      await db
        .update(productPricingProfiles)
        .set(payload)
        .where(eq(productPricingProfiles.productId, productId));
    } else {
      await db.insert(productPricingProfiles).values({
        productId,
        ...payload,
        createdAt: now
      });
    }

    savedProductIds.push(productId);
  }

  res.json({ ok: true, saved: savedProductIds.length, productIds: savedProductIds });
});

router.post("/pricelist/apply-remote", requireAdminPermission("localline_push"), async (req, res) => {
  const db = getDb();
  const productIds = [...new Set(
    (Array.isArray(req.body?.productIds) ? req.body.productIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  )];

  const results = [];
  for (const productId of productIds) {
    const now = new Date();
    try {
      const productRows = await db.select().from(products).where(eq(products.id, productId));

      if (!productRows.length) {
        results.push({ productId, ok: false, message: "Product not found." });
        continue;
      }

      const product = productRows[0];
      const [packageRows, vendorRows, profileRows, saleRows] = await Promise.all([
        db.select().from(packages).where(eq(packages.productId, productId)),
        product.vendorId
          ? db.select().from(vendors).where(eq(vendors.id, product.vendorId))
          : Promise.resolve([]),
        db
          .select()
          .from(productPricingProfiles)
          .where(eq(productPricingProfiles.productId, productId)),
        db.select().from(productSales).where(eq(productSales.productId, productId))
      ]);

      let packageMetaRows = [];
      try {
        packageMetaRows = await db
          .select()
          .from(localLinePackageMeta)
          .where(eq(localLinePackageMeta.productId, productId));
      } catch (error) {
        if (!isMissingTableError(error, "local_line_package_meta")) throw error;
      }

      const snapshot = computeProductPricingSnapshot({
        product,
        packages: packageRows,
        packageMetaByPackageId: new Map(
          packageMetaRows.map((row) => [Number(row.packageId), row])
        ),
        vendor: vendorRows[0] || null,
        profile: profileRows[0]
          ? {
              ...profileRows[0],
              onSale: saleRows[0]?.onSale ?? profileRows[0].onSale ?? 0,
              saleDiscount: saleRows[0]?.saleDiscount ?? profileRows[0].saleDiscount ?? 0
            }
          : {
              productId,
              onSale: saleRows[0]?.onSale ?? 0,
              saleDiscount: saleRows[0]?.saleDiscount ?? 0
            }
      });

      if (!Number.isFinite(Number(snapshot.profile.sourceUnitPrice))) {
        results.push({
          productId,
          ok: false,
          message: "Source unit price is required before remote apply."
        });
        continue;
      }

      const pricedPackages = snapshot.packageRows.filter((row) => Number.isFinite(Number(row.basePrice)));
      if (!pricedPackages.length) {
        results.push({
          productId,
          ok: false,
          message: "No package prices could be derived for this product."
        });
        continue;
      }

      for (const packageRow of pricedPackages) {
        await db
          .update(packages)
          .set({ price: packageRow.basePrice })
          .where(eq(packages.id, packageRow.id));
      }

      const salePayload = {
        productId,
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        updatedAt: now
      };
      const saleChanged = !saleRows.length || !saleValuesMatch(saleRows[0], salePayload);
      if (saleChanged && saleRows.length) {
        await db
          .update(productSales)
          .set(salePayload)
          .where(eq(productSales.productId, productId));
      } else if (saleChanged) {
        await db.insert(productSales).values(salePayload);
      }

      const profilePayload = {
        unitOfMeasure: snapshot.profile.unitOfMeasure,
        sourceUnitPrice: snapshot.profile.sourceUnitPrice,
        minWeight: snapshot.profile.minWeight,
        maxWeight: snapshot.profile.maxWeight,
        avgWeightOverride: snapshot.profile.avgWeightOverride,
        sourceMultiplier: snapshot.profile.sourceMultiplier,
        guestMarkup: snapshot.profile.guestMarkup,
        memberMarkup: snapshot.profile.memberMarkup,
        herdShareMarkup: snapshot.profile.herdShareMarkup,
        snapMarkup: snapshot.profile.snapMarkup,
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        priceChangedAt: profileRows[0]?.priceChangedAt || profileRows[0]?.updatedAt || now,
        remoteSyncStatus: "applied",
        remoteSyncMessage: "Applied to store pricing and remote sync completed.",
        remoteSyncedAt: now,
        updatedAt: profileRows[0]?.updatedAt || now
      };
      if (profileRows.length) {
        await db
          .update(productPricingProfiles)
          .set(profilePayload)
          .where(eq(productPricingProfiles.productId, productId));
      } else {
        await db.insert(productPricingProfiles).values({
          productId,
          ...profilePayload,
          createdAt: now
        });
      }

      const remoteResult = await updateLocalLineForProduct(db, productId, {
        visible: product.visible,
        trackInventory: product.trackInventory,
        inventory: product.inventory,
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        forcePriceSync: true,
        forceImageSync: true
      });
      const remoteFailed =
        isLocalLineEnabled() &&
        (remoteResult.inventoryOk === false || remoteResult.priceOk === false);
      if (remoteFailed) {
        await db
          .update(productPricingProfiles)
          .set({
            remoteSyncStatus: "failed",
            remoteSyncMessage: "Local store updated, but Local Line sync failed.",
            updatedAt: now
          })
          .where(eq(productPricingProfiles.productId, productId));
      }

      results.push({
        productId,
        ok: !remoteFailed,
        packageUpdates: pricedPackages.length,
        remoteInventoryUpdate: remoteResult.inventoryOk,
        remotePriceUpdate: remoteResult.priceOk,
        message: remoteFailed
          ? "Local store updated, but Local Line sync failed."
          : "Changes applied."
      });
    } catch (error) {
      await db
        .update(productPricingProfiles)
        .set({
          remoteSyncStatus: "failed",
          remoteSyncMessage: error?.message || "Remote apply failed.",
          updatedAt: new Date()
        })
        .where(eq(productPricingProfiles.productId, productId));
      results.push({
        productId,
        ok: false,
        message: error?.message || "Remote apply failed."
      });
    }
  }

  res.json({ results });
});

router.post("/pricelist/export-google", requireAdminPermission("pricing_admin"), async (_req, res) => {
  try {
    const summary = await exportMasterPricelist({
      nodeEnv: process.env.NODE_ENV || "production",
      vendorNameMatcher: isGooglePricelistVendorName
    });

    res.json({
      ok: true,
      rowCount: summary.rowCount,
      highlightedRowCount: summary.highlightedRowCount || 0,
      spreadsheetSummary: summary.spreadsheetSummary,
      vendorNames: summary.vendorNames
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Google pricelist export failed."
    });
  }
});

router.post("/pricelist/cleanup-recent-change-false-positives", requireAdminPermission("pricing_admin"), async (_req, res) => {
  const db = getDb();

  try {
    const [saleRows, profileRows] = await Promise.all([
      db.select().from(productSales),
      db.select().from(productPricingProfiles)
    ]);
    const profileByProductId = new Map(
      profileRows.map((row) => [Number(row.productId), row])
    );

    let cleaned = 0;
    const cleanedProductIds = [];

    for (const saleRow of saleRows) {
      const productId = Number(saleRow.productId);
      const profileRow = profileByProductId.get(productId);
      if (!profileRow) continue;
      if (!saleValuesMatch(saleRow, profileRow)) continue;
      if (toTimestamp(saleRow.updatedAt) <= toTimestamp(profileRow.updatedAt)) continue;

      await db
        .update(productSales)
        .set({
          updatedAt: profileRow.updatedAt
        })
        .where(eq(productSales.productId, productId));

      cleaned += 1;
      cleanedProductIds.push(productId);
    }

    return res.json({
      ok: true,
      cleaned,
      productIds: cleanedProductIds
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Unable to clean recent-change false positives."
    });
  }
});

router.get("/categories", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(categories);
  res.json({ categories: rows });
});

router.get("/vendors", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(vendors);
  res.json({ vendors: rows });
});

const LOCAL_LINE_FULFILLMENT_JOB_PHASES = [
  { key: "fetch", label: "Fetch Fulfillments" },
  { key: "store", label: "Store Fulfillments" },
  { key: "finalize", label: "Finalize" }
];

const LOCAL_LINE_ORDER_JOB_PHASES = [
  { key: "fetch", label: "Fetch Orders" },
  { key: "store", label: "Store Orders" },
  { key: "finalize", label: "Finalize" }
];

async function syncLocalLineFulfillmentStrategiesToStore({ reportProgress = () => {} } = {}) {
  const strategies = await fetchAllLocalLineFulfillmentStrategies();
  const now = new Date();
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Fetch Fulfillments",
      status: "completed",
      percent: 100,
      current: strategies.length,
      total: strategies.length,
      message: `Fetched ${strategies.length} fulfillment strategies`
    });
    reportProgress({
      phaseKey: "store",
      phaseLabel: "Store Fulfillments",
      status: "running",
      percent: 0,
      current: 0,
      total: strategies.length,
      message: "Writing Local Line fulfillments to store"
    });

    await connection.beginTransaction();
    await upsertLocalLineSyncCursor(connection, "fulfillments", {
      lastStartedAt: now,
      lastStatus: "running",
      lastMessage: "Syncing fulfillment strategies",
      updatedAt: now
    });

    let stored = 0;
    const syncedIds = [];

    for (const strategy of strategies) {
      const strategyId = Number(strategy?.id);
      if (!Number.isFinite(strategyId)) continue;

      const availability = strategy?.availability || {};
      const address = strategy?.address || {};
      const timeRange = deriveDropSiteTimeRange(availability);
      const name = toNullableString(strategy?.name) || `Fulfillment ${strategyId}`;
      const addressText =
        toNullableString(address?.formatted_address) ||
        toNullableString(address?.street_address) ||
        null;

      await connection.query(
        `
          INSERT INTO drop_sites (
            name,
            address,
            day_of_week,
            open_time,
            close_time,
            active,
            source,
            local_line_fulfillment_strategy_id,
            type,
            fulfillment_type,
            timezone,
            latitude,
            longitude,
            instructions,
            address_json,
            availability_json,
            price_lists_json,
            raw_json,
            created_at,
            updated_at,
            last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            address = VALUES(address),
            day_of_week = VALUES(day_of_week),
            open_time = VALUES(open_time),
            close_time = VALUES(close_time),
            active = VALUES(active),
            source = VALUES(source),
            type = VALUES(type),
            fulfillment_type = VALUES(fulfillment_type),
            timezone = VALUES(timezone),
            latitude = VALUES(latitude),
            longitude = VALUES(longitude),
            instructions = VALUES(instructions),
            address_json = VALUES(address_json),
            availability_json = VALUES(availability_json),
            price_lists_json = VALUES(price_lists_json),
            raw_json = VALUES(raw_json),
            updated_at = VALUES(updated_at),
            last_synced_at = VALUES(last_synced_at)
        `,
        [
          name,
          addressText,
          deriveDropSiteDayLabel(availability),
          timeRange.openTime,
          timeRange.closeTime,
          strategy?.active ? 1 : 0,
          "localline",
          strategyId,
          toNullableString(strategy?.type),
          toNullableString(strategy?.fulfillment_type),
          toNullableString(availability?.timezone),
          toDbDecimal(address?.latitude),
          toDbDecimal(address?.longitude),
          toNullableString(availability?.instructions),
          stringifyJson(address),
          stringifyJson(availability),
          stringifyJson(strategy?.price_lists || []),
          stringifyJson(strategy),
          now,
          now,
          now
        ]
      );

      syncedIds.push(strategyId);
      stored += 1;
      reportProgress({
        phaseKey: "store",
        phaseLabel: "Store Fulfillments",
        status: "running",
        percent: strategies.length ? Math.round((stored / strategies.length) * 100) : 100,
        current: stored,
        total: strategies.length,
        message: `Stored ${stored} of ${strategies.length} fulfillment strategies`
      });
    }

    let deactivated = 0;
    if (syncedIds.length) {
      const [result] = await connection.query(
        `
          UPDATE drop_sites
          SET active = 0, updated_at = ?, last_synced_at = ?
          WHERE source = 'localline'
            AND local_line_fulfillment_strategy_id IS NOT NULL
            AND local_line_fulfillment_strategy_id NOT IN (?)
        `,
        [now, now, syncedIds]
      );
      deactivated = Number(result?.affectedRows || 0);
    } else {
      const [result] = await connection.query(
        `
          UPDATE drop_sites
          SET active = 0, updated_at = ?, last_synced_at = ?
          WHERE source = 'localline'
            AND local_line_fulfillment_strategy_id IS NOT NULL
        `,
        [now, now]
      );
      deactivated = Number(result?.affectedRows || 0);
    }

    const summary = {
      fetched: strategies.length,
      stored,
      deactivated
    };

    await upsertLocalLineSyncCursor(connection, "fulfillments", {
      cursorValue: syncedIds.length ? String(Math.max(...syncedIds)) : null,
      syncedThroughAt: now,
      lastStartedAt: now,
      lastFinishedAt: now,
      lastStatus: "completed",
      lastMessage: `Stored ${stored} fulfillment strategies`,
      summaryJson: stringifyJson(summary),
      updatedAt: now
    });

    await connection.commit();
    reportProgress({
      phaseKey: "store",
      phaseLabel: "Store Fulfillments",
      status: "completed",
      percent: 100,
      current: stored,
      total: strategies.length,
      message: `Stored ${stored} fulfillment strategies`
    });
    reportProgress({
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Fulfillment sync complete"
    });
    return summary;
  } catch (error) {
    await connection.rollback();
    await upsertLocalLineSyncCursor(connection, "fulfillments", {
      lastStartedAt: now,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Fulfillment sync failed",
      updatedAt: new Date()
    }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function syncLocalLineOrdersToStore({ reportProgress = () => {}, cutoffDate } = {}) {
  const effectiveCutoffDate = toDateOrNull(cutoffDate) || new Date("2026-01-01T00:00:00.000Z");
  const pool = getPool();
  const connection = await pool.getConnection();
  const startedAt = new Date();

  try {
    await connection.beginTransaction();
    const existingCursor = await getLocalLineSyncCursorRow(connection, "orders");
    await upsertLocalLineSyncCursor(connection, "orders", {
      cursorValue: existingCursor?.cursorValue || null,
      syncedThroughAt: existingCursor?.syncedThroughAt || null,
      lastStartedAt: startedAt,
      lastFinishedAt: existingCursor?.lastFinishedAt || null,
      lastStatus: "running",
      lastMessage: "Syncing orders",
      summaryJson: existingCursor?.summaryJson || null,
      createdAt: existingCursor?.createdAt || startedAt,
      updatedAt: startedAt
    });
    const backfilledOrderRows = await backfillLocalLineOrderFulfillmentFields(connection);
    await connection.commit();

    let page = 1;
    let totalFetched = 0;
    let stored = 0;
    let newestOrderId = Number(existingCursor?.cursorValue || 0);
    let newestCreatedAt = toDateOrNull(existingCursor?.syncedThroughAt);
    let reachedCursor = false;
    let reachedCutoff = false;
    let totalAvailable = null;

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Fetch Orders",
      status: "running",
      percent: 0,
      current: 0,
      total: null,
      message: `Fetching orders since ${effectiveCutoffDate.toISOString().slice(0, 10)}`
    });

    while (!reachedCursor && !reachedCutoff) {
      const payload = await fetchLocalLineOrdersPage({ page, pageSize: 100, ordering: "-id" });
      const orders = Array.isArray(payload?.results) ? payload.results : [];
      totalAvailable = Number(payload?.count || totalAvailable || 0);

      if (!orders.length) {
        break;
      }

      reportProgress({
        phaseKey: "fetch",
        phaseLabel: "Fetch Orders",
        status: "running",
        percent: totalAvailable ? Math.min(95, Math.round((totalFetched / totalAvailable) * 100)) : 0,
        current: totalFetched,
        total: totalAvailable,
        message: `Fetched page ${page}`
      });

      await connection.beginTransaction();

      for (const order of orders) {
        const remoteOrderId = Number(order?.id);
        if (!Number.isFinite(remoteOrderId)) continue;

        const createdAtRemote = toDateOrNull(order?.created_at);
        if (createdAtRemote && createdAtRemote < effectiveCutoffDate) {
          reachedCutoff = true;
          break;
        }
        if (Number(existingCursor?.cursorValue || 0) > 0 && remoteOrderId <= Number(existingCursor.cursorValue)) {
          reachedCursor = true;
          break;
        }

        totalFetched += 1;
        const customer = order?.customer || {};
        const fulfillment = order?.fulfillment || {};
        const payment = order?.payment || {};
        const orderEntries = Array.isArray(order?.order_entries) ? order.order_entries : [];
        const now = new Date();

        await connection.query(
          `
            INSERT INTO local_line_orders (
              local_line_order_id,
              status,
              price_list_id,
              price_list_name,
              customer_id,
              customer_name,
              created_at_remote,
              updated_at_remote,
              opened_at_remote,
              fulfillment_strategy_id,
              fulfillment_strategy_name,
              fulfillment_type,
              fulfillment_status,
              fulfillment_date,
              pickup_start_time,
              pickup_end_time,
              payment_status,
              subtotal,
              tax,
              total,
              discount,
              product_count,
              raw_json,
              created_at,
              updated_at,
              last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              status = VALUES(status),
              price_list_id = VALUES(price_list_id),
              price_list_name = VALUES(price_list_name),
              customer_id = VALUES(customer_id),
              customer_name = VALUES(customer_name),
              created_at_remote = VALUES(created_at_remote),
              updated_at_remote = VALUES(updated_at_remote),
              opened_at_remote = VALUES(opened_at_remote),
              fulfillment_strategy_id = VALUES(fulfillment_strategy_id),
              fulfillment_strategy_name = VALUES(fulfillment_strategy_name),
              fulfillment_type = VALUES(fulfillment_type),
              fulfillment_status = VALUES(fulfillment_status),
              fulfillment_date = VALUES(fulfillment_date),
              pickup_start_time = VALUES(pickup_start_time),
              pickup_end_time = VALUES(pickup_end_time),
              payment_status = VALUES(payment_status),
              subtotal = VALUES(subtotal),
              tax = VALUES(tax),
              total = VALUES(total),
              discount = VALUES(discount),
              product_count = VALUES(product_count),
              raw_json = VALUES(raw_json),
              updated_at = VALUES(updated_at),
              last_synced_at = VALUES(last_synced_at)
          `,
          [
            remoteOrderId,
            toNullableString(order?.status),
            toOptionalInteger(order?.price_list, null),
            toNullableString(order?.price_list_name),
            toOptionalInteger(order?.customer_id, null),
            formatOrderCustomerName(customer),
            createdAtRemote,
            toDateOrNull(order?.updated_at),
            toDateOrNull(order?.opened_at),
            toOptionalInteger(fulfillment?.fulfillment_strategy, null),
            toNullableString(fulfillment?.fulfillment_strategy_name),
            toNullableString(
              fulfillment?.type_display ||
              fulfillment?.fulfillment_strategy_type ||
              fulfillment?.type ||
              fulfillment?.fulfillment_type
            ),
            toNullableString(fulfillment?.status),
            toDateOrNull(fulfillment?.fulfillment_date),
            toNullableString(fulfillment?.pickup_start_time),
            toNullableString(fulfillment?.pickup_end_time),
            toNullableString(payment?.status),
            toDbDecimal(order?.subtotal),
            toDbDecimal(order?.tax),
            toDbDecimal(order?.total),
            toDbDecimal(order?.discount),
            toOptionalInteger(order?.product_count, null),
            stringifyJson(order),
            now,
            now,
            now
          ]
        );

        await connection.query(
          "DELETE FROM local_line_order_entries WHERE local_line_order_id = ?",
          [remoteOrderId]
        );

        for (const entry of orderEntries) {
          const remoteEntryId = Number(entry?.id);
          if (!Number.isFinite(remoteEntryId)) continue;

          await connection.query(
            `
              INSERT INTO local_line_order_entries (
                local_line_order_entry_id,
                local_line_order_id,
                product_id,
                product_name,
                package_name,
                vendor_id,
                vendor_name,
                category_name,
                unit_quantity,
                inventory_quantity,
                price,
                total_price,
                price_per_unit,
                charge_type,
                track_type,
                pack_weight,
                raw_json,
                created_at,
                updated_at,
                last_synced_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                local_line_order_id = VALUES(local_line_order_id),
                product_id = VALUES(product_id),
                product_name = VALUES(product_name),
                package_name = VALUES(package_name),
                vendor_id = VALUES(vendor_id),
                vendor_name = VALUES(vendor_name),
                category_name = VALUES(category_name),
                unit_quantity = VALUES(unit_quantity),
                inventory_quantity = VALUES(inventory_quantity),
                price = VALUES(price),
                total_price = VALUES(total_price),
                price_per_unit = VALUES(price_per_unit),
                charge_type = VALUES(charge_type),
                track_type = VALUES(track_type),
                pack_weight = VALUES(pack_weight),
                raw_json = VALUES(raw_json),
                updated_at = VALUES(updated_at),
                last_synced_at = VALUES(last_synced_at)
            `,
            [
              remoteEntryId,
              remoteOrderId,
              toOptionalInteger(entry?.product, null),
              toNullableString(entry?.product_name || entry?.custom_entry_product_name),
              toNullableString(entry?.package_name),
              toOptionalInteger(entry?.vendor_id, null),
              toNullableString(entry?.vendor_name),
              toNullableString(entry?.category),
              toDbDecimal(entry?.unit_quantity),
              toDbDecimal(entry?.inventory_quantity),
              toDbDecimal(entry?.price),
              toDbDecimal(entry?.total_price),
              toNullableString(entry?.price_per_unit),
              toNullableString(entry?.charge_type),
              toNullableString(entry?.track_type),
              toDbDecimal(entry?.pack_weight),
              stringifyJson(entry),
              now,
              now,
              now
            ]
          );
        }

        stored += 1;
        if (remoteOrderId > newestOrderId) {
          newestOrderId = remoteOrderId;
        }
        if (createdAtRemote && (!newestCreatedAt || createdAtRemote > newestCreatedAt)) {
          newestCreatedAt = createdAtRemote;
        }
      }

      await connection.commit();

      reportProgress({
        phaseKey: "store",
        phaseLabel: "Store Orders",
        status: "running",
        percent: totalAvailable ? Math.min(95, Math.round((totalFetched / totalAvailable) * 100)) : 0,
        current: stored,
        total: totalAvailable,
        message: `Stored ${stored} orders`
      });

      if (reachedCursor || reachedCutoff || !payload?.next) {
        break;
      }

      page += 1;
    }

    await connection.beginTransaction();
    const finishedAt = new Date();
    const summary = {
      cutoffDate: effectiveCutoffDate.toISOString(),
      fetched: totalFetched,
      stored,
      backfilledOrderRows,
      newestOrderId: newestOrderId || null,
      newestCreatedAt: newestCreatedAt ? newestCreatedAt.toISOString() : null,
      reachedCursor,
      reachedCutoff
    };
    await upsertLocalLineSyncCursor(connection, "orders", {
      cursorValue: newestOrderId ? String(newestOrderId) : existingCursor?.cursorValue || null,
      syncedThroughAt: newestCreatedAt || existingCursor?.syncedThroughAt || null,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastStatus: "completed",
      lastMessage: `Stored ${stored} orders`,
      summaryJson: stringifyJson(summary),
      createdAt: existingCursor?.createdAt || startedAt,
      updatedAt: finishedAt
    });
    await connection.commit();

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Fetch Orders",
      status: "completed",
      percent: 100,
      current: totalFetched,
      total: totalAvailable,
      message: `Fetched ${totalFetched} new orders`
    });
    reportProgress({
      phaseKey: "store",
      phaseLabel: "Store Orders",
      status: "completed",
      percent: 100,
      current: stored,
      total: totalAvailable,
      message: `Stored ${stored} orders`
    });
    reportProgress({
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Order sync complete"
    });
    return summary;
  } catch (error) {
    await connection.rollback().catch(() => {});
    await upsertLocalLineSyncCursor(connection, "orders", {
      lastStartedAt: startedAt,
      lastFinishedAt: new Date(),
      lastStatus: "failed",
      lastMessage: error?.message || "Order sync failed",
      updatedAt: new Date()
    }).catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

router.get("/drop-sites", requireAdmin, async (_req, res) => {
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/drop-sites:", error.message);
  });
  const pool = getPool();
  const requestedMonth = String(_req.query?.month || "").trim();
  const completedFulfillmentCutoff = startOfDay(new Date());
  const completedWeekCutoff = startOfWeek(completedFulfillmentCutoff);
  const latestCompletedWeekStart = addDays(completedWeekCutoff, -7);
  const fulfillmentDateSql = getFulfillmentDateSql("o");
  const fulfillmentStrategyIdSql = getFulfillmentStrategyIdSql("o");
  const fulfillmentSiteSql = getFulfillmentSiteNameSql("o", "ds");

  const [siteRows] = await pool.query(
    `
      SELECT
        id,
        name,
        address,
        day_of_week AS dayOfWeek,
        open_time AS openTime,
        close_time AS closeTime,
        active,
        source,
        local_line_fulfillment_strategy_id AS localLineFulfillmentStrategyId,
        type,
        fulfillment_type AS fulfillmentType,
        timezone,
        latitude,
        longitude,
        instructions,
        address_json AS addressJson,
        availability_json AS availabilityJson,
        price_lists_json AS priceListsJson,
        raw_json AS rawJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_synced_at AS lastSyncedAt
      FROM drop_sites
      ORDER BY active DESC, name ASC
    `
  );

  const normalizedSites = siteRows.map((row) => ({
    ...row,
    active: Boolean(row.active),
    isOnlineOnlyMembership: isMembershipPurchaseDropSite(row),
    derivedHostContact: extractDropSiteHostContact(row)
  }));

  const visibleDropSites = normalizedSites.filter((site) => !site.isOnlineOnlyMembership);

  const [monthRows] = await pool.query(
    `
      SELECT DISTINCT DATE_FORMAT(${fulfillmentDateSql}, '%Y-%m') AS value
      FROM local_line_orders o
      WHERE ${fulfillmentDateSql} IS NOT NULL
        AND ${fulfillmentDateSql} < ?
      ORDER BY value DESC
    `,
    [completedFulfillmentCutoff]
  );
  const performanceMonths = monthRows.map((row) => row.value).filter(Boolean);
  const trendModeKey = "__trend6__";
  const isTrendMode = requestedMonth === trendModeKey && performanceMonths.length > 0;
  const selectedMonth =
    !isTrendMode && performanceMonths.includes(requestedMonth)
      ? requestedMonth
      : (performanceMonths[0] || "");
  const trendMonths = isTrendMode ? performanceMonths.slice(0, 6).reverse() : [];
  const trendWeeks = [];
  if (isTrendMode && trendMonths.length) {
    const earliestMonth = parseMonthKey(trendMonths[0]);
    const latestMonth = parseMonthKey(trendMonths[trendMonths.length - 1]);
    if (earliestMonth && latestMonth) {
      let currentWeekStart = startOfWeek(earliestMonth.start);
      while (currentWeekStart < latestMonth.end) {
        if (currentWeekStart <= latestCompletedWeekStart) {
          trendWeeks.push({
            weekStart: formatDateKey(currentWeekStart),
            month: formatMonthKey(currentWeekStart)
          });
        }
        currentWeekStart = addDays(currentWeekStart, 7);
      }
    }
  }
  const monthsForData = isTrendMode
    ? performanceMonths.slice(0, 6)
    : [selectedMonth].filter(Boolean);

  let rankedSites = [];
  if (monthsForData.length) {
    const monthPlaceholders = monthsForData.map(() => "?").join(", ");
    const [orderRows] = await pool.query(
      `
        SELECT
          ${fulfillmentStrategyIdSql} AS fulfillmentStrategyId,
          ${fulfillmentSiteSql} AS fulfillmentSiteName,
          ${fulfillmentDateSql} AS fulfillmentDate
        FROM local_line_orders o
        LEFT JOIN drop_sites ds
          ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
        WHERE ${fulfillmentDateSql} IS NOT NULL
          AND ${fulfillmentDateSql} < ?
          AND DATE_FORMAT(${fulfillmentDateSql}, '%Y-%m') IN (${monthPlaceholders})
      `,
      [completedFulfillmentCutoff, ...monthsForData]
    );

    const orderGroupsByKeyMonth = new Map();

    for (const row of orderRows) {
      const siteName = String(row.fulfillmentSiteName || "Unassigned").trim();
      const fulfillmentDate = toDateOrNull(row.fulfillmentDate);
      const strategyId = Number(row.fulfillmentStrategyId || 0);
      const monthKey = formatMonthKey(fulfillmentDate);
      const siteKey = strategyId > 0 ? `id:${strategyId}` : `name:${siteName}`;
      const bucketKey = `${siteKey}|${monthKey}`;
      const existing = orderGroupsByKeyMonth.get(bucketKey) || [];
      existing.push({ fulfillmentDate });
      orderGroupsByKeyMonth.set(bucketKey, existing);
    }

    rankedSites = visibleDropSites
      .map((site) => {
        const strategyId = Number(site.localLineFulfillmentStrategyId || 0);
        const siteKey = strategyId > 0 ? `id:${strategyId}` : `name:${site.name}`;
        const trendSeries = isTrendMode
          ? trendWeeks
              .map((week) => {
              const weekStart = toDateOrNull(week.weekStart);
              const weekEnd = addDays(weekStart, 7);
              const monthKey = formatMonthKey(weekStart);
              const groupedRows = orderGroupsByKeyMonth.get(`${siteKey}|${monthKey}`) || [];
              const fulfillmentDates = groupedRows
                .map((row) => row.fulfillmentDate)
                .filter((value) => isDateInRange(value, weekStart, weekEnd));
              const orderCount = fulfillmentDates.length;
              const scheduledDrops = getDropSiteScheduledDropCountForRange(
                site,
                weekStart,
                weekEnd,
                fulfillmentDates
              );
              const averageWeeklyOrders =
                scheduledDrops > 0 ? Number((orderCount / scheduledDrops).toFixed(2)) : 0;
              return {
                weekStart: week.weekStart,
                month: week.month,
                orderCount,
                scheduledDrops,
                averageWeeklyOrders,
                performanceTier: getDropSitePerformanceTier(averageWeeklyOrders)
              };
            })
              .filter((entry) => {
                const weekStart = toDateOrNull(entry.weekStart);
                return weekStart instanceof Date && weekStart <= latestCompletedWeekStart;
              })
          : monthsForData.map((monthKey) => {
              const groupedRows = orderGroupsByKeyMonth.get(`${siteKey}|${monthKey}`) || [];
              const fulfillmentDates = groupedRows.map((row) => row.fulfillmentDate).filter(Boolean);
              const orderCount = groupedRows.length;
              const monthInfo = parseMonthKey(monthKey);
              const rangeEnd =
                monthInfo && monthInfo.end > completedFulfillmentCutoff
                  ? completedFulfillmentCutoff
                  : monthInfo?.end || null;
              const scheduledDrops =
                monthInfo && rangeEnd && rangeEnd > monthInfo.start
                  ? getDropSiteScheduledDropCountForRange(
                      site,
                      monthInfo.start,
                      rangeEnd,
                      fulfillmentDates
                    )
                  : 0;
              const averageWeeklyOrders =
                scheduledDrops > 0 ? Number((orderCount / scheduledDrops).toFixed(2)) : 0;
              return {
                month: monthKey,
                orderCount,
                scheduledDrops,
                averageWeeklyOrders,
                performanceTier: getDropSitePerformanceTier(averageWeeklyOrders)
              };
            });

        const totalOrderCount = trendSeries.reduce((sum, entry) => sum + Number(entry.orderCount || 0), 0);
        const totalScheduledDrops = trendSeries.reduce((sum, entry) => sum + Number(entry.scheduledDrops || 0), 0);
        const averageWeeklyOrders =
          totalScheduledDrops > 0
            ? Number((totalOrderCount / totalScheduledDrops).toFixed(2))
            : 0;
        const latestAverageWeeklyOrders = Number(
          trendSeries[trendSeries.length - 1]?.averageWeeklyOrders || 0
        );

        return {
          id: site.id,
          name: site.name,
          source: site.source,
          active: site.active,
          localLineFulfillmentStrategyId: site.localLineFulfillmentStrategyId,
          orderCount: totalOrderCount,
          scheduledDrops: totalScheduledDrops,
          averageWeeklyOrders,
          latestAverageWeeklyOrders,
          thresholdMet: (isTrendMode ? latestAverageWeeklyOrders : averageWeeklyOrders) >= 4,
          performanceTier: getDropSitePerformanceTier(
            isTrendMode ? latestAverageWeeklyOrders : averageWeeklyOrders
          ),
          trendSeries
        };
      })
      .sort((left, right) => {
        const leftSortValue = isTrendMode
          ? Number(left.latestAverageWeeklyOrders || 0)
          : Number(left.averageWeeklyOrders || 0);
        const rightSortValue = isTrendMode
          ? Number(right.latestAverageWeeklyOrders || 0)
          : Number(right.averageWeeklyOrders || 0);
        if (rightSortValue !== leftSortValue) {
          return rightSortValue - leftSortValue;
        }
        if (right.averageWeeklyOrders !== left.averageWeeklyOrders) {
          return right.averageWeeklyOrders - left.averageWeeklyOrders;
        }
        if (right.orderCount !== left.orderCount) {
          return right.orderCount - left.orderCount;
        }
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
  }

  res.json({
    dropSites: visibleDropSites,
    performance: {
      mode: isTrendMode ? "trend6" : "month",
      selectedMonth: isTrendMode ? trendModeKey : selectedMonth,
      months: performanceMonths,
      trendMonths,
      trendWeeks,
      thresholdAverage: 4,
      strongAverage: 5,
      rankedSites
    }
  });
});

router.get("/localline/pull-jobs", requireAdmin, (_req, res) => {
  return res.json({ jobs: getLatestLocalLinePullJobs() });
});

router.get("/localline/pull-jobs/:jobId", requireAdmin, (req, res) => {
  const job = getLocalLinePullJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Local Line pull job not found" });
  }
  return res.json({ job });
});

router.get("/localline/pull-jobs/latest/:datasetKey", requireAdmin, (req, res) => {
  const job = getLatestLocalLinePullJob(req.params.datasetKey);
  if (!job) {
    return res.status(404).json({ error: "No Local Line pull job found for this dataset" });
  }
  return res.json({ job });
});

router.get("/localline/status", requireAdmin, async (_req, res) => {
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/localline/status:", error.message);
  });

  const db = getDb();
  const pool = getPool();
  const [productSummaryRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS cachedProducts,
        MAX(last_synced_at) AS lastSyncedAt
      FROM local_line_product_meta
    `
  );
  const [syncIssueRows] = await pool.query(
    `
      SELECT COUNT(*) AS syncIssues
      FROM local_line_sync_issues
      WHERE resolved_at IS NULL
    `
  );
  const [dropSiteSummaryRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS totalRows,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS activeRows,
        MAX(last_synced_at) AS lastSyncedAt
      FROM drop_sites
      WHERE source = 'localline'
    `
  );
  const [orderSummaryRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS totalRows,
        MAX(created_at_remote) AS latestCreatedAt,
        MAX(updated_at_remote) AS latestUpdatedAt,
        MAX(last_synced_at) AS lastSyncedAt
      FROM local_line_orders
    `
  );
  const [recentOrders] = await pool.query(
    `
      SELECT
        local_line_order_id AS localLineOrderId,
        created_at_remote AS createdAtRemote,
        updated_at_remote AS updatedAtRemote,
        status,
        price_list_name AS priceListName,
        customer_name AS customerName,
        total,
        product_count AS productCount
      FROM local_line_orders
      ORDER BY created_at_remote DESC, local_line_order_id DESC
      LIMIT 10
    `
  );
  const cursorRows = await db.select().from(localLineSyncCursors);
  const cursorByKey = Object.fromEntries(
    cursorRows.map((row) => [
      row.syncKey,
      {
        cursorValue: row.cursorValue,
        syncedThroughAt: row.syncedThroughAt,
        lastStartedAt: row.lastStartedAt,
        lastFinishedAt: row.lastFinishedAt,
        lastStatus: row.lastStatus,
        lastMessage: row.lastMessage,
        summaryJson: row.summaryJson
      }
    ])
  );

  return res.json({
    products: {
      cachedProducts: Number(productSummaryRows?.[0]?.cachedProducts || 0),
      lastSyncedAt: productSummaryRows?.[0]?.lastSyncedAt || null,
      syncIssues: Number(syncIssueRows?.[0]?.syncIssues || 0),
      latestJob: getLatestLocalLineFullSyncJob()
    },
    fulfillments: {
      totalRows: Number(dropSiteSummaryRows?.[0]?.totalRows || 0),
      activeRows: Number(dropSiteSummaryRows?.[0]?.activeRows || 0),
      lastSyncedAt: dropSiteSummaryRows?.[0]?.lastSyncedAt || null,
      cursor: cursorByKey.fulfillments || null,
      latestJob: getLatestLocalLinePullJob("fulfillments")
    },
    orders: {
      totalRows: Number(orderSummaryRows?.[0]?.totalRows || 0),
      latestCreatedAt: orderSummaryRows?.[0]?.latestCreatedAt || null,
      latestUpdatedAt: orderSummaryRows?.[0]?.latestUpdatedAt || null,
      lastSyncedAt: orderSummaryRows?.[0]?.lastSyncedAt || null,
      cursor: cursorByKey.orders || null,
      latestJob: getLatestLocalLinePullJob("orders"),
      recentOrders
    }
  });
});

router.get("/orders", requireAdmin, async (req, res) => {
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/orders:", error.message);
  });

  const pool = getPool();
  const search = String(req.query?.search || "").trim();
  const fulfillmentSite = String(req.query?.fulfillmentSite || "").trim();
  const vendor = String(req.query?.vendor || "").trim();
  const category = String(req.query?.category || "").trim();
  const status = String(req.query?.status || "").trim();
  const paymentStatus = String(req.query?.paymentStatus || "").trim();
  const month = String(req.query?.month || "").trim();
  const cycle = String(req.query?.cycle || "").trim();
  const requestedPageSize = parsePositiveInteger(req.query?.pageSize, PRICELIST_DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(PRICELIST_MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
  const requestedPage = parsePositiveInteger(req.query?.page, 1);
  const cycleSql = getOrderCycleSql("o");
  const fulfillmentStrategyIdSql = getFulfillmentStrategyIdSql("o");
  const fulfillmentTypeSql = getFulfillmentTypeSql("o");
  const fulfillmentStatusSql = getFulfillmentStatusSql("o");
  const fulfillmentDateSql = getFulfillmentDateSql("o");
  const pickupStartTimeSql = getPickupTimeSql("o", "pickup_start_time");
  const pickupEndTimeSql = getPickupTimeSql("o", "pickup_end_time");
  const fulfillmentSiteSql = getFulfillmentSiteNameSql("o", "ds");
  const whereClauses = [];
  const whereParams = [];

  if (search) {
    whereClauses.push(
      "(" +
        "CAST(o.local_line_order_id AS CHAR) LIKE ? " +
        "OR COALESCE(o.customer_name, '') LIKE ? " +
        `OR ${fulfillmentSiteSql} LIKE ? ` +
        "OR COALESCE(o.price_list_name, '') LIKE ?" +
      ")"
    );
    const searchLike = `%${search}%`;
    whereParams.push(searchLike, searchLike, searchLike, searchLike);
  }
  if (fulfillmentSite) {
    whereClauses.push(`${fulfillmentSiteSql} = ?`);
    whereParams.push(fulfillmentSite);
  }
  if (vendor) {
    whereClauses.push(
      `EXISTS (
        SELECT 1
        FROM local_line_order_entries e
        WHERE e.local_line_order_id = o.local_line_order_id
          AND COALESCE(e.vendor_name, '') = ?
      )`
    );
    whereParams.push(vendor);
  }
  if (category) {
    whereClauses.push(
      `EXISTS (
        SELECT 1
        FROM local_line_order_entries e
        WHERE e.local_line_order_id = o.local_line_order_id
          AND COALESCE(e.category_name, '') = ?
      )`
    );
    whereParams.push(category);
  }
  if (status) {
    whereClauses.push("COALESCE(o.status, '') = ?");
    whereParams.push(status);
  }
  if (paymentStatus) {
    whereClauses.push("COALESCE(o.payment_status, '') = ?");
    whereParams.push(paymentStatus);
  }
  if (month) {
    whereClauses.push("DATE_FORMAT(o.created_at_remote, '%Y-%m') = ?");
    whereParams.push(month);
  }
  if (cycle === "tuesday" || cycle === "fridaySaturday") {
    whereClauses.push(`${cycleSql.cycleType} = ?`);
    whereParams.push(cycle);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const [[countRow]] = await pool.query(
    `
      SELECT COUNT(*) AS totalRows
      FROM local_line_orders o
      LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
      ${whereSql}
    `,
    whereParams
  );
  const totalRows = Number(countRow?.totalRows || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;

  const [orderRows] = await pool.query(
    `
      SELECT
        o.local_line_order_id AS localLineOrderId,
        o.created_at_remote AS createdAtRemote,
        o.updated_at_remote AS updatedAtRemote,
        o.opened_at_remote AS openedAtRemote,
        ${fulfillmentStrategyIdSql} AS fulfillmentStrategyId,
        ${fulfillmentSiteSql} AS fulfillmentStrategyName,
        ${fulfillmentTypeSql} AS fulfillmentType,
        ${fulfillmentStatusSql} AS fulfillmentStatus,
        ${fulfillmentDateSql} AS fulfillmentDate,
        ${pickupStartTimeSql} AS pickupStartTime,
        ${pickupEndTimeSql} AS pickupEndTime,
        o.customer_name AS customerName,
        o.status,
        o.payment_status AS paymentStatus,
        o.price_list_name AS priceListName,
        o.total,
        o.subtotal,
        o.tax,
        o.discount,
        o.product_count AS productCount,
        ${cycleSql.cycleType} AS cycleType,
        ${cycleSql.cycleLabel} AS cycleLabel,
        ${cycleSql.cycleStartDate} AS cycleStartDate
      FROM local_line_orders o
      LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
      ${whereSql}
      ORDER BY o.created_at_remote DESC, o.local_line_order_id DESC
      LIMIT ? OFFSET ?
    `,
    [...whereParams, pageSize, offset]
  );

  const [siteRows] = await pool.query(
    `
      SELECT
        ${fulfillmentSiteSql} AS value,
        COUNT(*) AS orderCount
      FROM local_line_orders o
      LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
      WHERE ${fulfillmentSiteSql} <> 'Unassigned'
      GROUP BY ${fulfillmentSiteSql}
      ORDER BY orderCount DESC, value ASC
    `
  );
  const [statusRows] = await pool.query(
    `
      SELECT DISTINCT status AS value
      FROM local_line_orders
      WHERE status IS NOT NULL
        AND TRIM(status) <> ''
      ORDER BY status ASC
    `
  );
  const [paymentStatusRows] = await pool.query(
    `
      SELECT DISTINCT payment_status AS value
      FROM local_line_orders
      WHERE payment_status IS NOT NULL
        AND TRIM(payment_status) <> ''
      ORDER BY payment_status ASC
    `
  );
  const [monthRows] = await pool.query(
    `
      SELECT DISTINCT DATE_FORMAT(created_at_remote, '%Y-%m') AS value
      FROM local_line_orders
      WHERE created_at_remote IS NOT NULL
      ORDER BY value DESC
    `
  );
  const [vendorRows] = await pool.query(
    `
      SELECT DISTINCT vendor_name AS value
      FROM local_line_order_entries
      WHERE vendor_name IS NOT NULL
        AND TRIM(vendor_name) <> ''
      ORDER BY vendor_name ASC
    `
  );
  const [categoryRows] = await pool.query(
    `
      SELECT DISTINCT category_name AS value
      FROM local_line_order_entries
      WHERE category_name IS NOT NULL
        AND TRIM(category_name) <> ''
      ORDER BY category_name ASC
    `
  );

  const [[summaryRow]] = await pool.query(
    `
      SELECT
        COUNT(*) AS orderCount,
        COUNT(DISTINCT COALESCE(customer_id, 0), COALESCE(customer_name, '')) AS customerCount,
        COALESCE(SUM(total), 0) AS revenue,
        COALESCE(AVG(total), 0) AS averageOrderValue
      FROM local_line_orders o
      LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
      ${whereSql}
    `,
    whereParams
  );

  const metricsMonth =
    month ||
    monthRows.map((row) => row.value).find(Boolean) ||
    "";

  const [monthlyTrendRows] = await pool.query(
    `
      SELECT
        DATE_FORMAT(o.created_at_remote, '%Y-%m') AS month,
        COUNT(*) AS orderCount,
        COALESCE(SUM(o.total), 0) AS revenue,
        COUNT(DISTINCT ${fulfillmentSiteSql}) AS siteCount
      FROM local_line_orders o
      LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
      GROUP BY DATE_FORMAT(o.created_at_remote, '%Y-%m')
      ORDER BY month DESC
      LIMIT 6
    `
  );

  return res.json({
    orders: orderRows,
    pagination: {
      page,
      pageSize,
      totalRows,
      totalPages
    },
    filters: {
      fulfillmentSites: siteRows.map((row) => row.value).filter(Boolean),
      vendors: vendorRows.map((row) => row.value).filter(Boolean),
      categories: categoryRows.map((row) => row.value).filter(Boolean),
      statuses: statusRows.map((row) => row.value).filter(Boolean),
      paymentStatuses: paymentStatusRows.map((row) => row.value).filter(Boolean),
      months: monthRows.map((row) => row.value).filter(Boolean)
    },
    metrics: {
      overview: {
        orderCount: Number(summaryRow?.orderCount || 0),
        customerCount: Number(summaryRow?.customerCount || 0),
        revenue: Number(summaryRow?.revenue || 0),
        averageOrderValue: Number(summaryRow?.averageOrderValue || 0)
      },
      metricsMonth,
      monthlyTrend: monthlyTrendRows.map((row) => ({
        month: row.month,
        orderCount: Number(row.orderCount || 0),
        revenue: Number(row.revenue || 0),
        siteCount: Number(row.siteCount || 0)
      }))
    }
  });
});

router.get("/orders/:id", requireAdmin, async (req, res) => {
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/orders/:id:", error.message);
  });

  const orderId = Number(req.params.id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const pool = getPool();
  const [orderRows] = await pool.query(
    `
      SELECT
        o.*,
        ${getFulfillmentStrategyIdSql("o")} AS normalized_fulfillment_strategy_id,
        ${getFulfillmentTypeSql("o")} AS normalized_fulfillment_type,
        ${getFulfillmentStatusSql("o")} AS normalized_fulfillment_status,
        ${getFulfillmentDateSql("o")} AS normalized_fulfillment_date,
        ${getPickupTimeSql("o", "pickup_start_time")} AS normalized_pickup_start_time,
        ${getPickupTimeSql("o", "pickup_end_time")} AS normalized_pickup_end_time,
        ${getFulfillmentSiteNameSql("o", "ds")} AS normalized_fulfillment_strategy_name
      FROM local_line_orders
      o LEFT JOIN drop_sites ds
        ON ds.local_line_fulfillment_strategy_id = ${getFulfillmentStrategyIdSql("o")}
      WHERE local_line_order_id = ?
      LIMIT 1
    `,
    [orderId]
  );
  const order = orderRows[0] || null;
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const [entryRows] = await pool.query(
    `
      SELECT
        local_line_order_entry_id AS localLineOrderEntryId,
        product_id AS productId,
        product_name AS productName,
        package_name AS packageName,
        vendor_id AS vendorId,
        vendor_name AS vendorName,
        category_name AS categoryName,
        unit_quantity AS unitQuantity,
        inventory_quantity AS inventoryQuantity,
        price,
        total_price AS totalPrice,
        price_per_unit AS pricePerUnit,
        charge_type AS chargeType,
        track_type AS trackType,
        pack_weight AS packWeight,
        raw_json AS rawJson
      FROM local_line_order_entries
      WHERE local_line_order_id = ?
      ORDER BY vendor_name ASC, product_name ASC, local_line_order_entry_id ASC
    `,
    [orderId]
  );

  return res.json({
    order: {
      localLineOrderId: order.local_line_order_id,
      status: order.status,
      priceListId: order.price_list_id,
      priceListName: order.price_list_name,
      customerId: order.customer_id,
      customerName: order.customer_name,
      createdAtRemote: order.created_at_remote,
      updatedAtRemote: order.updated_at_remote,
      openedAtRemote: order.opened_at_remote,
      fulfillmentStrategyId: order.normalized_fulfillment_strategy_id,
      fulfillmentStrategyName: order.normalized_fulfillment_strategy_name,
      fulfillmentType: order.normalized_fulfillment_type,
      fulfillmentStatus: order.normalized_fulfillment_status,
      fulfillmentDate: order.normalized_fulfillment_date,
      pickupStartTime: order.normalized_pickup_start_time,
      pickupEndTime: order.normalized_pickup_end_time,
      paymentStatus: order.payment_status,
      subtotal: order.subtotal,
      tax: order.tax,
      total: order.total,
      discount: order.discount,
      productCount: order.product_count,
      rawJson: order.raw_json || null,
      lastSyncedAt: order.last_synced_at || null
    },
    entries: entryRows
  });
});

router.post("/localline/fulfillment-sync", requireAdminPermission(["dropsite_admin", "localline_pull"]), async (_req, res) => {
  if (!isLocalLineEnabled()) {
    return res.status(400).json({ error: "Local Line is not configured" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/localline/fulfillment-sync:", error.message);
  });

  const result = startLocalLinePullJob({
    datasetKey: "fulfillments",
    datasetLabel: "Local Line fulfillment sync",
    phases: LOCAL_LINE_FULFILLMENT_JOB_PHASES,
    run: ({ reportProgress }) => syncLocalLineFulfillmentStrategiesToStore({ reportProgress })
  });

  return res.status(result.alreadyRunning ? 200 : 202).json(result);
});

router.post("/localline/orders-sync", requireAdminPermission("localline_pull"), async (req, res) => {
  if (!isLocalLineEnabled()) {
    return res.status(400).json({ error: "Local Line is not configured" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/localline/orders-sync:", error.message);
  });

  const cutoffDate =
    toDateOrNull(req.body?.cutoffDate) || new Date("2026-01-01T00:00:00.000Z");

  const result = startLocalLinePullJob({
    datasetKey: "orders",
    datasetLabel: "Local Line order sync",
    phases: LOCAL_LINE_ORDER_JOB_PHASES,
    run: ({ reportProgress }) =>
      syncLocalLineOrdersToStore({
        reportProgress,
        cutoffDate
      })
  });

  return res.status(result.alreadyRunning ? 200 : 202).json(result);
});

router.get("/reviews", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(reviews);
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds))
    : [];
  const userMap = new Map(userRows.map((row) => [row.id, row.email]));

  res.json({
    reviews: rows.map((row) => ({
      ...row,
      userEmail: row.userId ? userMap.get(row.userId) || null : null
    }))
  });
});

router.get("/recipes", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(recipes);
  res.json({ recipes: rows });
});

router.post("/localline/audit", requireAdminPermission("localline_pull"), async (req, res) => {
  try {
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includeInactive = Boolean(req.body?.includeInactive);
    const includePricelist = Boolean(req.body?.includePricelist);

    const { summary } = await runLocalLineAudit({
      killdeerEnvPath: includePricelist ? process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined : undefined,
      includeInactive,
      skipPricelist: !includePricelist,
      limit: Number.isFinite(limit) ? limit : 20,
      concurrency: Number.isFinite(concurrency) ? concurrency : 5
    });

    res.json(summary);
  } catch (error) {
    console.error("LocalLine sync failed:", error);
    res.status(500).json({
      error: "Local Line sync failed",
      detail: error?.message || "Unknown error"
    });
  }
});

router.post("/localline/apply", requireAdminPermission("localline_pull"), async (req, res) => {
  try {
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includeInactive = Boolean(req.body?.includeInactive);
    const selectedFixKeys = Array.isArray(req.body?.fixKeys)
      ? req.body.fixKeys
      : req.body?.fixKey
        ? [req.body.fixKey]
        : [];

    const { summary } = await runLocalLineAudit({
      killdeerEnvPath: process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined,
      includeInactive,
      write: true,
      selectedFixKeys,
      limit: Number.isFinite(limit) ? limit : 20,
      concurrency: Number.isFinite(concurrency) ? concurrency : 5
    });

    res.json(summary);
  } catch (error) {
    console.error("LocalLine apply failed:", error);
    res.status(500).json({
      error: "Local Line apply failed",
      detail: error?.message || "Unknown error"
    });
  }
});

async function handleLocalLineFullSync(req, res) {
  try {
    await ensureLocalLineSyncSchema();
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includePricelist = Boolean(req.body?.includePricelist);
    const forceFull = Boolean(req.body?.forceFull);

    const result = startLocalLineFullSyncJob({
      killdeerEnvPath: includePricelist ? process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined : undefined,
      skipPricelist: !includePricelist,
      forceFull,
      limit: Number.isFinite(limit) ? limit : null,
      concurrency: Number.isFinite(concurrency) ? concurrency : 6
    });

    res.status(result.alreadyRunning ? 200 : 202).json(result);
  } catch (error) {
    console.error("LocalLine full sync failed:", error);
    res.status(500).json({
      error: "Local Line full sync failed",
      detail: error?.message || "Unknown error"
    });
  }
}

router.post("/localline/full-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.post("/localline/cache-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.post("/localline/products-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.get("/localline/full-sync", requireAdmin, (_req, res) => {
  const job = getLatestLocalLineFullSyncJob();
  if (!job) {
    return res.status(404).json({ error: "No Local Line full sync job found" });
  }
  return res.json({ job });
});
router.get("/localline/full-sync/:jobId", requireAdmin, (req, res) => {
  const job = getLocalLineFullSyncJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Local Line full sync job not found" });
  }
  return res.json({ job });
});

router.post("/categories", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(categories).values({ name: payload.name });
  res.json({ ok: true });
});

router.post("/vendors", requireAdminPermission("admin"), async (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Vendor name is required." });
  }

  const priceListMarkup = normalizeVendorMarkupInput(payload.priceListMarkup);
  const sourceMultiplier = normalizeVendorSourceMultiplierInput(payload.sourceMultiplier);
  const db = getDb();

  await db.insert(vendors).values({
    name,
    priceListMarkup: priceListMarkup ?? undefined,
    sourceMultiplier: sourceMultiplier ?? undefined,
    guestMarkup: priceListMarkup ?? undefined,
    memberMarkup: priceListMarkup ?? undefined
  });
  res.json({ ok: true });
});

router.put("/vendors/:id", requireAdminPermission("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid vendor id." });
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    const [existingRows] = await connection.query(
      `
        SELECT
          id,
          name,
          price_list_markup AS priceListMarkup,
          source_multiplier AS sourceMultiplier,
          guest_markup AS guestMarkup,
          member_markup AS memberMarkup
        FROM vendors
        WHERE id = ?
        LIMIT 1
      `,
      [id]
    );
    const existing = existingRows[0] || null;
    if (!existing) {
      return res.status(404).json({ error: "Vendor not found." });
    }

    const nextName = String(payload.name ?? existing.name ?? "").trim();
    if (!nextName) {
      return res.status(400).json({ error: "Vendor name is required." });
    }

    const nextPriceListMarkup =
      typeof payload.priceListMarkup === "undefined"
        ? normalizeVendorMarkupInput(existing.priceListMarkup)
        : normalizeVendorMarkupInput(payload.priceListMarkup);
    const nextSourceMultiplier =
      typeof payload.sourceMultiplier === "undefined"
        ? normalizeVendorSourceMultiplierInput(existing.sourceMultiplier)
        : normalizeVendorSourceMultiplierInput(payload.sourceMultiplier);

    await connection.beginTransaction();
    await connection.query(
      `
        UPDATE vendors
        SET name = ?,
            price_list_markup = ?,
            source_multiplier = ?,
            guest_markup = ?,
            member_markup = ?
        WHERE id = ?
      `,
      [
        nextName,
        nextPriceListMarkup,
        nextSourceMultiplier,
        nextPriceListMarkup,
        nextPriceListMarkup,
        id
      ]
    );

    const syncedProfiles = await syncVendorPricingDefaultsForProducts(
      connection,
      { id, name: nextName },
      {
        priceListMarkup: nextPriceListMarkup,
        sourceMultiplier: nextSourceMultiplier
      }
    );

    await connection.commit();
    res.json({ ok: true, syncedProfiles });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error?.message || "Unable to update vendor." });
  } finally {
    connection.release();
  }
});

router.post("/drop-sites", requireAdminPermission("dropsite_admin"), async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(dropSites).values({
    name: payload.name,
    address: payload.address,
    dayOfWeek: payload.dayOfWeek,
    openTime: payload.openTime,
    closeTime: payload.closeTime,
    active: payload.active ?? 1,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  res.json({ ok: true });
});

router.put("/drop-sites/:id", requireAdminPermission("dropsite_admin"), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(dropSites)
    .set({
      name: payload.name ?? undefined,
      address: payload.address ?? undefined,
      dayOfWeek: payload.dayOfWeek ?? undefined,
      openTime: payload.openTime ?? undefined,
      closeTime: payload.closeTime ?? undefined,
      active: payload.active ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(dropSites.id, id));
  res.json({ ok: true });
});

router.put("/reviews/:id", requireAdminPermission("member_admin"), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(reviews)
    .set({
      rating: payload.rating ?? undefined,
      title: payload.title ?? undefined,
      body: payload.body ?? undefined,
      status: payload.status ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(reviews.id, id));
  res.json({ ok: true });
});

router.post("/products", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const pool = getPool();
  const payload = req.body || {};
  const connection = await pool.getConnection();

  try {
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /admin/products POST:", error.message);
    });

    await connection.beginTransaction();
    const created = await createLocalProductRecord(connection, payload);
    if (Number.isFinite(Number(created.productRecord.vendorId))) {
      const [vendorRows] = await connection.query(
        "SELECT name FROM vendors WHERE id = ? LIMIT 1",
        [created.productRecord.vendorId]
      );
      const vendor = vendorRows[0] || null;
      if (isSourcePricingVendor(vendor)) {
        const pricingProfile = normalizePricingProfileInput(payload.pricingProfile || payload);
        validateSourcePricingProfile(pricingProfile);
        await upsertProductPricingProfileRecord(connection, created.productId, pricingProfile, {
          vendor: vendorRows[0] || null
        });
      }
    }
    await connection.commit();

    const db = getDb();
    await upsertLocalOnlyProductMeta(db, created.productId, created.productRecord);

    res.json({
      ok: true,
      productId: created.productId
    });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error?.message || "Unable to create product" });
  } finally {
    connection.release();
  }
});

router.post("/products/:id/duplicate", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const pool = getPool();
  const db = getDb();
  const sourceProductId = Number(req.params.id);
  if (!Number.isFinite(sourceProductId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  const connection = await pool.getConnection();

  try {
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /admin/products/:id/duplicate:", error.message);
    });

    await connection.beginTransaction();
    const created = await duplicateLocalProductRecord(connection, sourceProductId);
    await connection.commit();

    await upsertLocalOnlyProductMeta(db, created.productId, created.productRecord);

    res.json({
      ok: true,
      productId: created.productId
    });
  } catch (error) {
    await connection.rollback();
    const status = error?.message === "Product not found" ? 404 : 400;
    res.status(status).json({ error: error?.message || "Unable to duplicate product" });
  } finally {
    connection.release();
  }
});

router.delete("/products/:id", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const pool = getPool();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  const connection = await pool.getConnection();
  try {
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /admin/products/:id DELETE:", error.message);
    });

    await connection.beginTransaction();
    const deleted = await deleteLocalOnlyProductRecord(connection, productId);
    await connection.commit();
    return res.json({ ok: true, productId: deleted.productId });
  } catch (error) {
    await connection.rollback();
    const status = error?.message === "Product not found" ? 404 : 400;
    return res.status(status).json({ error: error?.message || "Unable to delete product" });
  } finally {
    connection.release();
  }
});

router.put("/products/:id", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const updates = req.body || {};

  await db
    .update(products)
    .set({
      name: updates.name ?? undefined,
      description: updates.description ?? undefined,
      visible: updates.visible ?? undefined,
      trackInventory: updates.trackInventory ?? undefined,
      inventory: updates.inventory ?? undefined,
      categoryId: updates.categoryId ?? undefined,
      vendorId: updates.vendorId ?? undefined,
      thumbnailUrl: updates.thumbnailUrl ?? undefined
    })
    .where(eq(products.id, id));

  res.json({ ok: true });
});

router.put("/products/:id/pricing-profile", requireAdminPermission(["pricing_admin", "local_pricelist_admin"]), async (req, res) => {
  const pool = getPool();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  const connection = await pool.getConnection();
  try {
    const [productRows] = await connection.query(
      "SELECT vendor_id AS vendorId FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    const product = productRows[0];
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const [vendorRows] = await connection.query(
      "SELECT name FROM vendors WHERE id = ? LIMIT 1",
      [product.vendorId]
    );
    const vendor = vendorRows[0] || null;
    if (!isSourcePricingVendor(vendor)) {
      return res.json({ ok: true, skipped: true });
    }

    const pricingProfile = normalizePricingProfileInput(req.body || {});
    validateSourcePricingProfile(pricingProfile);
    await upsertProductPricingProfileRecord(connection, productId, pricingProfile, {
      vendor
    });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Unable to update pricing profile" });
  } finally {
    connection.release();
  }
});

router.post("/products/:id/push-to-localline", requireAdminPermission("localline_push"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/products/:id/push-to-localline:", error.message);
  });

  try {
    const result = await createLocalLineProductFromStoreProduct(db, productId);
    return res.json({
      ok: true,
      alreadyLinked: Boolean(result.alreadyLinked),
      localLineProductId: result.localLineProductId || null
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Unable to push product to Local Line" });
  }
});

router.post("/products/bulk-update", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const db = getDb();
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const syncPricingProfileSale = Boolean(req.body?.syncPricingProfileSale);
  const applyRemote = req.body?.applyRemote !== false;
  const queueRemoteSync = Boolean(req.body?.queueRemoteSync);
  const results = [];

  for (const update of updates) {
    const productId = Number(update.productId);
    const changes = update.changes || {};
    if (!Number.isFinite(productId)) {
      results.push({ productId, databaseUpdate: false, localLineUpdate: null, localLinePriceUpdate: null });
      continue;
    }

    try {
      await db
        .update(products)
        .set({
          visible: changes.visible ?? undefined,
          trackInventory: changes.trackInventory ?? undefined,
          inventory: changes.inventory ?? undefined,
          updatedAt: new Date()
        })
        .where(eq(products.id, productId));

      const salePayload = {
        productId,
        onSale: changes.onSale ?? 0,
        saleDiscount: typeof changes.saleDiscount === "number" ? changes.saleDiscount : null,
        updatedAt: new Date()
      };

      const existingSale = await db
        .select()
        .from(productSales)
        .where(eq(productSales.productId, productId));

      const existingOnSale = existingSale.length ? Number(existingSale[0].onSale || 0) : 0;
      const nextOnSale = Number(salePayload.onSale || 0);
      const existingSaleDiscount =
        existingSale.length && existingSale[0].saleDiscount !== null && typeof existingSale[0].saleDiscount !== "undefined"
          ? Number(existingSale[0].saleDiscount)
          : null;
      const nextSaleDiscount =
        salePayload.saleDiscount === null || typeof salePayload.saleDiscount === "undefined"
          ? null
          : Number(salePayload.saleDiscount);
      const saleChanged =
        !existingSale.length ||
        existingOnSale !== nextOnSale ||
        (
          existingSaleDiscount === null || nextSaleDiscount === null
            ? existingSaleDiscount !== nextSaleDiscount
            : Number(existingSaleDiscount.toFixed(4)) !== Number(nextSaleDiscount.toFixed(4))
        );

      if (saleChanged && existingSale.length) {
        await db
          .update(productSales)
          .set(salePayload)
          .where(eq(productSales.productId, productId));
      } else if (saleChanged) {
        await db.insert(productSales).values(salePayload);
      }

      const localInventoryChanged =
        typeof changes.visible !== "undefined" ||
        typeof changes.trackInventory !== "undefined" ||
        typeof changes.inventory !== "undefined";
      const shouldQueueRemoteSync = queueRemoteSync && (localInventoryChanged || saleChanged);

      if (syncPricingProfileSale || shouldQueueRemoteSync) {
        const existingProfile = await db
          .select()
          .from(productPricingProfiles)
          .where(eq(productPricingProfiles.productId, productId));

        const profileUpdatePayload = {
          remoteSyncStatus: shouldQueueRemoteSync ? "pending" : undefined,
          remoteSyncMessage: shouldQueueRemoteSync
            ? "Local changes updated. Apply to remote store pending."
            : undefined,
          updatedAt: shouldQueueRemoteSync || saleChanged ? new Date() : undefined
        };

        if (syncPricingProfileSale && saleChanged) {
          profileUpdatePayload.onSale = nextOnSale;
          profileUpdatePayload.saleDiscount = nextSaleDiscount;
          profileUpdatePayload.priceChangedAt = new Date();
          if (!shouldQueueRemoteSync) {
            profileUpdatePayload.remoteSyncStatus = "pending";
            profileUpdatePayload.remoteSyncMessage = "Local sale updated. Apply to remote store pending.";
            profileUpdatePayload.updatedAt = new Date();
          }
        }

        if (existingProfile.length) {
          await db
            .update(productPricingProfiles)
            .set(profileUpdatePayload)
            .where(eq(productPricingProfiles.productId, productId));
        } else if (Object.values(profileUpdatePayload).some((value) => typeof value !== "undefined")) {
          await db.insert(productPricingProfiles).values({
            productId,
            ...profileUpdatePayload,
            createdAt: profileUpdatePayload.updatedAt || new Date()
          });
        }
      }

      let localLineUpdate = null;
      let localLinePriceUpdate = null;
      if (applyRemote && isLocalLineEnabled()) {
        try {
          const result = await updateLocalLineForProduct(db, productId, changes);
          localLineUpdate = result.inventoryOk;
          localLinePriceUpdate = result.priceOk;
        } catch (err) {
          console.error("LocalLine update failed:", err.message);
          localLineUpdate = false;
          localLinePriceUpdate = false;
        }
      }

      results.push({
        productId,
        databaseUpdate: true,
        localLineUpdate,
        localLinePriceUpdate
      });
    } catch (err) {
      console.error("Bulk update error:", err);
      results.push({
        productId,
        databaseUpdate: false,
        localLineUpdate: null,
        localLinePriceUpdate: null
      });
    }
  }

  res.json({ results });
});

router.put("/packages/:id", requireAdminPermission(["pricing_admin", "membership_admin", "local_pricelist_admin"]), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const updates = req.body || {};

  await db
    .update(packages)
    .set({
      name: updates.name ?? undefined,
      price: updates.price ?? undefined,
      packageCode: updates.packageCode ?? undefined,
      unit: updates.unit ?? undefined,
      numOfItems: updates.numOfItems ?? undefined,
      trackType: updates.trackType ?? undefined,
      chargeType: updates.chargeType ?? undefined,
      inventory: updates.inventory ?? undefined,
      visible: updates.visible ?? undefined,
      trackInventory: updates.trackInventory ?? undefined
    })
    .where(eq(packages.id, id));

  res.json({ ok: true });
});

router.post("/products/:id/images", requireAdminPermission(["inventory_admin", "pricing_admin", "local_pricelist_admin"]), upload.single("image"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: "Missing image file" });
  }

  if (!hasSpacesUploadConfig()) {
    return res.status(500).json({
      error: "Spaces not configured",
      detail: "Set DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_KEY, and DO_SPACES_SECRET."
    });
  }

  try {
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /admin/products/:id/images:", error.message);
    });

    const ext = req.file.originalname.split(".").pop() || "jpg";
    const safeExt = ext.toLowerCase();
    const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `products/${productId}/${baseName}.${safeExt}`;
    const thumbKey = `products/${productId}/${baseName}.thumbnail.jpg`;
    const metadata = await sharp(req.file.buffer).metadata();
    const contentHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    await getSpacesClient().send(
      new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ACL: "public-read",
        ContentType: req.file.mimetype,
        CacheControl: "public, max-age=31536000, immutable"
      })
    );

    const thumbnailBuffer = await sharp(req.file.buffer)
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    await getSpacesClient().send(
      new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET,
        Key: thumbKey,
        Body: thumbnailBuffer,
        ACL: "public-read",
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable"
      })
    );

    const url = buildPublicUrl(key);
    const thumbnailUrl = buildPublicUrl(thumbKey);
    const urlHash = url.length ? String(url).slice(-64) : String(Date.now());
    const thumbHash = thumbnailUrl.length ? String(thumbnailUrl).slice(-64) : String(Date.now() + 1);
    const existingMediaRows = await db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, productId))
      .catch((error) => {
        if (isMissingTableError(error, "product_media")) return [];
        throw error;
      });
    const nextSortOrder = existingMediaRows.length
      ? Math.max(...existingMediaRows.map((row) => Number(row.sortOrder) || 0)) + 1
      : 0;
    const now = new Date();
    const isPrimaryImage = nextSortOrder === 0;

    await db.insert(productImages).values([
      { productId, url, urlHash },
      { productId, url: thumbnailUrl, urlHash: thumbHash }
    ]);
    await db.insert(productMedia).values({
      productId,
      source: "local-upload",
      sourceMediaId: null,
      sourceUrl: url,
      remoteUrl: url,
      storageKey: key,
      publicUrl: url,
      thumbnailUrl,
      sortOrder: nextSortOrder,
      isPrimary: isPrimaryImage ? 1 : 0,
      altText: null,
      contentHash,
      width: metadata.width || null,
      height: metadata.height || null,
      mimeType: req.file.mimetype || "image/jpeg",
      fetchedAt: now,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: null
    }).catch((error) => {
      if (isMissingTableError(error, "product_media")) return null;
      throw error;
    });

    if (isPrimaryImage) {
      await db
        .update(products)
        .set({
          thumbnailUrl,
          updatedAt: now
        })
        .where(eq(products.id, productId));
    }

    await markProductRemoteSyncPending(
      getPool(),
      productId,
      "Local images updated. Apply to remote store pending."
    );

    res.json({ ok: true, url, thumbnailUrl });
  } catch (error) {
    console.error("Product image upload failed:", error);
    res.status(500).json({
      error: "Image upload failed",
      detail: error?.message || "Unable to upload image to Spaces."
    });
  }
});

router.post("/products/:id/images/delete", requireAdminPermission(["inventory_admin", "pricing_admin", "local_pricelist_admin"]), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const url = toNullableString(req.body?.url);
  const thumbnailUrl = toNullableString(req.body?.thumbnailUrl);

  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  if (!url && !thumbnailUrl) {
    return res.status(400).json({ error: "Image URL is required" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/products/:id/images/delete:", error.message);
  });

  try {
    const candidateUrls = [...new Set([url, thumbnailUrl].filter(Boolean))];
    const existingImageRows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId));
    const existingMediaRows = await db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, productId))
      .catch((error) => {
        if (isMissingTableError(error, "product_media")) return [];
        throw error;
      });

    const matchingMediaRows = existingMediaRows.filter((row) =>
      candidateUrls.some((candidateUrl) =>
        [
          row.publicUrl,
          row.thumbnailUrl,
          row.remoteUrl,
          row.sourceUrl
        ].includes(candidateUrl)
      )
    );
    const matchingMediaIds = matchingMediaRows
      .map((row) => Number(row.id))
      .filter((value) => Number.isFinite(value));
    const urlsToDelete = new Set(candidateUrls);
    matchingMediaRows.forEach((row) => {
      [row.publicUrl, row.thumbnailUrl].filter(Boolean).forEach((value) => urlsToDelete.add(value));
    });

    const matchingImageUrls = existingImageRows
      .map((row) => row.url)
      .filter((rowUrl) => urlsToDelete.has(rowUrl));

    if (matchingMediaIds.length) {
      await db.delete(productMedia).where(inArray(productMedia.id, matchingMediaIds));
    }

    if (matchingImageUrls.length) {
      await db
        .delete(productImages)
        .where(and(eq(productImages.productId, productId), inArray(productImages.url, matchingImageUrls)));
    }

    if (!matchingMediaIds.length && !matchingImageUrls.length) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (hasSpacesUploadConfig()) {
      const keysToDelete = new Set();
      matchingMediaRows.forEach((row) => {
        if (row.storageKey) keysToDelete.add(row.storageKey);
        const thumbKey = extractSpacesKeyFromPublicUrl(row.thumbnailUrl);
        if (thumbKey) keysToDelete.add(thumbKey);
      });
      candidateUrls.forEach((candidateUrl) => {
        const derivedKey = extractSpacesKeyFromPublicUrl(candidateUrl);
        if (derivedKey) keysToDelete.add(derivedKey);
      });

      await Promise.all(
        [...keysToDelete].map((key) =>
          getSpacesClient()
            .send(
              new DeleteObjectCommand({
                Bucket: process.env.DO_SPACES_BUCKET,
                Key: key
              })
            )
            .catch((error) => {
              console.warn(`Image asset delete skipped for ${key}:`, error.message);
            })
        )
      );
    }

    const remainingMediaRows = await db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, productId))
      .catch((error) => {
        if (isMissingTableError(error, "product_media")) return [];
        throw error;
      });
    const now = new Date();
    let nextThumbnailUrl = null;

    if (remainingMediaRows.length) {
      const sortedMediaRows = remainingMediaRows
        .slice()
        .sort((left, right) => {
          const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
          if (primaryDelta !== 0) return primaryDelta;
          return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
        });
      const primaryRow = sortedMediaRows[0];
      await db
        .update(productMedia)
        .set({ isPrimary: 0 })
        .where(eq(productMedia.productId, productId));
      await db
        .update(productMedia)
        .set({ isPrimary: 1, updatedAt: now })
        .where(eq(productMedia.id, primaryRow.id));
      nextThumbnailUrl =
        primaryRow.thumbnailUrl ||
        primaryRow.publicUrl ||
        primaryRow.remoteUrl ||
        primaryRow.sourceUrl ||
        null;
    } else {
      const remainingImageRows = await db
        .select()
        .from(productImages)
        .where(eq(productImages.productId, productId));
      nextThumbnailUrl =
        remainingImageRows.find((row) => /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(row.url || ""))?.url ||
        remainingImageRows[0]?.url ||
        null;
    }

    await db
      .update(products)
      .set({
        thumbnailUrl: nextThumbnailUrl,
        updatedAt: now
      })
      .where(eq(products.id, productId));

    await markProductRemoteSyncPending(
      getPool(),
      productId,
      "Local images updated. Apply to remote store pending."
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error("Product image delete failed:", error);
    return res.status(500).json({
      error: "Image delete failed",
      detail: error?.message || "Unable to delete product image."
    });
  }
});

router.post("/recipes", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(recipes).values({
    title: payload.title,
    note: payload.note,
    imageUrl: payload.imageUrl,
    ingredientsJson: JSON.stringify(payload.ingredients || []),
    stepsJson: JSON.stringify(payload.steps || []),
    published: payload.published ?? 1,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  res.json({ ok: true });
});

router.put("/recipes/:id", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(recipes)
    .set({
      title: payload.title ?? undefined,
      note: payload.note ?? undefined,
      imageUrl: payload.imageUrl ?? undefined,
      ingredientsJson: payload.ingredients ? JSON.stringify(payload.ingredients) : undefined,
      stepsJson: payload.steps ? JSON.stringify(payload.steps) : undefined,
      published: payload.published ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(recipes.id, id));

  res.json({ ok: true });
});

export default router;
