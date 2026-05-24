import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  ensureLocalLineSyncSchema,
  ensureMarketingSchema,
  ensureSubscriptionPortalSchema,
  ensureSubscriberCaptureSchema,
  getDb,
  isMissingTableError
} from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  marketingCampaigns,
  marketingClickEvents,
  marketingSessions,
  marketingSubscriberEvents,
  marketingUtmLinks,
  localLinePriceListEntries,
  localLinePackageMeta,
  dropSites,
  packages,
  productMedia,
  productImages,
  productPricingProfiles,
  products,
  productSales,
  memberHerdshareStatuses,
  memberProfiles,
  memberSubscriptions,
  subscribeLeads,
  productTags,
  recipes,
  reviews,
  subscriptionSettings,
  tags,
  users,
  vendors
} from "../schema.js";
import { requireUser } from "../middleware/auth.js";
import { computeProductPricingSnapshot } from "../lib/productPricing.js";
import { issueUserToken } from "../lib/authTokens.js";
import { sendSubscribeLeadNotification } from "../lib/email.js";
import {
  computeNextBillingDate,
  ensureMemberLedgerAccounts,
  getPlanDefinition,
  loadSubscriptionSettings,
  normalizeBillingDay,
  normalizePlanKey
} from "../lib/memberPortal.js";

const router = express.Router();

function parsePriceListId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getStorefrontLocalLinePriceListIds() {
  return [
    parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID)
  ].filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);
}

function getExcludedStoreCategoryNames() {
  const configured = String(process.env.STORE_CATALOG_EXCLUDED_CATEGORY_NAMES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured.length) {
    configured.push("Membership");
  }
  return new Set(configured.map((value) => value.toLowerCase()));
}

function isVisiblePriceListEntry(row) {
  return row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible);
}

function chooseLowerPrice(current, candidate) {
  if (!Number.isFinite(candidate)) return current;
  if (!Number.isFinite(current)) return candidate;
  return candidate < current ? candidate : current;
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function computeDerivedSaleDiscount(finalPrice, strikethroughDisplayValue) {
  const finalValue = Number(finalPrice);
  const strikeValue = Number(strikethroughDisplayValue);
  if (!Number.isFinite(finalValue) || !Number.isFinite(strikeValue) || strikeValue <= finalValue || strikeValue <= 0) {
    return null;
  }
  return Number(((strikeValue - finalValue) / strikeValue).toFixed(4));
}

function isRealLocalLineSale(row) {
  const derivedDiscount = computeDerivedSaleDiscount(
    row.finalPriceCache,
    row.strikethroughDisplayValue
  );
  return Boolean(row.onSaleToggle) || (Number.isFinite(derivedDiscount) && derivedDiscount > 0);
}

function cleanString(value, maxLength = 255) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLength);
}

function cleanOptionalString(value, maxLength = 255) {
  const trimmed = cleanString(value, maxLength);
  return trimmed || null;
}

function cleanOptionalText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function cleanOptionalUrl(value) {
  return cleanOptionalString(value, 2048);
}

function isEnvEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isSubscribePortalOnboardingEnabled() {
  // Temporary merge-prep toggle. Set SUBSCRIBE_PORTAL_ONBOARDING_ENABLED=true
  // to restore account/subscription creation from the public subscribe form.
  return isEnvEnabled(process.env.SUBSCRIBE_PORTAL_ONBOARDING_ENABLED);
}

function toFloat(value) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function toInteger(value) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeMessageFocus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["farm", "csa", "food", "event", "mixed"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function buildMergedSearchParams(...values) {
  const params = new URLSearchParams();
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const next = new URLSearchParams(raw.replace(/^\?/, ""));
    for (const [key, entryValue] of next.entries()) {
      params.set(key, entryValue);
    }
  }
  return params;
}

function deriveSourceFromUrl(urlValue, fallbackHost = null, fallbackPath = null) {
  let sourceHost = cleanOptionalString(fallbackHost, 255);
  let sourcePath = cleanOptionalString(fallbackPath, 255);
  const url = cleanOptionalUrl(urlValue);
  if (!url) return { sourceHost, sourcePath };

  try {
    const parsed = new URL(url);
    sourceHost = sourceHost || cleanOptionalString(parsed.host, 255);
    sourcePath = sourcePath || cleanOptionalString(parsed.pathname, 255);
  } catch (_error) {
    // Ignore invalid URLs and preserve fallbacks.
  }

  return { sourceHost, sourcePath };
}

function deriveHostFromUrl(urlValue) {
  const value = cleanOptionalUrl(urlValue);
  if (!value) return null;
  try {
    return cleanOptionalString(new URL(value).host, 255);
  } catch (_error) {
    return null;
  }
}

function extractMarketingParams(payload = {}, searchParams = new URLSearchParams()) {
  const csaTargetDropSite = cleanOptionalString(
    payload.csaTargetDropSite ||
      payload.csa_target_drop_site ||
      payload.targetDropSite ||
      searchParams.get("csa_target_drop_site"),
    255
  );
  return {
    utmSource: cleanOptionalString(payload.utmSource || payload.utm_source || searchParams.get("utm_source"), 255),
    utmMedium: cleanOptionalString(payload.utmMedium || payload.utm_medium || searchParams.get("utm_medium"), 255),
    utmCampaign: cleanOptionalString(
      payload.utmCampaign || payload.utm_campaign || searchParams.get("utm_campaign"),
      255
    ),
    utmContent: cleanOptionalString(payload.utmContent || payload.utm_content || searchParams.get("utm_content"), 255),
    utmTerm: cleanOptionalString(payload.utmTerm || payload.utm_term || searchParams.get("utm_term"), 255),
    csaTrackToken: cleanOptionalString(
      payload.csaTrackToken ||
        payload.csa_track ||
        payload.sessionToken ||
        searchParams.get("csa_track") ||
        searchParams.get("csa_session"),
      64
    ),
    csaLinkSlug: cleanOptionalString(payload.csaLinkSlug || payload.csa_link || searchParams.get("csa_link"), 255),
    csaCampaignSlug: cleanOptionalString(
      payload.csaCampaignSlug || payload.csa_campaign || searchParams.get("csa_campaign"),
      255
    ),
    messageFocus: normalizeMessageFocus(
      payload.messageFocus || payload.csa_message_focus || searchParams.get("csa_message_focus")
    ),
    targetCity: cleanOptionalString(
      payload.targetCity || payload.csa_target_city || searchParams.get("csa_target_city"),
      255
    ),
    targetZip: cleanOptionalString(
      payload.targetZip || payload.csa_target_zip || searchParams.get("csa_target_zip"),
      64
    ),
    targetLocationLabel: cleanOptionalString(
      payload.targetLocationLabel ||
        payload.csa_target_location ||
        searchParams.get("csa_target_location") ||
        (searchParams.get("csa_target_drop_site") && !searchParams.get("csa_target_location")
          ? searchParams.get("csa_target_drop_site")
          : null),
      255
    ),
    targetDropSiteId: toInteger(
      payload.targetDropSiteId ||
        payload.csa_target_drop_site ||
        searchParams.get("csa_target_drop_site")
    ),
    targetDropSiteLabel: csaTargetDropSite
  };
}

function buildMarketingTagSpec(baseUrl = "") {
  const normalizedBase = String(baseUrl || "").trim().replace(/\/$/, "");
  const subscribeBase =
    process.env.PUBLIC_SUBSCRIBE_URL ||
    process.env.SUBSCRIBE_APP_BASE_URL ||
    "https://subscribe.deckfamilyfarm.com";
  return {
    version: 1,
    standardUtmTags: [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term"
    ],
    csaTags: [
      "csa_track",
      "csa_link",
      "csa_campaign",
      "csa_message_focus",
      "csa_target_city",
      "csa_target_zip",
      "csa_target_location",
      "csa_target_drop_site"
    ],
    messageFocusValues: ["farm", "csa", "food", "event", "mixed"],
    exampleSubscribeUrl:
      `${subscribeBase}/?utm_source=facebook&utm_medium=paid-social&` +
      "utm_campaign=spring_csa_eugene&utm_content=creative_a&" +
      "csa_message_focus=csa&csa_target_city=Eugene&csa_target_location=Eugene",
    exampleRedirectUrl: normalizedBase
      ? `${normalizedBase}/api/marketing/go/spring-csa-eugene-fb-a`
      : "/api/marketing/go/spring-csa-eugene-fb-a"
  };
}

async function loadMarketingCampaignById(db, campaignId) {
  if (!Number.isFinite(Number(campaignId)) || Number(campaignId) <= 0) return null;
  const rows = await db
    .select()
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.id, Number(campaignId)));
  return rows[0] || null;
}

async function loadMarketingUtmLinkById(db, linkId) {
  if (!Number.isFinite(Number(linkId)) || Number(linkId) <= 0) return null;
  const rows = await db
    .select()
    .from(marketingUtmLinks)
    .where(eq(marketingUtmLinks.id, Number(linkId)));
  return rows[0] || null;
}

