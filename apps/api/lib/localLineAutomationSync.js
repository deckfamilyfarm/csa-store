import xlsx from "xlsx";
import { getPool } from "../db.js";
import {
  fetchAllLocalLineFulfillmentStrategies,
  fetchLocalLineOrdersPage
} from "../localLine.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl } from "../localLineAuth.js";
import { syncLocalLineSubscriberSnapshotCache } from "./dashboardPublisher.js";

export const LOCAL_LINE_FULFILLMENT_JOB_PHASES = [
  { key: "fetch", label: "Fetch Fulfillments" },
  { key: "store", label: "Store Fulfillments" },
  { key: "finalize", label: "Finalize" }
];

export const LOCAL_LINE_ORDER_JOB_PHASES = [
  { key: "fetch", label: "Fetch Orders" },
  { key: "store", label: "Store Orders" },
  { key: "reporting", label: "Build Reporting Cache" },
  { key: "subscriptions", label: "Capture Subscribers" },
  { key: "finalize", label: "Finalize" }
];

export const LOCAL_LINE_SUBSCRIPTION_JOB_PHASES = [
  { key: "fetch", label: "Fetch Subscribers" },
  { key: "store", label: "Store Subscribers" },
  { key: "finalize", label: "Finalize" }
];

export const LOCAL_LINE_DASHBOARD_JOB_PHASES = [
  { key: "prepare", label: "Prepare Dashboard" },
  { key: "compute", label: "Compute Metrics" },
  { key: "publish", label: "Publish Dashboard" },
  { key: "finalize", label: "Finalize" }
];

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toDbDecimal(value) {
  const numeric = toNumber(value);
  return numeric === null ? null : numeric;
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

function formatYmd(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMonthKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function addUtcMonths(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

function buildMonthlyRanges(startDate, endDate = new Date()) {
  const ranges = [];
  let cursor = startOfUtcMonth(startDate);
  const endMonth = startOfUtcMonth(endDate);
  while (cursor <= endMonth) {
    const monthStart = startOfUtcMonth(cursor);
    const monthEnd = endOfUtcMonth(cursor);
    ranges.push({
      monthKey: formatMonthKeyFromDate(monthStart),
      startDate: monthStart,
      endDate: monthEnd,
      startStr: formatYmd(monthStart),
      endStr: formatYmd(monthEnd)
    });
    cursor = addUtcMonths(cursor, 1);
  }
  return ranges;
}

function buildMonthlyRangesFromMonthKeys(monthKeys = []) {
  return Array.from(new Set((Array.isArray(monthKeys) ? monthKeys : []).filter(Boolean)))
    .sort()
    .map((monthKey) => {
      const match = String(monthKey).match(/^(\d{4})-(\d{2})$/);
      if (!match) return null;
      const monthStart = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
      const monthEnd = endOfUtcMonth(monthStart);
      return {
        monthKey,
        startDate: monthStart,
        endDate: monthEnd,
        startStr: formatYmd(monthStart),
        endStr: formatYmd(monthEnd)
      };
    })
    .filter(Boolean);
}

function parseLooseDateString(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsedCode = xlsx.SSF.parse_date_code(value);
    if (parsedCode?.y && parsedCode?.m && parsedCode?.d) {
      return new Date(Date.UTC(parsedCode.y, parsedCode.m - 1, parsedCode.d));
    }
  }
  const numericString = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(numericString)) {
    const parsedCode = xlsx.SSF.parse_date_code(Number(numericString));
    if (parsedCode?.y && parsedCode?.m && parsedCode?.d) {
      return new Date(Date.UTC(parsedCode.y, parsedCode.m - 1, parsedCode.d));
    }
  }
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const ymdMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    return new Date(Date.UTC(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3])));
  }
  const mdYMatch = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdYMatch) {
    return new Date(Date.UTC(Number(mdYMatch[3]), Number(mdYMatch[1]) - 1, Number(mdYMatch[2])));
  }
  return null;
}

function getUtcWeekStartKey(date) {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - day);
  return formatYmd(monday);
}

