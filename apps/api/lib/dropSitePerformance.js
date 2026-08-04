const WEEKLY_CREDIT_THRESHOLD = 3;
const STRONG_WEEKLY_AVERAGE = 5;
const LEGACY_MONTHLY_UNIQUE_THRESHOLD = 5;
const TREND_MODE_KEY = "__trend6__";

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

function buildMonthKeysBetween(minValue, maxValue) {
  const minDate = toDateOrNull(minValue);
  const maxDate = toDateOrNull(maxValue);
  if (!minDate || !maxDate || minDate > maxDate) return [];

  const keys = [];
  const cursor = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
  const minMonth = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  while (cursor >= minMonth) {
    keys.push(formatMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return keys;
}

function isDateInRange(date, rangeStart, rangeEnd) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  return date >= rangeStart && date < rangeEnd;
}

function parseJsonValue(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function isMissingReportingCacheError(error) {
  return ["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(error?.code);
}

async function queryWithConnectionRetry(pool, sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (["PROTOCOL_CONNECTION_LOST", "ECONNRESET", "ETIMEDOUT"].includes(error?.code)) {
      return pool.query(sql, params);
    }
    throw error;
  }
}

function getJsonTrimmedStringSql(orderAlias = "o", jsonPath = "$") {
  return `NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${orderAlias}.raw_json, '${jsonPath}'))), ''), 'null')`;
}

function getFulfillmentStrategyIdSql(orderAlias = "o") {
  return `COALESCE(${orderAlias}.fulfillment_strategy_id, CAST(${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_strategy")} AS UNSIGNED))`;
}

function getFulfillmentDateSql(orderAlias = "o") {
  return `COALESCE(${orderAlias}.fulfillment_date, STR_TO_DATE(${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_date")}, '%Y-%m-%d'))`;
}

function getFulfillmentSiteNameSql(orderAlias = "o", dropSiteAlias = "ds") {
  return `COALESCE(NULLIF(TRIM(${orderAlias}.fulfillment_strategy_name), ''), ${getJsonTrimmedStringSql(orderAlias, "$.fulfillment.fulfillment_strategy_name")}, NULLIF(TRIM(${dropSiteAlias}.name), ''), 'Unassigned')`;
}

function normalizeDropSiteReportingName(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.toLowerCase() === "unassigned") return "";
  return cleaned;
}

function getDropSitePerformanceKey({ name, strategyId } = {}) {
  const normalizedName = normalizeDropSiteReportingName(name);
  if (normalizedName) return `name:${normalizedName.toLowerCase()}`;

  const numericStrategyId = Number(strategyId || 0);
  if (numericStrategyId > 0) return `id:${numericStrategyId}`;

  return "name:unassigned";
}

function getDefaultDropSitePerformanceMonth(monthKeys = [], referenceDate = new Date()) {
  const availableMonths = monthKeys.filter(Boolean);
  if (!availableMonths.length) return "";

  const today = toDateOrNull(referenceDate) || new Date();
  const currentMonthKey = formatMonthKey(today);
  const priorMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const priorMonthKey = formatMonthKey(priorMonthDate);

  if (today.getDate() >= 25 && availableMonths.includes(currentMonthKey)) {
    return currentMonthKey;
  }

  if (availableMonths.includes(priorMonthKey)) {
    return priorMonthKey;
  }

  if (availableMonths.includes(currentMonthKey)) {
    return currentMonthKey;
  }

  return availableMonths[0] || "";
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

function normalizeHostContactEmail(value) {
  const cleaned = String(value || "")
    .replace(/^[,;:.\s<]+|[,;:.\s>]+$/g, "")
    .trim()
    .toLowerCase();
  if (!cleaned) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) return null;
  return cleaned;
}

function buildDropSiteContactText(site = {}) {
  const raw = parseJsonValue(site?.rawJson || site?.raw_json, {});
  const snippets = [
    raw?.availability?.instructions,
    raw?.description,
    raw?.short_description,
    raw?.pickup_instructions,
    raw?.notes,
    raw?.host_description,
    raw?.location_description,
    raw?.address?.description,
    site?.instructions
  ]
    .map((value) => stripHtmlToText(value))
    .filter(Boolean);

  return snippets.join(" ");
}

export function extractDropSiteHostContact(site = {}) {
  const instructionText = buildDropSiteContactText(site);
  if (!instructionText) return null;

  const phonePattern = String.raw`(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})`;
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const emailMatches = Array.from(instructionText.matchAll(emailPattern));
  const parsedEmails = emailMatches
    .map((match) => normalizeHostContactEmail(match[0]))
    .filter(Boolean);
  const genericEmail = parsedEmails.find((email) => email === "fullfarmcsa@deckfamilyfarm.com") || null;
  const hostEmail = parsedEmails.find((email) => email !== "fullfarmcsa@deckfamilyfarm.com") || null;
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
    return {
      name: contactName,
      phone,
      email: hostEmail || genericEmail || null,
      indicator: "phone",
      source: "instructions"
    };
  }

  const fallbackPhoneMatch = instructionText.match(new RegExp(phonePattern, "i"));
  if (fallbackPhoneMatch?.[0]) {
    return {
      name: null,
      phone: String(fallbackPhoneMatch[0]).trim(),
      email: hostEmail || genericEmail || null,
      indicator: "phone",
      source: "instructions"
    };
  }

  if (hostEmail) {
    return {
      name: null,
      phone: null,
      email: hostEmail,
      indicator: "email",
      source: "instructions"
    };
  }

  if (genericEmail) {
    return {
      name: null,
      phone: null,
      email: genericEmail,
      indicator: "generic",
      source: "instructions"
    };
  }

  return {
    name: null,
    phone: null,
    email: null,
    indicator: "none",
    source: "instructions"
  };
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

function isHomeDeliverySite(site = {}) {
  return String(site?.name || "").toLowerCase().includes("home delivery");
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

function getCustomDateKeysInRange(availability = {}, rangeStart, rangeEnd) {
  const dates = Array.isArray(availability?.custom_dates) ? availability.custom_dates : [];
  return [...new Set(
    dates
      .map((item) => toDateOrNull(item?.available_date || item?.date || item))
      .filter((value) => isDateInRange(value, rangeStart, rangeEnd))
      .map((value) => formatDateKey(value))
      .filter(Boolean)
  )].sort();
}

function getMonthlyDateKeysInRange(rangeStart, rangeEnd, repeatOnDates = [], repeatStartDate = null) {
  if (!Array.isArray(repeatOnDates) || !repeatOnDates.length) return [];
  const validDays = new Set(
    repeatOnDates
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 1 && value <= 31)
  );
  if (!validDays.size) return [];
  const startDate = toDateOrNull(repeatStartDate);
  const keys = [];
  for (let current = new Date(rangeStart); current < rangeEnd; current = addDays(current, 1)) {
    if (startDate && current < startDate) continue;
    if (validDays.has(current.getDate())) {
      keys.push(formatDateKey(current));
    }
  }
  return [...new Set(keys)].sort();
}

function getWeekdayDateKeysInRange(rangeStart, rangeEnd, weekdayNumbers = [], repeatStartDate = null) {
  if (!Array.isArray(weekdayNumbers) || !weekdayNumbers.length) return [];
  const allowedWeekdays = new Set(weekdayNumbers);
  const startDate = toDateOrNull(repeatStartDate);
  const keys = [];
  for (let current = new Date(rangeStart); current < rangeEnd; current = addDays(current, 1)) {
    if (startDate && current < startDate) continue;
    if (allowedWeekdays.has(current.getDay())) {
      keys.push(formatDateKey(current));
    }
  }
  return [...new Set(keys)].sort();
}

function getAvailableDateKeysInRange(availability = {}, rangeStart, rangeEnd) {
  const dates = Array.isArray(availability?.available_dates) ? availability.available_dates : [];
  return [...new Set(
    dates
      .map((item) => toDateOrNull(item?.available_date))
      .filter((value) => isDateInRange(value, rangeStart, rangeEnd))
      .map((value) => formatDateKey(value))
      .filter(Boolean)
  )].sort();
}

function getDropSiteScheduledDateKeysForRange(site = {}, rangeStart, rangeEnd, fallbackOrderDates = []) {
  const availability =
    parseJsonValue(site?.availabilityJson || site?.availability_json, null) ||
    parseJsonValue(site?.rawJson || site?.raw_json, {})?.availability ||
    {};

  const customDateKeys = getCustomDateKeysInRange(availability, rangeStart, rangeEnd);
  if (customDateKeys.length) return customDateKeys;

  const repeatOnDates = Array.isArray(availability?.repeat_on_dates) ? availability.repeat_on_dates : [];
  const repeatStartDate = availability?.repeat_start_date || null;
  const monthlyDateKeys = getMonthlyDateKeysInRange(
    rangeStart,
    rangeEnd,
    repeatOnDates,
    repeatStartDate
  );
  if (monthlyDateKeys.length) return monthlyDateKeys;

  const weekdayNumbers = getAvailabilityWeekdayNumbers(availability);
  const weekdayDateKeys = getWeekdayDateKeysInRange(rangeStart, rangeEnd, weekdayNumbers, repeatStartDate);
  if (weekdayDateKeys.length) return weekdayDateKeys;

  const availableDateKeys = getAvailableDateKeysInRange(availability, rangeStart, rangeEnd);
  if (availableDateKeys.length) return availableDateKeys;

  const labelWeekdays = getWeekdayNumbersFromDayLabel(site?.dayOfWeek);
  const labelWeekdayDateKeys = getWeekdayDateKeysInRange(rangeStart, rangeEnd, labelWeekdays);
  if (labelWeekdayDateKeys.length) return labelWeekdayDateKeys;

  return [...new Set(
    (fallbackOrderDates || [])
      .filter((value) => isDateInRange(value, rangeStart, rangeEnd))
      .map((value) => formatDateKey(value))
      .filter(Boolean)
  )].sort();
}

function getDropSitePerformanceTier(averageWeeklyOrders) {
  const numeric = Number(averageWeeklyOrders) || 0;
  if (numeric >= STRONG_WEEKLY_AVERAGE) return "good";
  if (numeric >= WEEKLY_CREDIT_THRESHOLD) return "warn";
  return "bad";
}

function getCustomerKey(row = {}) {
  const customerId = Number(row.customerId || 0);
  if (customerId > 0) return `id:${customerId}`;
  const customerName = String(row.customerName || "").trim().toLowerCase();
  if (customerName) return `name:${customerName}`;
  const orderId = Number(row.localLineOrderId || 0);
  return orderId > 0 ? `order:${orderId}` : "";
}

function computeOrderCountsByDate(rows = []) {
  return rows.reduce((map, row) => {
    const key = formatDateKey(row.fulfillmentDate);
    if (!key) return map;
    map.set(key, Number(map.get(key) || 0) + 1);
    return map;
  }, new Map());
}

function computeLegacyUniqueCustomerCount(rows = []) {
  return new Set(rows.map((row) => getCustomerKey(row)).filter(Boolean)).size;
}

function buildSeriesEntry({ site, rows = [], rangeStart, rangeEnd, monthKey = "", weekStart = "" }) {
  const fulfillmentDates = rows.map((row) => row.fulfillmentDate).filter(Boolean);
  const orderCountByDate = computeOrderCountsByDate(rows);
  const scheduledDateKeys = getDropSiteScheduledDateKeysForRange(
    site,
    rangeStart,
    rangeEnd,
    fulfillmentDates
  );
  const detailPoints = scheduledDateKeys.map((dateKey) => ({
    date: dateKey,
    orderCount: Number(orderCountByDate.get(dateKey) || 0)
  }));
  const activeDetailPoints = detailPoints.filter((point) => Number(point.orderCount || 0) > 0);
  const orderCount = detailPoints.reduce((sum, point) => sum + Number(point.orderCount || 0), 0);
  const scheduledDrops = detailPoints.length;
  const activeDropWeeks = activeDetailPoints.length;
  const averageWeeklyOrders =
    scheduledDrops > 0 ? Number((orderCount / scheduledDrops).toFixed(2)) : 0;
  const averageOrdersPerActiveDropWeek =
    activeDropWeeks > 0 ? Number((orderCount / activeDropWeeks).toFixed(2)) : 0;
  const legacyMonthlyUniqueCustomers = computeLegacyUniqueCustomerCount(rows);
  const weeklyCreditEligible = averageOrdersPerActiveDropWeek >= WEEKLY_CREDIT_THRESHOLD;
  const legacyCreditEligible = legacyMonthlyUniqueCustomers > LEGACY_MONTHLY_UNIQUE_THRESHOLD;

  return {
    ...(weekStart ? { weekStart } : {}),
    ...(monthKey ? { month: monthKey } : {}),
    orderCount,
    scheduledDrops,
    activeDropWeeks,
    averageWeeklyOrders,
    averageOrdersPerScheduledDropWeek: averageWeeklyOrders,
    averageOrdersPerActiveDropWeek,
    legacyMonthlyUniqueCustomers,
    weeklyCreditEligible,
    legacyCreditEligible,
    transitionCreditEligible: weeklyCreditEligible || legacyCreditEligible,
    detailPoints,
    performanceTier: getDropSitePerformanceTier(averageOrdersPerActiveDropWeek)
  };
}

function getPublicAreaLabel(site = {}) {
  const raw = parseJsonValue(site?.addressJson || site?.address_json, null) ||
    parseJsonValue(site?.rawJson || site?.raw_json, {})?.address ||
    {};
  const city =
    raw?.city ||
    raw?.locality ||
    raw?.municipality ||
    raw?.address_city ||
    "";
  const state =
    raw?.state ||
    raw?.region ||
    raw?.province ||
    raw?.address_state ||
    "";
  const cityState = [city, state].map((value) => String(value || "").trim()).filter(Boolean).join(", ");
  if (cityState) return cityState;

  const address = String(site?.address || "").trim();
  const parts = address.split(",").map((value) => value.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join(", ");
  return parts[0] || "";
}

function sanitizePublicSite(site = {}) {
  return {
    id: site.id,
    name: site.name,
    active: Boolean(site.active),
    area: getPublicAreaLabel(site),
    dayOfWeek: site.dayOfWeek || null,
    openTime: site.openTime || null,
    closeTime: site.closeTime || null,
    type: site.type || null,
    fulfillmentType: site.fulfillmentType || null
  };
}

function sanitizePublicPerformanceSite(site = {}) {
  return {
    id: site.id,
    name: site.name,
    area: site.area || "",
    active: Boolean(site.active),
    orderCount: Number(site.orderCount || 0),
    scheduledDrops: Number(site.scheduledDrops || 0),
    activeDropWeeks: Number(site.activeDropWeeks || 0),
    averageOrdersPerActiveDropWeek: Number(site.averageOrdersPerActiveDropWeek || 0),
    averageOrdersPerScheduledDropWeek: Number(site.averageOrdersPerScheduledDropWeek || site.averageWeeklyOrders || 0),
    legacyMonthlyUniqueCustomers: Number(site.legacyMonthlyUniqueCustomers || 0),
    weeklyCreditEligible: Boolean(site.weeklyCreditEligible),
    legacyCreditEligible: Boolean(site.legacyCreditEligible),
    transitionCreditEligible: Boolean(site.transitionCreditEligible),
    performanceTier: site.performanceTier || "bad"
  };
}

function sanitizePublicPerformance(performance = {}) {
  return {
    mode: performance.mode,
    selectedMonth: performance.selectedMonth,
    months: performance.months || [],
    thresholdAverage: performance.thresholdAverage,
    thresholdOperator: performance.thresholdOperator,
    thresholdLabel: performance.thresholdLabel,
    strongAverage: performance.strongAverage,
    legacyMonthlyUniqueThreshold: performance.legacyMonthlyUniqueThreshold,
    rollout: performance.rollout,
    rankedSites: (performance.rankedSites || []).map((site) => sanitizePublicPerformanceSite(site))
  };
}

export async function buildDropSitePerformancePayload({
  pool,
  requestedMonth = "",
  includeHostContact = false,
  publicOnly = false,
  allowTrend = true,
  referenceDate = new Date()
} = {}) {
  if (!pool) {
    throw new Error("Database pool is required for drop-site performance.");
  }

  const completedFulfillmentCutoff = startOfDay(referenceDate);
  const completedWeekCutoff = startOfWeek(completedFulfillmentCutoff);
  const latestCompletedWeekStart = addDays(completedWeekCutoff, -7);
  const fulfillmentDateSql = getFulfillmentDateSql("o");
  const fulfillmentStrategyIdSql = getFulfillmentStrategyIdSql("o");
  const fulfillmentSiteSql = getFulfillmentSiteNameSql("o", "ds");

  const [siteRows] = await queryWithConnectionRetry(
    pool,
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
    area: getPublicAreaLabel(row),
    ...(includeHostContact ? { derivedHostContact: extractDropSiteHostContact(row) } : {})
  }));

  const visibleDropSites = normalizedSites.filter((site) => !site.isOnlineOnlyMembership);
  const performanceSites = visibleDropSites.filter((site) => {
    if (!publicOnly) return true;
    return site.active && !isHomeDeliverySite(site);
  });

  let monthRows = [];
  try {
    [monthRows] = await queryWithConnectionRetry(
      pool,
      `
        SELECT month_key AS value
        FROM local_line_order_reporting_months
        WHERE status = 'completed'
        ORDER BY month_key DESC
      `
    );
  } catch (error) {
    if (!isMissingReportingCacheError(error)) {
      throw error;
    }
  }
  if (!monthRows.length) {
    const [orderDateRangeRows] = await queryWithConnectionRetry(
      pool,
      `
        SELECT
          MIN(fulfillment_date) AS minFulfillmentDate,
          MAX(fulfillment_date) AS maxFulfillmentDate
        FROM local_line_orders
        WHERE fulfillment_date IS NOT NULL
          AND fulfillment_date < ?
      `,
      [completedFulfillmentCutoff]
    );
    monthRows = buildMonthKeysBetween(
      orderDateRangeRows?.[0]?.minFulfillmentDate,
      orderDateRangeRows?.[0]?.maxFulfillmentDate
    ).map((value) => ({ value }));
  }
  const performanceMonths = monthRows.map((row) => row.value).filter(Boolean);
  const isTrendMode = allowTrend && requestedMonth === TREND_MODE_KEY && performanceMonths.length > 0;
  const defaultSelectedMonth = getDefaultDropSitePerformanceMonth(
    performanceMonths,
    completedFulfillmentCutoff
  );
  const selectedMonth =
    !isTrendMode && performanceMonths.includes(requestedMonth)
      ? requestedMonth
      : defaultSelectedMonth;
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

  function buildRankedSitesFromOrderRows(orderRows = []) {
    const orderGroupsByKeyMonth = new Map();
    for (const row of orderRows) {
      const fulfillmentDate = toDateOrNull(row.fulfillmentDate);
      if (!fulfillmentDate || fulfillmentDate >= completedFulfillmentCutoff) continue;
      const monthKey = formatMonthKey(fulfillmentDate);
      const siteKey = getDropSitePerformanceKey({
        name: row.fulfillmentSiteName,
        strategyId: row.fulfillmentStrategyId
      });
      const bucketKey = `${siteKey}|${monthKey}`;
      const existing = orderGroupsByKeyMonth.get(bucketKey) || [];
      existing.push({
        fulfillmentDate,
        customerId: row.customerId,
        customerName: row.customerName,
        localLineOrderId: row.localLineOrderId
      });
      orderGroupsByKeyMonth.set(bucketKey, existing);
    }

    return performanceSites
      .map((site) => {
        const siteKey = getDropSitePerformanceKey({
          name: site.name,
          strategyId: site.localLineFulfillmentStrategyId
        });
        const trendSeries = isTrendMode
          ? trendWeeks
              .map((week) => {
                const weekStart = toDateOrNull(week.weekStart);
                const weekEnd = addDays(weekStart, 7);
                const monthKey = formatMonthKey(weekStart);
                const groupedRows = orderGroupsByKeyMonth.get(`${siteKey}|${monthKey}`) || [];
                const rows = groupedRows.filter((row) =>
                  isDateInRange(row.fulfillmentDate, weekStart, weekEnd)
                );
                return buildSeriesEntry({
                  site,
                  rows,
                  rangeStart: weekStart,
                  rangeEnd: weekEnd,
                  monthKey: week.month,
                  weekStart: week.weekStart
                });
              })
              .filter((entry) => {
                const weekStart = toDateOrNull(entry.weekStart);
                return weekStart instanceof Date && weekStart <= latestCompletedWeekStart;
              })
          : monthsForData.map((monthKey) => {
              const groupedRows = orderGroupsByKeyMonth.get(`${siteKey}|${monthKey}`) || [];
              const monthInfo = parseMonthKey(monthKey);
              const rangeEnd =
                monthInfo && monthInfo.end > completedFulfillmentCutoff
                  ? completedFulfillmentCutoff
                  : monthInfo?.end || null;
              return monthInfo && rangeEnd && rangeEnd > monthInfo.start
                ? buildSeriesEntry({
                    site,
                    rows: groupedRows,
                    rangeStart: monthInfo.start,
                    rangeEnd,
                    monthKey
                  })
                : buildSeriesEntry({
                    site,
                    rows: [],
                    rangeStart: completedFulfillmentCutoff,
                    rangeEnd: completedFulfillmentCutoff,
                    monthKey
                  });
            });

        const totalOrderCount = trendSeries.reduce((sum, entry) => sum + Number(entry.orderCount || 0), 0);
        const totalScheduledDrops = trendSeries.reduce((sum, entry) => sum + Number(entry.scheduledDrops || 0), 0);
        const totalActiveDropWeeks = trendSeries.reduce((sum, entry) => sum + Number(entry.activeDropWeeks || 0), 0);
        const averageWeeklyOrders =
          totalScheduledDrops > 0
            ? Number((totalOrderCount / totalScheduledDrops).toFixed(2))
            : 0;
        const averageOrdersPerActiveDropWeek =
          totalActiveDropWeeks > 0
            ? Number((totalOrderCount / totalActiveDropWeeks).toFixed(2))
            : 0;
        const latestAverageOrdersPerActiveDropWeek = Number(
          trendSeries[trendSeries.length - 1]?.averageOrdersPerActiveDropWeek || 0
        );
        const latestAverageWeeklyOrders = Number(
          trendSeries[trendSeries.length - 1]?.averageWeeklyOrders || 0
        );
        const latestLegacyMonthlyUniqueCustomers = Number(
          trendSeries[trendSeries.length - 1]?.legacyMonthlyUniqueCustomers || 0
        );
        const legacyMonthlyUniqueCustomers = isTrendMode
          ? latestLegacyMonthlyUniqueCustomers
          : Number(trendSeries[0]?.legacyMonthlyUniqueCustomers || 0);
        const primaryAverage = isTrendMode
          ? latestAverageOrdersPerActiveDropWeek
          : averageOrdersPerActiveDropWeek;
        const weeklyCreditEligible = primaryAverage >= WEEKLY_CREDIT_THRESHOLD;
        const legacyCreditEligible = legacyMonthlyUniqueCustomers > LEGACY_MONTHLY_UNIQUE_THRESHOLD;
        const detailSeries = trendSeries
          .flatMap((entry) => Array.isArray(entry.detailPoints) ? entry.detailPoints : [])
          .sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")));

        return {
          id: site.id,
          name: site.name,
          area: site.area || "",
          source: site.source,
          active: site.active,
          localLineFulfillmentStrategyId: site.localLineFulfillmentStrategyId,
          ...(includeHostContact ? { derivedHostContact: site.derivedHostContact || null } : {}),
          orderCount: totalOrderCount,
          scheduledDrops: totalScheduledDrops,
          activeDropWeeks: totalActiveDropWeeks,
          averageWeeklyOrders,
          averageOrdersPerScheduledDropWeek: averageWeeklyOrders,
          averageOrdersPerActiveDropWeek,
          latestAverageWeeklyOrders,
          latestAverageOrdersPerActiveDropWeek,
          legacyMonthlyUniqueCustomers,
          latestLegacyMonthlyUniqueCustomers,
          weeklyCreditEligible,
          legacyCreditEligible,
          transitionCreditEligible: weeklyCreditEligible || legacyCreditEligible,
          thresholdMet: weeklyCreditEligible,
          performanceTier: getDropSitePerformanceTier(primaryAverage),
          trendSeries,
          detailSeries
        };
      })
      .sort((left, right) => {
        const leftSortValue = isTrendMode
          ? Number(left.latestAverageOrdersPerActiveDropWeek || 0)
          : Number(left.averageOrdersPerActiveDropWeek || 0);
        const rightSortValue = isTrendMode
          ? Number(right.latestAverageOrdersPerActiveDropWeek || 0)
          : Number(right.averageOrdersPerActiveDropWeek || 0);
        if (rightSortValue !== leftSortValue) {
          return rightSortValue - leftSortValue;
        }
        if (right.averageOrdersPerScheduledDropWeek !== left.averageOrdersPerScheduledDropWeek) {
          return right.averageOrdersPerScheduledDropWeek - left.averageOrdersPerScheduledDropWeek;
        }
        if (right.orderCount !== left.orderCount) {
          return right.orderCount - left.orderCount;
        }
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
  }

  let rankedSites = [];
  if (monthsForData.length) {
    const monthPlaceholders = monthsForData.map(() => "?").join(", ");
    let reportingOrderRows = [];
    try {
      [reportingOrderRows] = await queryWithConnectionRetry(
        pool,
        `
          SELECT DISTINCT
            NULL AS fulfillmentStrategyId,
            COALESCE(NULLIF(TRIM(fulfillment_name), ''), 'Unassigned') AS fulfillmentSiteName,
            STR_TO_DATE(NULLIF(TRIM(fulfillment_date), ''), '%Y-%m-%d') AS fulfillmentDate,
            NULL AS customerId,
            customer_name AS customerName,
            local_line_order_id AS localLineOrderId
          FROM local_line_order_reporting_entries
          WHERE fulfillment_month IN (${monthPlaceholders})
            AND fulfillment_date IS NOT NULL
            AND TRIM(fulfillment_date) <> ''
        `,
        monthsForData
      );
    } catch (error) {
      if (!isMissingReportingCacheError(error)) {
        throw error;
      }
    }

    if (reportingOrderRows.length) {
      rankedSites = buildRankedSitesFromOrderRows(reportingOrderRows);
    }
  }

  if (!rankedSites.length && monthsForData.length) {
    const monthPlaceholders = monthsForData.map(() => "?").join(", ");
    const [orderRows] = await queryWithConnectionRetry(
      pool,
      `
        SELECT
          ${fulfillmentStrategyIdSql} AS fulfillmentStrategyId,
          ${fulfillmentSiteSql} AS fulfillmentSiteName,
          ${fulfillmentDateSql} AS fulfillmentDate,
          o.customer_id AS customerId,
          o.customer_name AS customerName,
          o.local_line_order_id AS localLineOrderId
        FROM local_line_orders o
        LEFT JOIN drop_sites ds
          ON ds.local_line_fulfillment_strategy_id = ${fulfillmentStrategyIdSql}
        WHERE ${fulfillmentDateSql} IS NOT NULL
          AND ${fulfillmentDateSql} < ?
          AND DATE_FORMAT(${fulfillmentDateSql}, '%Y-%m') IN (${monthPlaceholders})
      `,
      [completedFulfillmentCutoff, ...monthsForData]
    );

    rankedSites = buildRankedSitesFromOrderRows(orderRows);
  }

  const payload = {
    dropSites: publicOnly ? performanceSites.map((site) => sanitizePublicSite(site)) : visibleDropSites,
    performance: {
      mode: isTrendMode ? "trend6" : "month",
      selectedMonth: isTrendMode ? TREND_MODE_KEY : selectedMonth,
      months: performanceMonths,
      trendMonths,
      trendWeeks,
      thresholdAverage: WEEKLY_CREDIT_THRESHOLD,
      thresholdOperator: ">=",
      thresholdLabel: `${WEEKLY_CREDIT_THRESHOLD} or more`,
      strongAverage: STRONG_WEEKLY_AVERAGE,
      legacyMonthlyUniqueThreshold: LEGACY_MONTHLY_UNIQUE_THRESHOLD,
      rollout: {
        notificationMonth: "2026-06",
        weeklyMetricStartsOn: "2026-07-01",
        firstCreditMonth: "2026-08",
        transitionMode: "compare-then-switch"
      },
      rankedSites
    }
  };

  if (!publicOnly) return payload;
  return {
    dropSites: payload.dropSites,
    performance: sanitizePublicPerformance(payload.performance)
  };
}