async function resolveMarketingAttribution(db, marketingParams) {
  let sessionRow = null;
  let linkRow = null;
  let campaignRow = null;
  let matchMethod = null;

  if (marketingParams.csaTrackToken) {
    const rows = await db
      .select()
      .from(marketingSessions)
      .where(eq(marketingSessions.sessionToken, marketingParams.csaTrackToken));
    sessionRow = rows[0] || null;
    if (sessionRow) matchMethod = "session_token";
  }

  if (!linkRow && marketingParams.csaLinkSlug) {
    const rows = await db
      .select()
      .from(marketingUtmLinks)
      .where(eq(marketingUtmLinks.slug, marketingParams.csaLinkSlug));
    linkRow = rows[0] || null;
    if (linkRow && !matchMethod) matchMethod = "link_slug";
  }

  if (!campaignRow && marketingParams.csaCampaignSlug) {
    const rows = await db
      .select()
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.slug, marketingParams.csaCampaignSlug));
    campaignRow = rows[0] || null;
    if (campaignRow && !matchMethod) matchMethod = "campaign_slug";
  }

  if (!linkRow && sessionRow?.utmLinkId) {
    linkRow = await loadMarketingUtmLinkById(db, sessionRow.utmLinkId);
    if (linkRow && !matchMethod) matchMethod = "session_link";
  }

  if (!campaignRow && linkRow?.campaignId) {
    campaignRow = await loadMarketingCampaignById(db, linkRow.campaignId);
    if (campaignRow && !matchMethod) matchMethod = "link_campaign";
  }

  if (!campaignRow && sessionRow?.campaignId) {
    campaignRow = await loadMarketingCampaignById(db, sessionRow.campaignId);
    if (campaignRow && !matchMethod) matchMethod = "session_campaign";
  }

  return {
    sessionRow,
    linkRow,
    campaignRow,
    matchMethod
  };
}

async function upsertMarketingSession(db, {
  sessionToken,
  campaignId = null,
  utmLinkId = null,
  sourceHost = null,
  sourcePath = null,
  landingUrl = null,
  referrerUrl = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  utmContent = null,
  utmTerm = null,
  messageFocus = null,
  targetCity = null,
  targetZip = null,
  targetLocationLabel = null,
  targetDropSiteId = null,
  clientIp = null,
  userAgent = null,
  now = new Date()
}) {
  if (!sessionToken) return null;

  const existingRows = await db
    .select()
    .from(marketingSessions)
    .where(eq(marketingSessions.sessionToken, sessionToken));
  const existing = existingRows[0] || null;

  const nextValues = {
    campaignId: campaignId ?? existing?.campaignId ?? null,
    utmLinkId: utmLinkId ?? existing?.utmLinkId ?? null,
    sourceHost: sourceHost ?? existing?.sourceHost ?? null,
    sourcePath: sourcePath ?? existing?.sourcePath ?? null,
    landingUrl: landingUrl ?? existing?.landingUrl ?? null,
    referrerUrl: referrerUrl ?? existing?.referrerUrl ?? null,
    utmSource: utmSource ?? existing?.utmSource ?? null,
    utmMedium: utmMedium ?? existing?.utmMedium ?? null,
    utmCampaign: utmCampaign ?? existing?.utmCampaign ?? null,
    utmContent: utmContent ?? existing?.utmContent ?? null,
    utmTerm: utmTerm ?? existing?.utmTerm ?? null,
    messageFocus: messageFocus ?? existing?.messageFocus ?? null,
    targetCity: targetCity ?? existing?.targetCity ?? null,
    targetZip: targetZip ?? existing?.targetZip ?? null,
    targetLocationLabel: targetLocationLabel ?? existing?.targetLocationLabel ?? null,
    targetDropSiteId: targetDropSiteId ?? existing?.targetDropSiteId ?? null,
    clientIp: clientIp ?? existing?.clientIp ?? null,
    userAgent: userAgent ?? existing?.userAgent ?? null,
    lastSeenAt: now,
    updatedAt: now
  };

  if (existing) {
    await db
      .update(marketingSessions)
      .set(nextValues)
      .where(eq(marketingSessions.id, existing.id));
    const updatedRows = await db
      .select()
      .from(marketingSessions)
      .where(eq(marketingSessions.id, existing.id));
    return updatedRows[0] || existing;
  }

  const result = await db.insert(marketingSessions).values({
    sessionToken,
    ...nextValues,
    firstSeenAt: now,
    createdAt: now
  });
  const insertedId = Number(result[0]?.insertId);
  if (!Number.isFinite(insertedId) || insertedId <= 0) return null;
  const insertedRows = await db
    .select()
    .from(marketingSessions)
    .where(eq(marketingSessions.id, insertedId));
  return insertedRows[0] || null;
}

function normalizeCoordinatePair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = toFloat(value[0]);
  const latitude = toFloat(value[1]);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function parseKmlCoordinateBlock(block) {
  return String(block || "")
    .trim()
    .split(/\s+/)
    .map((entry) => normalizeCoordinatePair(entry.split(",")))
    .filter(Boolean);
}

function closePolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const first = points[0];
  const last = points[points.length - 1];
  if (first.latitude === last.latitude && first.longitude === last.longitude) {
    return points;
  }
  return [...points, first];
}

function parseKmlPolygons(kmlText) {
  const polygons = [];
  const matches = String(kmlText || "").matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi);
  for (const match of matches) {
    const points = closePolygon(parseKmlCoordinateBlock(match[1]));
    if (points.length >= 4) polygons.push(points);
  }
  return polygons;
}