function getTrimmedRowValue(row, candidates = []) {
  for (const candidate of candidates) {
    const value = row?.[candidate];
    if (value === null || typeof value === "undefined") continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizePackageId(value) {
  if (value === null || typeof value === "undefined") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return String(Math.trunc(numeric));
  }
  return String(value).trim();
}

function computeEffectiveReportingQuantity(row = {}) {
  let quantity = Number(row?.Quantity);
  if (!Number.isFinite(quantity)) quantity = 0;
  quantity = Math.round(quantity);

  let numItems = Number(row?.["# of Items"]);
  if (!Number.isFinite(numItems)) numItems = 0;
  numItems = Math.round(numItems);

  if (numItems > 1 && quantity === 1) {
    quantity = numItems;
  }

  return quantity;
}

function parseCurrencyCell(value) {
  const numeric = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseOptionalIntegerCell(value) {
  const numeric = Number(String(value ?? "").trim());
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function parseOrdersExportRows(csvText) {
  const workbook = xlsx.read(csvText, { type: "string" });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return [];
  const worksheet = workbook.Sheets[firstSheetName];
  return xlsx.utils.sheet_to_json(worksheet, { defval: "" });
}

function buildPackagePriceMapFromWorkbookBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const worksheet =
    workbook.Sheets["Packages and pricing"] ||
    workbook.Sheets[workbook.SheetNames?.[1]] ||
    workbook.Sheets[workbook.SheetNames?.[0]];
  if (!worksheet) {
    throw new Error('Could not find "Packages and pricing" worksheet');
  }
  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
  const map = new Map();
  rows.forEach((row) => {
    const packageId = normalizePackageId(row?.["Package ID"] || row?.PackageID || row?.package_id);
    const packagePrice = parseCurrencyCell(row?.["Package Price"] || row?.PackagePrice || row?.package_price);
    if (!packageId || !Number.isFinite(packagePrice) || packagePrice <= 0) return;
    map.set(packageId, packagePrice);
  });
  return map;
}

async function fetchWithLocalLineRetry(url, options, label) {
  const attempts = Math.max(
    1,
    Number.parseInt(process.env.LOCALLINE_FETCH_RETRY_ATTEMPTS || "2", 10) || 2
  );
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
    }
  }
  throw new Error(`${label} request failed: ${lastError?.message || "fetch failed"}`);
}

async function requestLocalLineExport(url, accessToken) {
  const response = await fetchWithLocalLineRetry(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  }, "Local Line export request");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line export request failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const exportId = Number(payload?.id);
  if (!Number.isFinite(exportId)) {
    throw new Error("Local Line export request did not return an export id");
  }
  return exportId;
}

async function pollLocalLineExportFilePath(exportId, accessToken) {
  const baseUrl = getLocalLineBaseUrl();
  const timeoutMs = 90_000;
  const pollIntervalMs = 5_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchWithLocalLineRetry(
      `${baseUrl}export/${exportId}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      `Local Line export ${exportId}`
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Local Line export poll failed: ${response.status} ${body}`);
    }
    const payload = await response.json();
    if (payload?.status === "COMPLETE" && payload?.file_path) {
      return String(payload.file_path);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Local Line export ${exportId} did not complete in time`);
}

async function downloadTextFile(url) {
  const response = await fetchWithLocalLineRetry(url, {}, "Local Line text download");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line text download failed: ${response.status} ${body}`);
  }
  return response.text();
}

async function downloadBinaryFile(url, accessToken) {
  const response = await fetchWithLocalLineRetry(url, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
  }, "Local Line binary download");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Local Line binary download failed: ${response.status} ${body}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function buildOrdersExportUrl(startStr, endStr) {
  const baseUrl = getLocalLineBaseUrl();
  const params = new URLSearchParams({
    file_type: "orders_list_view",
    send_to_email: "false",
    destination_email: "fullfarmcsa@deckfamilyfarm.com",
    direct: "true",
    fulfillment_date_start: startStr,
    fulfillment_date_end: endStr
  });
  return `${baseUrl}orders/export/?${params.toString()}`;
}

async function syncLocalLineOrderReportingCache({
  connection,
  reportProgress = () => {},
  startDate = new Date("2026-01-01T00:00:00.000Z"),
  monthKeys = null
} = {}) {
  const ranges = Array.isArray(monthKeys) && monthKeys.length
    ? buildMonthlyRangesFromMonthKeys(monthKeys)
    : buildMonthlyRanges(startDate, new Date());
  if (!ranges.length) {
    reportProgress({
      phaseKey: "reporting",
      phaseLabel: "Build Reporting Cache",
      status: "completed",
      percent: 100,
      current: 0,
      total: 0,
      message: "No reporting months needed refresh"
    });
    return {
      monthsSynced: 0,
      reportingRows: 0,
      refreshedMonths: []
    };
  }
  const accessToken = await getLocalLineAccessToken();
  const productWorkbookBuffer = await downloadBinaryFile(
    `${getLocalLineBaseUrl()}products/export/?direct=true`,
    accessToken
  );
  const packagePriceMap = buildPackagePriceMapFromWorkbookBuffer(productWorkbookBuffer);
  let totalRows = 0;

  reportProgress({
    phaseKey: "reporting",
    phaseLabel: "Build Reporting Cache",
    status: "running",
    percent: 0,
    current: 0,
    total: ranges.length,
    message: `Syncing ${ranges.length} vendor reporting month${ranges.length === 1 ? "" : "s"}`
  });

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const exportId = await requestLocalLineExport(
      buildOrdersExportUrl(range.startStr, range.endStr),
      accessToken
    );
    const filePath = await pollLocalLineExportFilePath(exportId, accessToken);
    const csvText = await downloadTextFile(filePath);
    const rows = parseOrdersExportRows(csvText);
    const now = new Date();

    const preparedRows = rows
      .map((row) => {
        const fulfillmentDateText = getTrimmedRowValue(row, [
          "Fulfillment Date",
          "Delivery Date",
          "Pickup Date",
          "Delivery/Pickup Date",
          "Order Fulfillment Date",
          "Date"
        ]);
        const fulfillmentDate = parseLooseDateString(fulfillmentDateText);
        const normalizedFulfillmentDate = fulfillmentDate ? formatYmd(fulfillmentDate) : range.startStr;
        const quantity = computeEffectiveReportingQuantity(row);
        const packageId = normalizePackageId(
          getTrimmedRowValue(row, ["Package ID", "Package Id", "package_id"])
        );
        const retailAmount = parseCurrencyCell(
          getTrimmedRowValue(row, ["Product Subtotal", "Line Subtotal", "Subtotal", "Line Item Total", "Amount"])
        );
        const purchaseUnitPrice = packageId ? Number(packagePriceMap.get(packageId) || 0) : 0;
        const purchaseTotal = Number((purchaseUnitPrice * quantity).toFixed(2));
        return [
          range.monthKey,
          normalizedFulfillmentDate,
          fulfillmentDate ? getUtcWeekStartKey(fulfillmentDate) : null,
          parseOptionalIntegerCell(getTrimmedRowValue(row, ["Order", "Order ID", "Order Id"])),
          getTrimmedRowValue(row, ["Customer", "Customer Name"]),
          getTrimmedRowValue(row, ["Price List"]),
          getTrimmedRowValue(row, ["Order Status", "Status"]),
          getTrimmedRowValue(row, ["Payment Status"]),
          getTrimmedRowValue(row, ["Fulfillment Name"]),
          getTrimmedRowValue(row, ["Fulfillment Address"]),
          parseOptionalIntegerCell(getTrimmedRowValue(row, ["Vendor ID", "Vendor Id", "vendor_id"])),
          getTrimmedRowValue(row, ["Vendor"]),
          getTrimmedRowValue(row, ["Category"]),
          parseOptionalIntegerCell(getTrimmedRowValue(row, ["Product ID", "Product Id", "product_id"])),
          getTrimmedRowValue(row, ["Product", "Product Name", "Item", "Item Name"]),
          packageId || null,
          getTrimmedRowValue(row, ["Package", "Package Name"]),
          quantity,
          retailAmount,
          purchaseUnitPrice,
          purchaseTotal,
          stringifyJson(row),
          now,
          now,
          now
        ];
      })
      .filter((values) => Boolean(values[14]) || Boolean(values[11]));

    await connection.beginTransaction();
    await connection.query(
      `
        INSERT INTO local_line_order_reporting_months (
          month_key, status, row_count, message, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          row_count = VALUES(row_count),
          message = VALUES(message),
          synced_at = VALUES(synced_at),
          updated_at = VALUES(updated_at)
      `,
      [range.monthKey, "running", 0, `Refreshing ${range.monthKey}`, now, now, now]
    );
    await connection.query(
      "DELETE FROM local_line_order_reporting_entries WHERE fulfillment_month = ?",
      [range.monthKey]
    );

    const chunkSize = 250;
    for (let startIndex = 0; startIndex < preparedRows.length; startIndex += chunkSize) {
      const chunk = preparedRows.slice(startIndex, startIndex + chunkSize);
      if (!chunk.length) continue;
      const valuesSql = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const flattened = chunk.flat();
      await connection.query(
        `
          INSERT INTO local_line_order_reporting_entries (
            fulfillment_month,
            fulfillment_date,
            week_start,
            local_line_order_id,
            customer_name,
            price_list_name,
            order_status,
            payment_status,
            fulfillment_name,
            fulfillment_address,
            vendor_id,
            vendor_name,
            category_name,
            product_id,
            product_name,
            package_id,
            package_name,
            quantity,
            retail_amount,
            purchase_unit_price,
            purchase_total,
            raw_json,
            created_at,
            updated_at,
            last_synced_at
          ) VALUES ${valuesSql}
        `,
        flattened
      );
    }

    await connection.query(
      `
        INSERT INTO local_line_order_reporting_months (
          month_key, status, row_count, message, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          row_count = VALUES(row_count),
          message = VALUES(message),
          synced_at = VALUES(synced_at),
          updated_at = VALUES(updated_at)
      `,
      [
        range.monthKey,
        "completed",
        preparedRows.length,
        `Stored ${preparedRows.length} reporting rows`,
        now,
        now,
        now
      ]
    );
    await connection.commit();

    totalRows += preparedRows.length;
    reportProgress({
      phaseKey: "reporting",
      phaseLabel: "Build Reporting Cache",
      status: "running",
      percent: Math.round(((index + 1) / ranges.length) * 100),
      current: index + 1,
      total: ranges.length,
      message: `Reporting cache refreshed for ${range.monthKey} (${preparedRows.length} rows)`
    });
  }

  reportProgress({
    phaseKey: "reporting",
    phaseLabel: "Build Reporting Cache",
    status: "completed",
    percent: 100,
    current: ranges.length,
    total: ranges.length,
    message: `Stored ${totalRows} reporting rows`
  });

  return {
    monthsSynced: ranges.length,
    reportingRows: totalRows,
    refreshedMonths: ranges.map((range) => range.monthKey)
  };
}