function pointInPolygon(latitude, longitude, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 4) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].longitude;
    const yi = polygon[i].latitude;
    const xj = polygon[j].longitude;
    const yj = polygon[j].latitude;
    const intersects =
      yi > latitude !== yj > latitude &&
      longitude < ((xj - xi) * (latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.7613;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function isVisibleSubscribeDropSiteRow(site) {
  const name = String(site?.name || "").trim().toLowerCase();
  if (!name) return false;
  return !(
    name.includes("membership purchase") ||
    name.includes("herdshare purchase") ||
    name.includes("snap fulfillment membership")
  );
}

function isDeliveryDropSiteRow(site) {
  return (
    String(site?.fulfillmentType || "").trim().toLowerCase() === "delivery" ||
    String(site?.type || "").trim().toLowerCase() === "postalcodes" ||
    String(site?.name || "").trim().toLowerCase().includes("home delivery")
  );
}

function selectPreferredHomeDeliverySite(deliverySites, addressInput, geocodedDisplayName) {
  const normalizedCity = String(addressInput?.city || "").trim().toLowerCase();
  const normalizedDisplay = String(geocodedDisplayName || "").trim().toLowerCase();
  const wantsCorvallis = normalizedCity.includes("corvallis") || normalizedDisplay.includes("corvallis");
  const normalizedSites = Array.isArray(deliverySites) ? deliverySites : [];
  const corvallisSite = normalizedSites.find((site) =>
    String(site?.name || "").trim().toLowerCase().includes("corvallis")
  );
  const valleySite = normalizedSites.find((site) => {
    const name = String(site?.name || "").trim().toLowerCase();
    return (
      name.includes("eugene") ||
      name.includes("springfield") ||
      name.includes("junction city")
    );
  });

  return wantsCorvallis ? corvallisSite || valleySite || null : valleySite || corvallisSite || null;
}

function getLocationIqConfig() {
  const apiKey = String(
    process.env.LOCATIONIQ_API_KEY || process.env.LOCATIONIQ_KEY || ""
  ).trim();
  const baseUrl = String(process.env.LOCATIONIQ_BASE_URL || "https://us1.locationiq.com/v1")
    .trim()
    .replace(/\/$/, "");
  return { apiKey, baseUrl };
}

function getFetchTimeoutMs(envKey, fallbackMs) {
  const numeric = Number.parseInt(String(process.env[envKey] || ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackMs;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000, timeoutMessage = "Request timed out.") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildLocationIqAddressPayload({
  addressLine1,
  addressLine2,
  city,
  stateProvince,
  postalCode,
  country
}) {
  return {
    street: [cleanString(addressLine1), cleanString(addressLine2)].filter(Boolean).join(" "),
    city: cleanString(city),
    state: cleanString(stateProvince),
    postalcode: cleanString(postalCode, 32),
    country: cleanString(country || "United States", 128)
  };
}

let deliveryAreaPolygonCache = null;
let deliveryAreaPolygonFetchedAt = 0;
let deliveryAreaPolygonPromise = null;
let activeDropSitesCache = null;
let activeDropSitesFetchedAt = 0;
let activeDropSitesPromise = null;

async function getActiveDropSites(db) {
  const now = Date.now();
  if (activeDropSitesCache && now - activeDropSitesFetchedAt < 10 * 60 * 1000) {
    return activeDropSitesCache;
  }

  if (!activeDropSitesPromise) {
    activeDropSitesPromise = (async () => {
      const rows = await db.select().from(dropSites).where(eq(dropSites.active, 1));
      activeDropSitesCache = rows;
      activeDropSitesFetchedAt = Date.now();
      return rows;
    })().finally(() => {
      activeDropSitesPromise = null;
    });
  }

  return activeDropSitesPromise;
}

async function getDeliveryAreaPolygons() {
  const now = Date.now();
  if (deliveryAreaPolygonCache && now - deliveryAreaPolygonFetchedAt < 15 * 60 * 1000) {
    return deliveryAreaPolygonCache;
  }

  if (!deliveryAreaPolygonPromise) {
    const deliveryAreaUrl =
      process.env.DELIVERY_AREA_KML_URL ||
      "https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/dropsite_maps/dropsites.kml";
    const timeoutMs = getFetchTimeoutMs("DELIVERY_AREA_FETCH_TIMEOUT_MS", 5000);
    deliveryAreaPolygonPromise = (async () => {
      const response = await fetchWithTimeout(
        deliveryAreaUrl,
        {
        headers: { "User-Agent": "csa-store/subscribe-address-check" }
        },
        timeoutMs,
        "Delivery area lookup timed out."
      );
      if (!response.ok) {
        throw new Error(`Delivery area fetch failed (${response.status})`);
      }
      const kmlText = await response.text();
      const polygons = parseKmlPolygons(kmlText);
      if (!polygons.length) {
        throw new Error("No delivery polygons found in KML");
      }
      deliveryAreaPolygonCache = polygons;
      deliveryAreaPolygonFetchedAt = Date.now();
      return polygons;
    })().finally(() => {
      deliveryAreaPolygonPromise = null;
    });
  }

  return deliveryAreaPolygonPromise;
}

async function geocodeAddressWithLocationIq(addressInput) {
  const { apiKey, baseUrl } = getLocationIqConfig();
  if (!apiKey) {
    throw new Error("Address validation is not configured.");
  }

  const params = new URLSearchParams({
    key: apiKey,
    format: "json",
    normalizeaddress: "1",
    addressdetails: "1",
    ...buildLocationIqAddressPayload(addressInput)
  });

  const response = await fetchWithTimeout(
    `${baseUrl}/search/structured?${params.toString()}`,
    {
      headers: { "User-Agent": "csa-store/subscribe-address-check" }
    },
    getFetchTimeoutMs("LOCATIONIQ_TIMEOUT_MS", 8000),
    "Address lookup timed out. Please try again."
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Geocoding failed (${response.status})`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload) || !payload.length) {
    throw new Error("Address could not be located.");
  }

  const match = payload[0] || {};
  const latitude = toFloat(match.lat);
  const longitude = toFloat(match.lon);
  if (latitude === null || longitude === null) {
    throw new Error("Address geocoding returned no usable coordinates.");
  }

  return {
    latitude,
    longitude,
    displayName: cleanOptionalString(match.display_name, 1024)
  };
}

async function resolveSubscriptionAddressInsights(db, addressInput) {
  const geocoded = await geocodeAddressWithLocationIq(addressInput);
  const dropSiteRows = await getActiveDropSites(db);
  const deliverySites = dropSiteRows
    .filter((site) => isVisibleSubscribeDropSiteRow(site) && isDeliveryDropSiteRow(site))
    .map((site) => ({
      name: String(site.name || "").trim() || null,
      address: cleanOptionalString(site.address, 1024),
      dayOfWeek: cleanOptionalString(site.dayOfWeek, 16)
    }));
  const pickupDropSites = dropSiteRows.filter(
    (site) =>
      isVisibleSubscribeDropSiteRow(site) &&
      !isDeliveryDropSiteRow(site) &&
      toFloat(site.latitude) !== null &&
      toFloat(site.longitude) !== null
  );
  const nearestPickupSites = pickupDropSites
    .map((site) => {
      const siteLatitude = toFloat(site.latitude);
      const siteLongitude = toFloat(site.longitude);
      if (siteLatitude === null || siteLongitude === null) return null;
      return {
        name: String(site.name || "").trim() || null,
        address: cleanOptionalString(site.address, 1024),
        dayOfWeek: cleanOptionalString(site.dayOfWeek, 16),
        distanceMiles: Number(
          haversineMiles(
            geocoded.latitude,
            geocoded.longitude,
            siteLatitude,
            siteLongitude
          ).toFixed(2)
        )
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distanceMiles - right.distanceMiles)
    .slice(0, 3);

  let closestDropSite = null;
  let closestDropSiteAddress = null;
  let closestDropSiteDistanceMiles = null;
  if (nearestPickupSites.length) {
    closestDropSite = nearestPickupSites[0].name;
    closestDropSiteAddress = nearestPickupSites[0].address;
    closestDropSiteDistanceMiles = nearestPickupSites[0].distanceMiles;
  }

  const preferredHomeDeliverySite = selectPreferredHomeDeliverySite(
    deliverySites,
    addressInput,
    geocoded.displayName
  );

  let insideHomeDeliveryArea = null;
  try {
    const polygons = await getDeliveryAreaPolygons();
    insideHomeDeliveryArea = polygons.some((polygon) =>
      pointInPolygon(geocoded.latitude, geocoded.longitude, polygon)
    );
  } catch (error) {
    console.warn("Delivery area lookup failed:", error.message);
  }

  return {
    geocodedLatitude: geocoded.latitude,
    geocodedLongitude: geocoded.longitude,
    geocodedDisplayName: geocoded.displayName,
    closestDropSite,
    closestDropSiteAddress,
    closestDropSiteDistanceMiles:
      closestDropSiteDistanceMiles === null
        ? null
        : Number(closestDropSiteDistanceMiles.toFixed(2)),
    insideHomeDeliveryArea,
    nearestPickupSites,
    preferredHomeDeliverySite
  };
}

const LIABILITY_AGREEMENT_URL =
  "https://docs.google.com/document/d/1VFMc4euofQ1S1kjtd6jZI46uxo6YKft9cufT6Q3-nrc/edit?tab=t.0";
const LIABILITY_AGREEMENT_TITLE = "Full Farm CSA LLC Product Liability Agreement";
const LIABILITY_AGREEMENT_PARAGRAPHS = [
  "Mailing address: P.O. Box 565, Junction City, OR 97128",
  "Farm Location: 25362 High Pass Rd, Junction City, OR 97448",
  "541-321-0925 • fullfarmcsa@deckfamilyfarm.com",
  "Thank you for becoming a member of the Full Farm CSA! We are excited to have you be part of our “farmily” and share in the adventure of producing wholesome, nutrient dense foods. Our commitment to you is to produce our farm products in the cleanest and safest way possible; however, it is important to acknowledge that there are inherent risks in consuming food direct from the farm, and we expect that you are educated in the decision to eat as we do. Your food options will include raw milk, farm-processed meat animals, eggs, vegetables, fruit, grains, and other incidentals. Oregon State law prohibits selling these products to consumers, so it needs to be made explicitly clear that our Full Farm CSA, herein called “FFCSA” is a membership group that shares ownership with the farm in the meat, milk and other products that the FFCSA produces.",
  "Ownership agreement:",
  "I/we agree to become full members in the FFCSA and take ownership, along with other FFCSA members, Deck Family Farm, Sweet Leaf Organics, Organic Corner Market, Little Wings Farm, Lonesome Whistle Farm, Camas Country Mill, Beetanical Apiary, and any additional member farms, in the dairy herd, any meat animals (hogs, cattle, poultry, sheep), laying hens, and produce, grains, legumes, nuts, honey and fruit crops. My membership fees listed on the financial agreement compensate the farmers for pasturing, feeding, milking, and any required health care for my animals, as well as the cost of producing the non-animal crops. Full Farm CSA LLC retains full decision-making power over animals and crops.",
  "I/we agree and understand that raw milk, farm processed meat, and the products that come to me direct from the garden are raw agricultural products and I/we accept all of the health benefits and concerns associated with it, and I/we do not hold Full Farm CSA LLC nor its members or member farms responsible for any food borne illnesses associated with raw milk, meat or raw produce, nuts, honey or fruit consumption.",
  "I/we have been informed and understand that I/we are choosing to receive as part of my farm membership raw cow milk and other raw agricultural products. I/we will not hold Full Farm CSA LLC, other FFCSA members, or member farms responsible or liable for any injury, in any way, after purchasing this membership and receiving the products including but not limited to raw milk, meat, eggs; and I/we am solely responsible for my health and safety while on the farm premises for any activity, including but not limited to: CSA pick-up, U-pick harvests, and farm events.",
  "I/we agree that I/we will not pursue any legal actions, suits, claims for relief, demands, damages, and any other obligations, known and unknown, suspected and unsuspected, in law or equity, direct or indirect, and whether now or in the future, for any injury or death arising from use of these products what-so-ever.",
  "I/we agree that my FFCSA Membership is not transferable and that I/we will not sell nor share my membership to/with anyone else. I/we agree to give written notice immediately upon decision to cancel membership. I/we agree that I am not entitled to a refund of unused membership shares, but may choose to donate unused funds to our Feed-a-Friend program.",
  "I/we understand as a FFCSA Member that it is my responsibility to ensure that any product I/we purchase is cared for properly to guarantee its freshness and quality. Therefore, I/we agree to bring clean containers and a cooler with ice to pick-up for safe transport of my goods to my home refrigerator and pantry. I/we also agree to conscientiously follow all health and safety guidelines while at pick-up and on the farm.",
  "I/we agree to pick up my share from my drop site or farm each week and if I/we intend to come to the farm for Friday pick up I/we will give 24 hours advance notice if I/we want to attend the farm dinner.",
  "I/we understand that Full Farm CSA LLC is committed to supplying a wide variety of abundant fresh farm products, however I/we understand that farming is unpredictable. In joining Full Farm CSA LLC, I/we understand that there will be variations in the quantity and the quality of food that I/we receive, including substitutions, depending on weather and other factors.",
  "By purchasing products through the Full Farm CSA, I/we have read and understand the Full Farm CSA LLC Product Liability Agreement and agree to their contents on behalf of my member household. This document supersedes any prior document on the same subject."
];

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

function hasSpacesUploadConfig() {
  return Boolean(
    process.env.DO_SPACES_BUCKET &&
      process.env.DO_SPACES_ENDPOINT &&
      process.env.DO_SPACES_KEY &&
      process.env.DO_SPACES_SECRET
  );
}

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseSignatureDataUrl(value) {
  const input = String(value || "").trim();
  const match = input.match(/^data:(image\/png);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!buffer.length) return null;
    return {
      mimeType: match[1].toLowerCase(),
      buffer,
      dataUrl: input
    };
  } catch (_error) {
    return null;
  }
}

function wrapPdfText(text, maxChars = 86) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function buildSignedAgreementPdf({
  signerName,
  email,
  submittedAt,
  sourceHost,
  sourcePath,
  signatureBuffer,
  signatureMode
}) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const signatureImage = signatureBuffer ? await pdfDoc.embedPng(signatureBuffer) : null;
  const signedLabel = submittedAt.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short"
  });
  const pageSize = [612, 792];
  const marginX = 48;
  const bodyWidth = 516;
  const pageBottom = 56;

  function newPage() {
    page = pdfDoc.addPage(pageSize);
    return 740;
  }

  let y = 740;
  page.drawText(LIABILITY_AGREEMENT_TITLE, {
    x: marginX,
    y,
    size: 20,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 30;
  page.drawText(`Agreement source: ${LIABILITY_AGREEMENT_URL}`, {
    x: marginX,
    y,
    size: 10,
    font,
    color: rgb(0.35, 0.3, 0.26)
  });
  y -= 30;

  const metaLines = [
    `Signer: ${signerName}`,
    `Email: ${email}`,
    `Signed at: ${signedLabel}`,
    `Source: ${sourceHost || ""}${sourcePath || ""}`,
    "Statement: I have reviewed the Deck Family Farm product liability agreement and submit this signature as my agreement."
  ];

  for (const metaLine of metaLines) {
    for (const line of wrapPdfText(metaLine, 88)) {
      if (y <= pageBottom) y = newPage();
      page.drawText(line, {
        x: marginX,
        y,
        size: 11,
        font,
        color: rgb(0.12, 0.11, 0.09)
      });
      y -= 18;
    }
    y -= 6;
  }

  y -= 12;
  page.drawText("Agreement Text", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 24;

  for (const paragraph of LIABILITY_AGREEMENT_PARAGRAPHS) {
    const isHeading = paragraph.endsWith(":");
    const lines = wrapPdfText(paragraph, 92);
    for (const line of lines) {
      if (y <= pageBottom) y = newPage();
      page.drawText(line, {
        x: marginX,
        y,
        size: isHeading ? 12 : 10.5,
        font: isHeading ? boldFont : font,
        color: rgb(0.12, 0.11, 0.09),
        maxWidth: bodyWidth,
        lineHeight: 14
      });
      y -= isHeading ? 16 : 14;
    }
    y -= isHeading ? 6 : 10;
  }

  y = newPage();
  page.drawText("Signature", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 160;
  if (signatureImage) {
    const dims = signatureImage.scale(0.5);
    page.drawImage(signatureImage, {
      x: marginX,
      y,
      width: Math.min(dims.width, 320),
      height: Math.min(dims.height, 120)
    });
  } else {
    page.drawText(signerName, {
      x: marginX,
      y: y + 42,
      size: 28,
      font: italicFont,
      color: rgb(0.12, 0.11, 0.09)
    });
    page.drawText("Electronic signature by typed name", {
      x: marginX,
      y: y + 16,
      size: 10,
      font,
      color: rgb(0.35, 0.3, 0.26)
    });
  }
  page.drawLine({
    start: { x: marginX, y: y - 8 },
    end: { x: 380, y: y - 8 },
    thickness: 1,
    color: rgb(0.12, 0.11, 0.09)
  });
  page.drawText(signerName, {
    x: marginX,
    y: y - 24,
    size: 10,
    font,
    color: rgb(0.12, 0.11, 0.09)
  });

  return Buffer.from(await pdfDoc.save());
}

async function uploadSignedAgreementRecord({
  signerName,
  email,
  submittedAt,
  sourceHost,
  sourcePath,
  signatureBuffer,
  signatureMode
}) {
  if (!hasSpacesUploadConfig()) {
    throw new Error(
      "Signed agreement storage is not configured. Set DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_KEY, and DO_SPACES_SECRET."
    );
  }
  const stamp = submittedAt.toISOString().replace(/[:.]/g, "-");
  const slug = crypto.randomBytes(6).toString("hex");
  const key = `subscribe-agreements/${submittedAt.getUTCFullYear()}/${String(
    submittedAt.getUTCMonth() + 1
  ).padStart(2, "0")}/${stamp}-${slug}.pdf`;
  const pdf = await buildSignedAgreementPdf({
    signerName,
    email,
    submittedAt,
    sourceHost,
    sourcePath,
    signatureBuffer,
    signatureMode
  });
  await getSpacesClient().send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
      Body: pdf,
      ContentType: "application/pdf",
      ACL: "public-read"
    })
  );
  return buildPublicUrl(key);
}

router.get("/catalog", async (_req, res) => {
  try {
    const db = getDb();
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /catalog:", error.message);
    });

    const rawCategoryRows = await db.select().from(categories).orderBy(categories.name);
    const vendorRows = await db.select().from(vendors);
    const excludedCategoryNames = getExcludedStoreCategoryNames();
    const excludedCategoryIds = new Set(
      rawCategoryRows
        .filter((row) => excludedCategoryNames.has(String(row.name || "").trim().toLowerCase()))
        .map((row) => row.id)
    );
    const categoryRows = rawCategoryRows.filter((row) => !excludedCategoryIds.has(row.id));

    const rawProductRows = await db
      .select()
      .from(products)
      .where(and(eq(products.isDeleted, 0), eq(products.visible, 1)));
    const productRows = rawProductRows.filter((row) => !excludedCategoryIds.has(row.categoryId));

    const productIds = productRows.map((row) => row.id);

    const imageRows = productIds.length
      ? await db.select().from(productImages).where(inArray(productImages.productId, productIds))
      : [];
    let mediaRows = [];
    if (productIds.length) {
      try {
        mediaRows = await db.select().from(productMedia).where(inArray(productMedia.productId, productIds));
      } catch (error) {
        if (!isMissingTableError(error, "product_media")) throw error;
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
    let packageMetaRows = [];
    if (productIds.length) {
      try {
        packageMetaRows = await db
          .select()
          .from(localLinePackageMeta)
          .where(inArray(localLinePackageMeta.productId, productIds));
      } catch (error) {
        if (!isMissingTableError(error, "local_line_package_meta")) throw error;
      }
    }

    const storefrontLocalLinePriceListIds = getStorefrontLocalLinePriceListIds();
    let localLinePriceListEntryRows = [];
    if (productIds.length && storefrontLocalLinePriceListIds.length) {
      try {
        localLinePriceListEntryRows = await db
          .select()
          .from(localLinePriceListEntries)
          .where(
            and(
              inArray(localLinePriceListEntries.productId, productIds),
              inArray(
                localLinePriceListEntries.localLinePriceListId,
                storefrontLocalLinePriceListIds
              )
            )
          );
      } catch (error) {
        if (!isMissingTableError(error, "local_line_price_list_entries")) throw error;
      }
    }

    const saleRows = productIds.length
      ? await db.select().from(productSales).where(inArray(productSales.productId, productIds))
      : [];

    const reviewRows = productIds.length
      ? await db
          .select()
          .from(reviews)
          .where(and(inArray(reviews.productId, productIds), eq(reviews.status, "approved")))
      : [];

    const featuredTag = await db.select().from(tags).where(eq(tags.name, "featured"));
    const saleTag = await db.select().from(tags).where(eq(tags.name, "sale"));
    const featuredIds = featuredTag.length
      ? await db
          .select()
          .from(productTags)
          .where(eq(productTags.tagId, featuredTag[0].id))
      : [];
    const saleIds = saleTag.length
      ? await db
          .select()
          .from(productTags)
          .where(eq(productTags.tagId, saleTag[0].id))
      : [];

    const featuredSet = new Set(featuredIds.map((row) => row.productId));
    const saleSet = new Set(saleIds.map((row) => row.productId));

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

    const salesByProduct = saleRows.reduce((acc, row) => {
      acc[row.productId] = {
        onSale: Boolean(row.onSale),
        saleDiscount: row.saleDiscount !== null ? Number(row.saleDiscount) : null,
        updatedAt: row.updatedAt || null
      };
      return acc;
    }, {});

    const guestPriceListId = parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID);
    const memberPriceListIds = [
      parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
      parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID),
      parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID)
    ].filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);

    const localLineSalesByProduct = localLinePriceListEntryRows.reduce((acc, row) => {
      if (
        Number.isFinite(guestPriceListId) &&
        Number(row.localLinePriceListId) !== Number(guestPriceListId)
      ) {
        return acc;
      }

      const productId = row.productId;
      if (!acc[productId]) {
        acc[productId] = {
          hasEntries: false,
          onSale: false,
          saleDiscount: null,
          lastSyncedAt: null
        };
      }

      const visible =
        row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible);
      if (!visible) {
        return acc;
      }

      const entry = acc[productId];
      entry.hasEntries = true;
      if (
        !entry.lastSyncedAt ||
        toTimestamp(row.lastSyncedAt || row.updatedAt) > toTimestamp(entry.lastSyncedAt)
      ) {
        entry.lastSyncedAt = row.lastSyncedAt || row.updatedAt || null;
      }

      const derivedDiscount = computeDerivedSaleDiscount(
        row.finalPriceCache,
        row.strikethroughDisplayValue
      );
      const isOnSale = isRealLocalLineSale(row);

      if (isOnSale) {
        entry.onSale = true;
      }
      if (
        Number.isFinite(derivedDiscount) &&
        (entry.saleDiscount === null || derivedDiscount > entry.saleDiscount)
      ) {
        entry.saleDiscount = derivedDiscount;
      }

      return acc;
    }, {});

    const localLinePriceCacheByProduct = localLinePriceListEntryRows.reduce((acc, row) => {
      if (!isVisiblePriceListEntry(row)) {
        return acc;
      }
      const finalPrice =
        row.finalPriceCache !== null && typeof row.finalPriceCache !== "undefined"
          ? Number(row.finalPriceCache)
          : null;
      if (!Number.isFinite(finalPrice)) {
        return acc;
      }

      if (!acc[row.productId]) {
        acc[row.productId] = {
          byPriceListId: {}
        };
      }
      const current = acc[row.productId].byPriceListId[row.localLinePriceListId];
      acc[row.productId].byPriceListId[row.localLinePriceListId] = chooseLowerPrice(current, finalPrice);
      return acc;
    }, {});

    const reviewsByProduct = reviewRows.reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      acc[row.productId].push({
        id: row.id,
        rating: row.rating,
        title: row.title,
        body: row.body,
        createdAt: row.createdAt
      });
      return acc;
    }, {});

    const vendorMap = new Map(vendorRows.map((row) => [row.id, row.name]));
    const vendorRowMap = new Map(vendorRows.map((row) => [row.id, row]));
    const vendorMarkupMap = new Map(
      vendorRows.map((row) => [
        row.id,
        {
          guestMarkup: row.guestMarkup !== null && row.guestMarkup !== undefined ? Number(row.guestMarkup) : 0.55,
          memberMarkup: row.memberMarkup !== null && row.memberMarkup !== undefined ? Number(row.memberMarkup) : 0.4
        }
      ])
    );
    const categoryMap = new Map(categoryRows.map((row) => [row.id, row.name]));
    const pricingProfileByProductId = new Map(
      pricingProfileRows.map((row) => [Number(row.productId), row])
    );
    const packageMetaByPackageId = new Map(
      packageMetaRows.map((row) => [Number(row.packageId), row])
    );

    const productPayload = productRows.map((row) => {
      const productPackages = packagesByProduct[row.id] || [];
      const visiblePackages = productPackages.filter((pkg) => pkg.visible === 1 || pkg.visible === null);
      const priceCandidates = visiblePackages
        .map((pkg) => Number(pkg.price))
        .filter((value) => Number.isFinite(value));
      const productReviews = reviewsByProduct[row.id] || [];
      const avgRating = productReviews.length
        ? productReviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) /
          productReviews.length
        : 0;
      const localLineSaleMeta = localLineSalesByProduct[row.id];
      const localSaleMeta = salesByProduct[row.id];
      const shouldUseLocalSaleOverride =
        Boolean(localSaleMeta) &&
        (!localLineSaleMeta?.hasEntries ||
          toTimestamp(localSaleMeta.updatedAt) > toTimestamp(localLineSaleMeta.lastSyncedAt));
      const saleMeta = shouldUseLocalSaleOverride
        ? localSaleMeta
        : (localLineSaleMeta?.hasEntries ? localLineSaleMeta : localSaleMeta);
      const pricingSnapshot = computeProductPricingSnapshot({
        product: row,
        packages: productPackages,
        packageMetaByPackageId,
        vendor: vendorRowMap.get(row.vendorId) || null,
        profile: pricingProfileByProductId.get(row.id) || null
      });
      const hasResolvedPricingProfile =
        (Boolean(pricingProfileByProductId.get(row.id)) ||
          Boolean(pricingSnapshot.profile.usesNoMarkupPricing)) &&
        Number.isFinite(Number(pricingSnapshot.profile.sourceUnitPrice));
      const basePrice = hasResolvedPricingProfile
        ? pricingSnapshot.basePrice
        : (priceCandidates.length ? Math.min(...priceCandidates) : null);
      const markups = vendorMarkupMap.get(row.vendorId) || { guestMarkup: 0.55, memberMarkup: 0.4 };
      const localLinePricing = localLinePriceCacheByProduct[row.id]?.byPriceListId || {};
      const guestPriceFromLocalLine =
        Number.isFinite(guestPriceListId) && Number.isFinite(localLinePricing[guestPriceListId])
          ? Number(localLinePricing[guestPriceListId].toFixed(2))
          : null;
      const memberPriceFromLocalLine = memberPriceListIds
        .map((id) => localLinePricing[id])
        .find((value) => Number.isFinite(value));
      const guestPrice = hasResolvedPricingProfile
        ? pricingSnapshot.guestPrice
        : (
            guestPriceFromLocalLine ??
            (basePrice !== null ? Number((basePrice * (1 + markups.guestMarkup)).toFixed(2)) : null)
          );
      const memberPrice = hasResolvedPricingProfile
        ? pricingSnapshot.memberPrice
        : (
            (Number.isFinite(memberPriceFromLocalLine)
              ? Number(memberPriceFromLocalLine.toFixed(2))
              : null) ??
            (basePrice !== null ? Number((basePrice * (1 + markups.memberMarkup)).toFixed(2)) : null)
          );
      const effectiveSaleMeta = hasResolvedPricingProfile
        ? {
            onSale: Boolean(pricingSnapshot.profile.onSale),
            saleDiscount: pricingSnapshot.profile.saleDiscount
          }
        : saleMeta;

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        categoryId: row.categoryId,
        category: categoryMap.get(row.categoryId) || null,
        vendorId: row.vendorId,
        vendor: vendorMap.get(row.vendorId) || null,
        basePrice: basePrice !== null ? Number(basePrice.toFixed(2)) : null,
        guestPrice,
        memberPrice,
        vendorGuestMarkup: markups.guestMarkup,
        vendorMemberMarkup: markups.memberMarkup,
        packages: productPackages,
        images:
          imageObjectsByProduct[row.id] ||
          mediaObjectsByProduct[row.id] ||
          (imagesByProduct[row.id] || []).map((url) => ({ url, thumbnailUrl: url })),
        imageUrl:
          (imageObjectsByProduct[row.id] || [])
            .map((item) => item.url)
            .find(Boolean) ||
          (mediaObjectsByProduct[row.id] || [])
            .map((item) => item.url)
            .find(Boolean) ||
          row.thumbnailUrl ||
          null,
        thumbnailUrl:
          (imageObjectsByProduct[row.id] || [])
            .map((item) => item.thumbnailUrl)
            .find(Boolean) ||
          (mediaObjectsByProduct[row.id] || [])
            .map((item) => item.thumbnailUrl)
            .find(Boolean) ||
          row.thumbnailUrl ||
          null,
        featured: featuredSet.has(row.id),
        onSale: effectiveSaleMeta ? Boolean(effectiveSaleMeta.onSale) : saleSet.has(row.id),
        saleDiscount: effectiveSaleMeta ? effectiveSaleMeta.saleDiscount : null,
        rating: avgRating ? Math.round(avgRating * 10) / 10 : 0,
        reviews: productReviews
      };
    });

    const recipeRows = await db.select().from(recipes).where(eq(recipes.published, 1));
    const recipePayload = recipeRows.map((row) => ({
      id: row.id,
      title: row.title,
      note: row.note,
      imageUrl: row.imageUrl,
      ingredients: row.ingredientsJson ? JSON.parse(row.ingredientsJson) : [],
      steps: row.stepsJson ? JSON.parse(row.stepsJson) : []
    }));

    const dropSiteRows = await db.select().from(dropSites).where(eq(dropSites.active, 1));

    res.json({
      categories: categoryRows,
      vendors: vendorRows,
      dropSites: dropSiteRows,
      products: productPayload,
      recipes: recipePayload
    });
  } catch (err) {
    console.error("Catalog error:", err);
    res.status(500).json({
      error: "Catalog error",
      message: process.env.NODE_ENV === "development" ? err?.message : undefined
    });
  }
});

router.get("/drop-sites", async (_req, res) => {
  try {
    const db = getDb();
    try {
      await ensureLocalLineSyncSchema();
    } catch (error) {
      console.warn("Local Line schema bootstrap skipped for /drop-sites:", error.message);
    }
    const dropSiteRows = await db.select().from(dropSites).where(eq(dropSites.active, 1));
    res.json({ dropSites: dropSiteRows });
  } catch (error) {
    console.error("Drop sites error:", error);
    res.status(500).json({ error: "Failed to load drop sites" });
  }
});

router.get("/marketing/utm-format", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host") || ""}`;
  res.json(buildMarketingTagSpec(baseUrl));
});

async function handleMarketingTrack(req, res) {
  try {
    const db = getDb();
    await ensureMarketingSchema().catch((error) => {
      console.warn("Marketing schema bootstrap skipped for /marketing/track:", error.message);
    });

    const payload = req.method === "GET" ? req.query : (req.body || {});
    const pageUrl = cleanOptionalUrl(payload.pageUrl || payload.url);
    const referrerUrl = cleanOptionalUrl(payload.referrerUrl || req.get("referer"));
    const queryString = String(payload.queryString || "").trim();
    const inlineParams = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) {
        for (const item of value) inlineParams.append(key, String(item));
      } else if (value !== null && typeof value !== "undefined") {
        inlineParams.set(key, String(value));
      }
    }
    const searchParams = buildMergedSearchParams(queryString, inlineParams.toString());
    const derivedSource = deriveSourceFromUrl(
      pageUrl,
      payload.sourceHost,
      payload.sourcePath
    );
    const marketingParams = extractMarketingParams(payload, searchParams);
    const attribution = await resolveMarketingAttribution(db, marketingParams);
    const now = new Date();
    const sessionToken =
      marketingParams.csaTrackToken || crypto.randomBytes(16).toString("hex");
    const sessionRow = await upsertMarketingSession(db, {
      sessionToken,
      campaignId:
        attribution.campaignRow?.id ??
        attribution.sessionRow?.campaignId ??
        attribution.linkRow?.campaignId ??
        null,
      utmLinkId:
        attribution.linkRow?.id ??
        attribution.sessionRow?.utmLinkId ??
        null,
      sourceHost: derivedSource.sourceHost,
      sourcePath: derivedSource.sourcePath,
      landingUrl: pageUrl,
      referrerUrl,
      utmSource: marketingParams.utmSource,
      utmMedium: marketingParams.utmMedium,
      utmCampaign: marketingParams.utmCampaign,
      utmContent: marketingParams.utmContent,
      utmTerm: marketingParams.utmTerm,
      messageFocus:
        marketingParams.messageFocus ??
        attribution.linkRow?.messageFocus ??
        attribution.campaignRow?.messageFocus ??
        null,
      targetCity:
        marketingParams.targetCity ??
        attribution.linkRow?.targetCity ??
        attribution.campaignRow?.targetCity ??
        null,
      targetZip:
        marketingParams.targetZip ??
        attribution.linkRow?.targetZip ??
        attribution.campaignRow?.targetZip ??
        null,
      targetLocationLabel:
        marketingParams.targetLocationLabel ??
        attribution.linkRow?.targetLocationLabel ??
        attribution.campaignRow?.targetLocationLabel ??
        null,
      targetDropSiteId:
        marketingParams.targetDropSiteId ??
        attribution.linkRow?.targetDropSiteId ??
        attribution.campaignRow?.targetDropSiteId ??
        null,
      clientIp: cleanOptionalString(req.ip, 255),
      userAgent: cleanOptionalString(req.get("user-agent"), 1024),
      now
    });

    await db.insert(marketingClickEvents).values({
      sessionId: sessionRow?.id ?? null,
      campaignId:
        attribution.campaignRow?.id ??
        sessionRow?.campaignId ??
        attribution.linkRow?.campaignId ??
        null,
      utmLinkId:
        attribution.linkRow?.id ??
        sessionRow?.utmLinkId ??
        null,
      contentPostId: attribution.linkRow?.contentPostId ?? null,
      eventType: cleanOptionalString(payload.eventType, 32) || "page_view",
      pageUrl,
      referrerUrl,
      destinationUrl: cleanOptionalUrl(payload.destinationUrl),
      sourceHost: derivedSource.sourceHost,
      sourcePath: derivedSource.sourcePath,
      utmSource: marketingParams.utmSource,
      utmMedium: marketingParams.utmMedium,
      utmCampaign: marketingParams.utmCampaign,
      utmContent: marketingParams.utmContent,
      utmTerm: marketingParams.utmTerm,
      messageFocus:
        marketingParams.messageFocus ??
        attribution.linkRow?.messageFocus ??
        attribution.campaignRow?.messageFocus ??
        null,
      targetCity:
        marketingParams.targetCity ??
        attribution.linkRow?.targetCity ??
        attribution.campaignRow?.targetCity ??
        null,
      targetZip:
        marketingParams.targetZip ??
        attribution.linkRow?.targetZip ??
        attribution.campaignRow?.targetZip ??
        null,
      targetLocationLabel:
        marketingParams.targetLocationLabel ??
        attribution.linkRow?.targetLocationLabel ??
        attribution.campaignRow?.targetLocationLabel ??
        null,
      targetDropSiteId:
        marketingParams.targetDropSiteId ??
        attribution.linkRow?.targetDropSiteId ??
        attribution.campaignRow?.targetDropSiteId ??
        null,
      occurredAt: now,
      createdAt: now
    });

    res.json({
      ok: true,
      sessionToken,
      campaignSlug: attribution.campaignRow?.slug || null,
      linkSlug: attribution.linkRow?.slug || marketingParams.csaLinkSlug || null
    });
  } catch (error) {
    console.error("Marketing track failed:", error);
    res.status(500).json({ error: "Failed to record marketing event." });
  }
}

router.get("/marketing/track", handleMarketingTrack);
router.post("/marketing/track", handleMarketingTrack);

router.get("/marketing/go/:slug", async (req, res) => {
  try {
    const db = getDb();
    await ensureMarketingSchema().catch((error) => {
      console.warn("Marketing schema bootstrap skipped for /marketing/go:", error.message);
    });

    const slug = cleanString(req.params.slug);
    if (!slug) {
      return res.status(400).json({ error: "Missing link slug." });
    }

    const linkRows = await db
      .select()
      .from(marketingUtmLinks)
      .where(eq(marketingUtmLinks.slug, slug));
    const linkRow = linkRows[0] || null;
    if (!linkRow || Number(linkRow.isActive || 0) !== 1) {
      return res.status(404).json({ error: "Tracked link not found." });
    }

    const campaignRow = linkRow.campaignId
      ? await loadMarketingCampaignById(db, linkRow.campaignId)
      : null;
    const destination = new URL(String(linkRow.destinationUrl));
    for (const [key, value] of Object.entries(req.query || {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          destination.searchParams.append(key, String(item));
        }
      } else if (typeof value !== "undefined") {
        destination.searchParams.set(key, String(value));
      }
    }

    if (linkRow.utmSource) destination.searchParams.set("utm_source", String(linkRow.utmSource));
    if (linkRow.utmMedium) destination.searchParams.set("utm_medium", String(linkRow.utmMedium));
    if (linkRow.utmCampaign) destination.searchParams.set("utm_campaign", String(linkRow.utmCampaign));
    if (linkRow.utmContent) destination.searchParams.set("utm_content", String(linkRow.utmContent));
    if (linkRow.utmTerm) destination.searchParams.set("utm_term", String(linkRow.utmTerm));

    const sessionToken =
      cleanOptionalString(
        req.query?.csa_track ||
          req.query?.csaTrackToken ||
          req.query?.sessionToken,
        64
      ) || crypto.randomBytes(16).toString("hex");
    destination.searchParams.set("csa_track", sessionToken);
    destination.searchParams.set("csa_link", String(linkRow.slug));
    if (campaignRow?.slug) destination.searchParams.set("csa_campaign", String(campaignRow.slug));
    if (linkRow.messageFocus) {
      destination.searchParams.set("csa_message_focus", String(linkRow.messageFocus));
    } else if (campaignRow?.messageFocus) {
      destination.searchParams.set("csa_message_focus", String(campaignRow.messageFocus));
    }
    if (linkRow.targetCity) destination.searchParams.set("csa_target_city", String(linkRow.targetCity));
    if (linkRow.targetZip) destination.searchParams.set("csa_target_zip", String(linkRow.targetZip));
    if (linkRow.targetLocationLabel) {
      destination.searchParams.set("csa_target_location", String(linkRow.targetLocationLabel));
    }
    if (
      linkRow.targetDropSiteId !== null &&
      typeof linkRow.targetDropSiteId !== "undefined" &&
      String(linkRow.targetDropSiteId).trim() !== ""
    ) {
      destination.searchParams.set("csa_target_drop_site", String(linkRow.targetDropSiteId));
    }

    const sourceHost = cleanOptionalString(req.get("host"), 255);
    const sourcePath = cleanOptionalString(req.originalUrl?.split("?")[0], 255);
    const now = new Date();
    const sessionRow = await upsertMarketingSession(db, {
      sessionToken,
      campaignId: campaignRow?.id ?? linkRow.campaignId ?? null,
      utmLinkId: linkRow.id,
      sourceHost,
      sourcePath,
      landingUrl: cleanOptionalUrl(`${req.protocol}://${req.get("host")}${req.originalUrl}`),
      referrerUrl: cleanOptionalUrl(req.get("referer")),
      utmSource: cleanOptionalString(linkRow.utmSource, 255),
      utmMedium: cleanOptionalString(linkRow.utmMedium, 255),
      utmCampaign: cleanOptionalString(linkRow.utmCampaign, 255),
      utmContent: cleanOptionalString(linkRow.utmContent, 255),
      utmTerm: cleanOptionalString(linkRow.utmTerm, 255),
      messageFocus: linkRow.messageFocus || campaignRow?.messageFocus || null,
      targetCity: linkRow.targetCity || campaignRow?.targetCity || null,
      targetZip: linkRow.targetZip || campaignRow?.targetZip || null,
      targetLocationLabel: linkRow.targetLocationLabel || campaignRow?.targetLocationLabel || null,
      targetDropSiteId: linkRow.targetDropSiteId || campaignRow?.targetDropSiteId || null,
      clientIp: cleanOptionalString(req.ip, 255),
      userAgent: cleanOptionalString(req.get("user-agent"), 1024),
      now
    });

    await db.insert(marketingClickEvents).values({
      sessionId: sessionRow?.id ?? null,
      campaignId: campaignRow?.id ?? linkRow.campaignId ?? null,
      utmLinkId: linkRow.id,
      contentPostId: linkRow.contentPostId ?? null,
      eventType: "click",
      pageUrl: cleanOptionalUrl(`${req.protocol}://${req.get("host")}${req.originalUrl}`),
      referrerUrl: cleanOptionalUrl(req.get("referer")),
      destinationUrl: cleanOptionalUrl(destination.toString()),
      sourceHost,
      sourcePath,
      utmSource: cleanOptionalString(linkRow.utmSource, 255),
      utmMedium: cleanOptionalString(linkRow.utmMedium, 255),
      utmCampaign: cleanOptionalString(linkRow.utmCampaign, 255),
      utmContent: cleanOptionalString(linkRow.utmContent, 255),
      utmTerm: cleanOptionalString(linkRow.utmTerm, 255),
      messageFocus: linkRow.messageFocus || campaignRow?.messageFocus || null,
      targetCity: linkRow.targetCity || campaignRow?.targetCity || null,
      targetZip: linkRow.targetZip || campaignRow?.targetZip || null,
      targetLocationLabel: linkRow.targetLocationLabel || campaignRow?.targetLocationLabel || null,
      targetDropSiteId: linkRow.targetDropSiteId || campaignRow?.targetDropSiteId || null,
      occurredAt: now,
      createdAt: now
    });

    res.redirect(destination.toString());
  } catch (error) {
    console.error("Marketing redirect failed:", error);
    res.status(500).json({ error: "Unable to resolve tracked marketing link." });
  }
});

router.post("/subscribe/address-insights", async (req, res) => {
  try {
    const db = getDb();
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /subscribe/address-insights:", error.message);
    });

    const payload = req.body || {};
    const addressLine1 = cleanString(payload.addressLine1);
    const city = cleanString(payload.city);
    const stateProvince = cleanString(payload.stateProvince);
    const postalCode = cleanString(payload.postalCode, 32);

    if (!addressLine1 || !city || !stateProvince || !postalCode) {
      return res.status(400).json({
        error: "Address, city, state, and zip are required to validate the location."
      });
    }

    const insights = await resolveSubscriptionAddressInsights(db, payload);
    res.json({ ok: true, insights });
  } catch (error) {
    console.error("Subscribe address insights failed:", error);
    res.status(500).json({ error: error?.message || "Unable to validate address." });
  }
});