async function backfillLocalLineOrderDatesFromReportingCache(connection, monthKeys = []) {
  const normalizedMonthKeys = Array.from(new Set((Array.isArray(monthKeys) ? monthKeys : []).filter(Boolean)));
  if (!normalizedMonthKeys.length) {
    return { updatedOrders: 0 };
  }

  const placeholders = normalizedMonthKeys.map(() => "?").join(", ");
  const [result] = await connection.query(
    `
      UPDATE local_line_orders o
      JOIN (
        SELECT
          local_line_order_id,
          MIN(fulfillment_date) AS reporting_fulfillment_date
        FROM local_line_order_reporting_entries
        WHERE fulfillment_month IN (${placeholders})
          AND fulfillment_date IS NOT NULL
          AND TRIM(fulfillment_date) <> ''
        GROUP BY local_line_order_id
      ) r
        ON r.local_line_order_id = o.local_line_order_id
      SET
        o.fulfillment_date = STR_TO_DATE(r.reporting_fulfillment_date, '%Y-%m-%d'),
        o.updated_at = NOW(),
        o.last_synced_at = NOW()
      WHERE
        o.fulfillment_date IS NULL
        OR DATE_FORMAT(o.fulfillment_date, '%Y-%m-%d') <> r.reporting_fulfillment_date
    `,
    normalizedMonthKeys
  );

  return {
    updatedOrders: Number(result?.affectedRows || 0)
  };
}

export async function syncLocalLineFulfillmentStrategiesToStore({ reportProgress = () => {} } = {}) {
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

export async function syncLocalLineOrdersToStore({
  reportProgress = () => {},
  cutoffDate,
  includeSubscriberSnapshot = true
} = {}) {
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
    const touchedReportingMonths = new Set();
    const incrementalSync = Number(existingCursor?.cursorValue || 0) > 0;
    const syncLabel = incrementalSync
      ? `Fetching new orders since ${String(existingCursor?.syncedThroughAt || "").slice(0, 10) || "last sync"}`
      : `Fetching orders since ${effectiveCutoffDate.toISOString().slice(0, 10)}`;

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Fetch Orders",
      status: "running",
      percent: 0,
      current: 0,
      total: null,
      message: syncLabel
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
        percent: incrementalSync
          ? null
          : (totalAvailable ? Math.min(95, Math.round((totalFetched / totalAvailable) * 100)) : 0),
        current: totalFetched,
        total: incrementalSync ? null : totalAvailable,
        message: incrementalSync ? `Scanned ${totalFetched} new orders` : `Fetched page ${page}`
      });

      await connection.beginTransaction();
      let scannedThisPage = 0;
      const totalOrdersThisPage = orders.length;

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
        const paymentStrategyFees = Array.isArray(payment?.order_payment_strategy?.fees)
          ? payment.order_payment_strategy.fees
          : null;
        const orderEntries = Array.isArray(order?.order_entries) ? order.order_entries : [];
        const now = new Date();
        const fulfillmentDate = toDateOrNull(fulfillment?.fulfillment_date);
        const reportingMonthDate = fulfillmentDate || createdAtRemote || now;
        touchedReportingMonths.add(formatMonthKeyFromDate(reportingMonthDate));

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
              payment_store_credit_amount,
              payment_strategy_amount,
              payment_strategy_name,
              payment_strategy_type,
              payment_fees,
              payment_tax,
              payment_strategy_fees_json,
              subtotal,
              tax,
              total,
              discount,
              product_count,
              raw_json,
              created_at,
              updated_at,
              last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              payment_store_credit_amount = VALUES(payment_store_credit_amount),
              payment_strategy_amount = VALUES(payment_strategy_amount),
              payment_strategy_name = VALUES(payment_strategy_name),
              payment_strategy_type = VALUES(payment_strategy_type),
              payment_fees = VALUES(payment_fees),
              payment_tax = VALUES(payment_tax),
              payment_strategy_fees_json = VALUES(payment_strategy_fees_json),
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
            fulfillmentDate,
            toNullableString(fulfillment?.pickup_start_time),
            toNullableString(fulfillment?.pickup_end_time),
            toNullableString(payment?.status),
            toDbDecimal(payment?.store_credit_amount),
            toDbDecimal(payment?.payment_strategy_amount),
            toNullableString(payment?.payment_strategy_name),
            toNullableString(payment?.payment_strategy_type),
            toDbDecimal(order?.payment_fees),
            toDbDecimal(order?.payment_tax),
            stringifyJson(paymentStrategyFees),
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
        scannedThisPage += 1;
        if (remoteOrderId > newestOrderId) {
          newestOrderId = remoteOrderId;
        }
        if (createdAtRemote && (!newestCreatedAt || createdAtRemote > newestCreatedAt)) {
          newestCreatedAt = createdAtRemote;
        }

        if (scannedThisPage === totalOrdersThisPage || scannedThisPage % 25 === 0) {
          reportProgress({
            phaseKey: "fetch",
            phaseLabel: "Fetch Orders",
            status: "running",
            percent: incrementalSync
              ? null
              : (totalAvailable ? Math.min(95, Math.round((totalFetched / totalAvailable) * 100)) : 0),
            current: totalFetched,
            total: incrementalSync ? null : totalAvailable,
            message: incrementalSync
              ? `Scanned ${totalFetched} new orders (${scannedThisPage}/${totalOrdersThisPage} on current page)`
              : `Fetched page ${page} (${scannedThisPage}/${totalOrdersThisPage} processed)`
          });
        }
      }

      await connection.commit();

      reportProgress({
        phaseKey: "store",
        phaseLabel: "Store Orders",
        status: "running",
        percent: incrementalSync
          ? null
          : (totalAvailable ? Math.min(95, Math.round((totalFetched / totalAvailable) * 100)) : 0),
        current: stored,
        total: incrementalSync ? null : totalAvailable,
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

    const reportingMonthKeys = incrementalSync
      ? Array.from(
          new Set([
            ...Array.from(touchedReportingMonths),
            formatMonthKeyFromDate(new Date()),
            formatMonthKeyFromDate(addUtcMonths(new Date(), -1))
          ])
        )
      : null;

    const reportingSummary = await syncLocalLineOrderReportingCache({
      connection,
      reportProgress,
      startDate: effectiveCutoffDate,
      monthKeys: reportingMonthKeys
    });
    const orderDateBackfillSummary = await backfillLocalLineOrderDatesFromReportingCache(
      connection,
      reportingSummary?.refreshedMonths || reportingMonthKeys || []
    );
    const subscriptionSummary = includeSubscriberSnapshot
      ? await syncLocalLineSubscriberSnapshotCache({
          reportProgress,
          phase: {
            fetchKey: "subscriptions",
            storeKey: "subscriptions",
            finalizeKey: "subscriptions",
            fetchLabel: "Capture Subscribers",
            storeLabel: "Capture Subscribers",
            finalizeLabel: "Capture Subscribers"
          }
        })
      : null;

    reportProgress({
      phaseKey: "fetch",
      phaseLabel: "Fetch Orders",
      status: "completed",
      percent: 100,
      current: totalFetched,
      total: incrementalSync ? null : totalAvailable,
      message: `Fetched ${totalFetched} new orders`
    });
    reportProgress({
      phaseKey: "store",
      phaseLabel: "Store Orders",
      status: "completed",
      percent: 100,
      current: stored,
      total: incrementalSync ? null : totalAvailable,
      message: `Stored ${stored} orders`
    });
    reportProgress({
      phaseKey: "finalize",
      phaseLabel: "Finalize",
      status: "completed",
      percent: 100,
      message: "Order sync complete"
    });
    return {
      ...summary,
      reportingSummary,
      orderDateBackfillSummary,
      subscriptionSummary
    };
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