async function createPortalMemberFromSubscribeLead({
  db,
  subscribeLeadId,
  firstName,
  lastName,
  email,
  phone,
  country,
  addressLine1,
  addressLine2,
  city,
  stateProvince,
  postalCode,
  password,
  addressInsights,
  referralSource,
  selectedPlan,
  selectedDropSite,
  notes,
  sourceHost,
  sourcePath,
  signerName,
  liabilityAgreementRecordUrl,
  liabilityAgreementSignedAt,
  desiredBillingDayOfMonth
}) {
  const existingUserRows = await db.select().from(users).where(eq(users.username, email)).limit(1);
  if (existingUserRows.length) {
    const error = new Error("An account already exists for this email. Please log in instead.");
    error.status = 409;
    throw error;
  }

  const plan = getPlanDefinition(selectedPlan);
  if (!plan) {
    const error = new Error("Choose a valid membership plan.");
    error.status = 400;
    throw error;
  }

  const settings = await loadSubscriptionSettings(db);
  const now = new Date();
  const passwordHash = await bcrypt.hash(String(password || ""), 10);
  const userInsert = await db.insert(users).values({
    username: email,
    email,
    passwordHash,
    role: "member",
    name: `${firstName} ${lastName}`.trim(),
    active: 1,
    createdAt: now,
    updatedAt: now
  });
  const userId = Number(userInsert[0]?.insertId);

  await db.insert(memberProfiles).values({
    userId,
    subscribeLeadId,
    firstName,
    lastName,
    phone,
    country: cleanOptionalString(country, 128),
    addressLine1,
    addressLine2: cleanOptionalString(addressLine2, 255),
    city,
    stateProvince,
    postalCode,
    geocodedLatitude: addressInsights?.geocodedLatitude ?? null,
    geocodedLongitude: addressInsights?.geocodedLongitude ?? null,
    geocodedDisplayName: cleanOptionalString(addressInsights?.geocodedDisplayName, 1024),
    preferredDropSite: cleanOptionalString(selectedDropSite, 255),
    insideHomeDeliveryArea:
      typeof addressInsights?.insideHomeDeliveryArea === "boolean"
        ? addressInsights.insideHomeDeliveryArea
          ? 1
          : 0
        : null,
    closestDropSite: cleanOptionalString(addressInsights?.closestDropSite, 255),
    closestDropSiteAddress: cleanOptionalString(addressInsights?.closestDropSiteAddress, 1024),
    closestDropSiteDistanceMiles: addressInsights?.closestDropSiteDistanceMiles ?? null,
    referralSource: cleanOptionalText(referralSource),
    notes: cleanOptionalText(notes),
    sourceHost: cleanOptionalString(sourceHost, 255),
    sourcePath: cleanOptionalString(sourcePath, 255),
    createdAt: now,
    updatedAt: now
  });

  const nextBillingDate = computeNextBillingDate(desiredBillingDayOfMonth, now);
  await db.insert(memberSubscriptions).values({
    userId,
    subscribeLeadId,
    planKey: plan.key,
    planAmountCents: plan.amountCents,
    billingDayOfMonth: desiredBillingDayOfMonth,
    status: "pending_payment_method",
    nextBillingDate,
    createdAt: now,
    updatedAt: now
  });

  await db.insert(memberHerdshareStatuses).values({
    userId,
    monthlyFeeCents: Number(settings.herdshareMonthlyFeeCents || 500),
    status: "active",
    nextBillingDate,
    agreementAccepted: 1,
    agreementSignerName: cleanOptionalString(signerName, 255),
    agreementDocumentUrl: LIABILITY_AGREEMENT_URL,
    agreementRecordUrl: liabilityAgreementRecordUrl,
    signedAt: liabilityAgreementSignedAt,
    createdAt: now,
    updatedAt: now
  });

  await ensureMemberLedgerAccounts(userId, db);

  return {
    userId,
    token: issueUserToken({ userId, role: "member", adminRoles: [] }),
    user: {
      id: userId,
      username: email,
      email,
      role: "member",
      adminRoles: []
    }
  };
}

router.post("/subscribe", async (req, res) => {
  try {
    const db = getDb();
    const portalOnboardingEnabled = isSubscribePortalOnboardingEnabled();
    await ensureSubscriberCaptureSchema().catch((error) => {
      console.warn("Subscriber capture schema bootstrap skipped for /subscribe:", error.message);
    });
    await ensureMarketingSchema().catch((error) => {
      console.warn("Marketing schema bootstrap skipped for /subscribe:", error.message);
    });
    if (portalOnboardingEnabled) {
      await ensureSubscriptionPortalSchema().catch((error) => {
        console.warn("Subscription portal schema bootstrap skipped for /subscribe:", error.message);
      });
    }

    const payload = req.body || {};
    const firstName = cleanString(payload.firstName);
    const lastName = cleanString(payload.lastName);
    const email = cleanString(payload.email);
    const phone = cleanString(payload.phone, 64);
    const addressLine1 = cleanString(payload.addressLine1);
    const city = cleanString(payload.city);
    const stateProvince = cleanString(payload.stateProvince);
    const postalCode = cleanString(payload.postalCode, 32);
    const signerName = cleanString(
      payload.liabilityAgreementSignerName || `${firstName} ${lastName}`.trim()
    );
    const password = String(payload.password || "");
    const hasSubmittedBillingDay =
      payload.billingDayOfMonth !== null &&
      typeof payload.billingDayOfMonth !== "undefined" &&
      String(payload.billingDayOfMonth).trim() !== "";
    const desiredBillingDayOfMonth =
      portalOnboardingEnabled || hasSubmittedBillingDay
        ? normalizeBillingDay(payload.billingDayOfMonth, 1)
        : null;
    const submittedPlanKey = cleanString(payload.selectedPlan, 64);
    const selectedPlan = normalizePlanKey(submittedPlanKey);
    const agreementAccepted = Boolean(payload.liabilityAgreementAccepted);
    const signatureMode =
      String(payload.liabilityAgreementSignatureMode || "typed").trim().toLowerCase() === "draw"
        ? "draw"
        : "typed";
    const signature = parseSignatureDataUrl(payload.liabilityAgreementSignatureDataUrl);

    if (!firstName || !lastName || !email || !phone || !addressLine1 || !city || !stateProvince || !postalCode) {
      res
        .status(400)
        .json({ error: "First name, last name, email, phone, address, city, state, and zip are required." });
      return;
    }

    if (!submittedPlanKey) {
      return res.status(400).json({ error: "Select a membership plan." });
    }

    if (portalOnboardingEnabled && !selectedPlan) {
      return res.status(400).json({ error: "Select a valid membership plan." });
    }

    if (portalOnboardingEnabled && (!password || password.length < 8)) {
      return res.status(400).json({ error: "Create a password with at least 8 characters." });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    if (!agreementAccepted) {
      res.status(400).json({ error: "You must agree to the product liability agreement." });
      return;
    }

    if (!signerName) {
      res.status(400).json({ error: "Enter the signer name for the liability agreement." });
      return;
    }

    if (signatureMode === "draw" && !signature) {
      res.status(400).json({ error: "Please provide a drawn signature for the liability agreement." });
      return;
    }

    const now = new Date();
    const searchParams = new URLSearchParams(String(payload.queryString || ""));
    const marketingParams = extractMarketingParams(payload, searchParams);
    const sourceHostHeader = cleanOptionalString(
      req.get("x-forwarded-host") || req.get("host") || payload.sourceHost,
      255
    );
    const sourcePath = cleanOptionalString(payload.sourcePath, 255);
    const attribution = await resolveMarketingAttribution(db, marketingParams);
    let addressInsights = null;
    try {
      addressInsights = await resolveSubscriptionAddressInsights(db, payload);
    } catch (addressError) {
      console.warn("Subscribe lead address insights skipped:", addressError.message);
    }
    const liabilityAgreementRecordUrl = await uploadSignedAgreementRecord({
      signerName,
      email,
      submittedAt: now,
      sourceHost: sourceHostHeader,
      sourcePath,
      signatureBuffer: signature?.buffer || null,
      signatureMode
    });

    const subscribeInsert = await db.insert(subscribeLeads).values({
      status: "in_progress",
      firstName,
      lastName,
      email,
      phone,
      country: cleanOptionalString(payload.country, 128),
      addressLine1,
      addressLine2: cleanOptionalString(payload.addressLine2, 255),
      city,
      stateProvince,
      postalCode,
      geocodedLatitude: addressInsights?.geocodedLatitude ?? null,
      geocodedLongitude: addressInsights?.geocodedLongitude ?? null,
      geocodedDisplayName: cleanOptionalString(addressInsights?.geocodedDisplayName, 1024),
      closestDropSite: cleanOptionalString(addressInsights?.closestDropSite, 255),
      closestDropSiteAddress: cleanOptionalString(addressInsights?.closestDropSiteAddress, 1024),
      closestDropSiteDistanceMiles: addressInsights?.closestDropSiteDistanceMiles ?? null,
      insideHomeDeliveryArea:
        typeof addressInsights?.insideHomeDeliveryArea === "boolean"
          ? addressInsights.insideHomeDeliveryArea
            ? 1
            : 0
          : null,
      addressValidatedAt: addressInsights ? now : null,
      referralSource: cleanOptionalText(payload.referralSource),
      selectedPlan: cleanOptionalString(payload.selectedPlan, 64),
      selectedPlanLabel: cleanOptionalString(payload.selectedPlanLabel, 255),
      desiredBillingDayOfMonth,
      selectedDropSite: cleanOptionalString(payload.selectedDropSite, 255),
      notes: cleanOptionalText(payload.notes),
      liabilityAgreementAccepted: 1,
      liabilityAgreementSignerName: cleanOptionalString(signerName, 255),
      liabilityAgreementDocumentUrl: LIABILITY_AGREEMENT_URL,
      liabilityAgreementRecordUrl: liabilityAgreementRecordUrl,
      liabilityAgreementSignedAt: now,
      sourceHost: sourceHostHeader,
      sourcePath,
      utmSource: marketingParams.utmSource,
      utmMedium: marketingParams.utmMedium,
      utmCampaign: marketingParams.utmCampaign,
      utmContent: marketingParams.utmContent,
      utmTerm: marketingParams.utmTerm,
      csaTrackToken: marketingParams.csaTrackToken,
      csaLinkSlug: marketingParams.csaLinkSlug,
      csaCampaignSlug: marketingParams.csaCampaignSlug,
      messageFocus:
        marketingParams.messageFocus ??
        attribution.linkRow?.messageFocus ??
        attribution.campaignRow?.messageFocus ??
        null,
      targetCity:
        marketingParams.targetCity ??
        attribution.linkRow?.targetCity ??
        attribution.campaignRow?.targetCity ??
        null,
      targetZip:
        marketingParams.targetZip ??
        attribution.linkRow?.targetZip ??
        attribution.campaignRow?.targetZip ??
        null,
      targetLocationLabel:
        marketingParams.targetLocationLabel ??
        attribution.linkRow?.targetLocationLabel ??
        attribution.campaignRow?.targetLocationLabel ??
        null,
      targetDropSiteId:
        marketingParams.targetDropSiteId ??
        attribution.linkRow?.targetDropSiteId ??
        attribution.campaignRow?.targetDropSiteId ??
        null,
      rawJson: JSON.stringify(payload),
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const subscribeLeadId = Number(subscribeInsert[0]?.insertId);
    let activation = null;
    if (portalOnboardingEnabled) {
      activation = await createPortalMemberFromSubscribeLead({
        db,
        subscribeLeadId,
        password,
        firstName,
        lastName,
        email,
        phone,
        country: payload.country,
        addressLine1,
        addressLine2: payload.addressLine2,
        city,
        stateProvince,
        postalCode,
        addressInsights,
        referralSource: payload.referralSource,
        selectedPlan,
        selectedDropSite: payload.selectedDropSite,
        notes: payload.notes,
        sourceHost: sourceHostHeader,
        sourcePath,
        signerName,
        liabilityAgreementRecordUrl,
        liabilityAgreementSignedAt: now,
        desiredBillingDayOfMonth
      });

      await db
        .update(subscribeLeads)
        .set({
          memberUserId: activation.userId,
          activationCompletedAt: now,
          updatedAt: now
        })
        .where(eq(subscribeLeads.id, subscribeLeadId));
    }

    const shouldRecordSubscriberEvent = Boolean(
      subscribeLeadId > 0 &&
        (
          marketingParams.utmSource ||
          marketingParams.utmMedium ||
          marketingParams.utmCampaign ||
          marketingParams.csaTrackToken ||
          marketingParams.csaLinkSlug ||
          marketingParams.csaCampaignSlug ||
          attribution.linkRow ||
          attribution.campaignRow
        )
    );

    if (shouldRecordSubscriberEvent) {
      await db.insert(marketingSubscriberEvents).values({
        subscribeLeadId,
        campaignId: attribution.campaignRow?.id ?? attribution.sessionRow?.campaignId ?? null,
        utmLinkId: attribution.linkRow?.id ?? attribution.sessionRow?.utmLinkId ?? null,
        sessionId: attribution.sessionRow?.id ?? null,
        matchMethod: attribution.matchMethod || "direct_utm",
        email,
        firstName,
        lastName,
        city,
        postalCode,
        selectedDropSite: cleanOptionalString(payload.selectedDropSite, 255),
        subscribedAt: now,
        sourceHost: sourceHostHeader,
        sourcePath,
        utmSource: marketingParams.utmSource,
        utmMedium: marketingParams.utmMedium,
        utmCampaign: marketingParams.utmCampaign,
        utmContent: marketingParams.utmContent,
        utmTerm: marketingParams.utmTerm,
        csaTrackToken: marketingParams.csaTrackToken,
        csaLinkSlug: marketingParams.csaLinkSlug,
        csaCampaignSlug: marketingParams.csaCampaignSlug,
        messageFocus:
          marketingParams.messageFocus ??
          attribution.linkRow?.messageFocus ??
          attribution.campaignRow?.messageFocus ??
          null,
        targetCity:
          marketingParams.targetCity ??
          attribution.linkRow?.targetCity ??
          attribution.campaignRow?.targetCity ??
          null,
        targetZip:
          marketingParams.targetZip ??
          attribution.linkRow?.targetZip ??
          attribution.campaignRow?.targetZip ??
          null,
        targetLocationLabel:
          marketingParams.targetLocationLabel ??
          attribution.linkRow?.targetLocationLabel ??
          attribution.campaignRow?.targetLocationLabel ??
          null,
        targetDropSiteId:
          marketingParams.targetDropSiteId ??
          attribution.linkRow?.targetDropSiteId ??
          attribution.campaignRow?.targetDropSiteId ??
          null,
        createdAt: now,
        updatedAt: now
      });
    }

    void sendSubscribeLeadNotification({
      submittedAt: now,
      lead: {
        firstName,
        lastName,
        email,
        phone,
        country: payload.country,
        addressLine1,
        addressLine2: payload.addressLine2,
        city,
        stateProvince,
        postalCode,
        selectedPlan: payload.selectedPlan,
        selectedPlanLabel: payload.selectedPlanLabel,
        desiredBillingDayOfMonth,
        selectedDropSite: payload.selectedDropSite,
        referralSource: payload.referralSource,
        notes: payload.notes,
        liabilityAgreementSignerName: signerName,
        liabilityAgreementRecordUrl,
        sourceHost: sourceHostHeader,
        sourcePath
      },
      marketing: {
        ...marketingParams,
        matchMethod: attribution.matchMethod || null
      }
    }).catch((error) => {
      console.warn("Subscribe lead notification skipped:", error.message);
    });

    res.json({
      ok: true,
      liabilityAgreementRecordUrl,
      addressInsights,
      token: activation?.token,
      user: activation?.user,
      memberCreated: Boolean(activation)
    });
  } catch (error) {
    console.error("Subscribe lead capture error:", error);
    res.status(error?.status || 500).json({ error: error?.message || "Unable to submit subscribe request." });
  }
});

router.post("/reviews", requireUser, async (req, res) => {
  try {
    const payload = req.body || {};
    const productId = Number(payload.productId);
    const rating = Number(payload.rating);
    const title = typeof payload.title === "string" ? payload.title.trim() : null;
    const body = typeof payload.body === "string" ? payload.body.trim() : null;

    if (!Number.isFinite(productId) || !Number.isFinite(rating)) {
      return res.status(400).json({ error: "Missing product or rating" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const db = getDb();
    const existing = await db.select().from(products).where(eq(products.id, productId));
    if (!existing.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    const existingReview = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.productId, productId), eq(reviews.userId, req.user.userId)));

    if (existingReview.length) {
      return res.status(409).json({
        error: "Review already exists for this product",
        reviewId: existingReview[0].id
      });
    }

    await db.insert(reviews).values({
      productId,
      userId: req.user.userId,
      rating,
      title,
      body,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Review submit error:", err);
    res.status(500).json({ error: "Unable to submit review" });
  }
});

router.get("/reviews/mine", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const base = productId
      ? and(eq(reviews.userId, req.user.userId), eq(reviews.productId, productId))
      : eq(reviews.userId, req.user.userId);
    const rows = await db.select().from(reviews).where(base);
    res.json({ reviews: rows });
  } catch (err) {
    console.error("Review fetch error:", err);
    res.status(500).json({ error: "Unable to load reviews" });
  }
});

router.put("/reviews/:id", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const payload = req.body || {};

    const existing = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.userId, req.user.userId)));

    if (!existing.length) {
      return res.status(404).json({ error: "Review not found" });
    }

    await db
      .update(reviews)
      .set({
        rating: payload.rating ?? undefined,
        title: payload.title ?? undefined,
        body: payload.body ?? undefined,
        status: "pending",
        updatedAt: new Date()
      })
      .where(eq(reviews.id, id));

    res.json({ ok: true });
  } catch (err) {
    console.error("Review update error:", err);
    res.status(500).json({ error: "Unable to update review" });
  }
});

router.delete("/reviews/:id", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.userId, req.user.userId)));
    if (!existing.length) {
      return res.status(404).json({ error: "Review not found" });
    }
    await db.delete(reviews).where(eq(reviews.id, id));
    res.json({ ok: true });
  } catch (err) {
    console.error("Review delete error:", err);
    res.status(500).json({ error: "Unable to delete review" });
  }
});

export default router;
