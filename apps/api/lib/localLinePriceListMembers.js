import { getPool } from "../db.js";
import {
  getLocalLineAccessToken,
  getLocalLineBaseUrl,
  isLocalLineAuthConfigured
} from "../localLineAuth.js";

const DEFAULT_PAGE_SIZE = 250;
const MUTATION_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.LOCAL_LINE_PRICE_LIST_MEMBER_MUTATION_DELAY_MS || "0", 10) || 0
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInteger(value) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCustomerId(value) {
  const id = parseInteger(value);
  return id && id > 0 ? id : null;
}

function getMemberCustomerId(member = {}) {
  return normalizeCustomerId(
    member.customer_id ??
      member.customerId ??
      member.customer?.id ??
      member.customer
  );
}

function getMemberId(member = {}) {
  return parseInteger(member.id);
}

function compactErrorPayload(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch (_error) {
    return String(value).slice(0, 500);
  }
}

function buildLocalLineUrl(pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(value)) return value;
  return `${getLocalLineBaseUrl()}${value.replace(/^\/+/, "")}`;
}

async function requestLocalLineJson(pathOrUrl, accessToken, {
  method = "GET",
  body = null,
  label = "Local Line request"
} = {}) {
  const response = await fetch(buildLocalLineUrl(pathOrUrl), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${compactErrorPayload(payload)}`);
  }
  return payload;
}

async function fetchAllLocalLineResults(path, accessToken, label) {
  const rows = [];
  let nextUrl = path;

  while (nextUrl) {
    const payload = await requestLocalLineJson(nextUrl, accessToken, { label });
    if (Array.isArray(payload?.results)) {
      rows.push(...payload.results);
      nextUrl = payload.next || null;
      continue;
    }
    if (Array.isArray(payload)) {
      rows.push(...payload);
    }
    break;
  }

  return rows;
}

export function getConfiguredHerdSharePriceListId() {
  return parseInteger(process.env.LL_PRICE_LIST_HERDSHARE_ID);
}

export function isHerdSharePriceListConfigured() {
  return Boolean(getConfiguredHerdSharePriceListId());
}

export async function fetchLocalLinePriceList(priceListId, accessToken = null) {
  const token = accessToken || await getLocalLineAccessToken();
  return requestLocalLineJson(
    `price-lists/${encodeURIComponent(priceListId)}/`,
    token,
    { label: `Local Line price list ${priceListId}` }
  );
}

export async function fetchLocalLinePriceListMembers(priceListId, accessToken = null) {
  const token = accessToken || await getLocalLineAccessToken();
  return fetchAllLocalLineResults(
    `price-lists/${encodeURIComponent(priceListId)}/members/?page_size=${DEFAULT_PAGE_SIZE}`,
    token,
    `Local Line price list ${priceListId} members`
  );
}

async function fetchLocalLinePriceLists(accessToken) {
  return fetchAllLocalLineResults(
    `price-lists/?page_size=${DEFAULT_PAGE_SIZE}`,
    accessToken,
    "Local Line price lists"
  );
}

async function putPriceListMemberDefault({
  accessToken,
  priceListId,
  memberId,
  customerId,
  dryRun
}) {
  if (dryRun) return null;
  const result = await requestLocalLineJson(
    `price-lists/${encodeURIComponent(priceListId)}/members/${encodeURIComponent(memberId)}/`,
    accessToken,
    {
      method: "PUT",
      body: {
        customer_id: customerId,
        is_customer_default_price_list: true
      },
      label: `Local Line price list ${priceListId} member ${memberId} default update`
    }
  );
  if (MUTATION_DELAY_MS > 0) await sleep(MUTATION_DELAY_MS);
  return result;
}

async function postPriceListMember({
  accessToken,
  priceListId,
  customerId,
  dryRun
}) {
  if (dryRun) return null;
  const result = await requestLocalLineJson(
    `price-lists/${encodeURIComponent(priceListId)}/members/`,
    accessToken,
    {
      method: "POST",
      body: {
        customer_id: customerId,
        is_customer_default_price_list: true
      },
      label: `Local Line price list ${priceListId} member create`
    }
  );
  if (MUTATION_DELAY_MS > 0) await sleep(MUTATION_DELAY_MS);
  return result;
}

async function deletePriceListMember({
  accessToken,
  priceListId,
  memberId,
  dryRun
}) {
  if (dryRun) return null;
  const result = await requestLocalLineJson(
    `price-lists/${encodeURIComponent(priceListId)}/members/${encodeURIComponent(memberId)}/`,
    accessToken,
    {
      method: "DELETE",
      label: `Local Line price list ${priceListId} member ${memberId} delete`
    }
  );
  if (MUTATION_DELAY_MS > 0) await sleep(MUTATION_DELAY_MS);
  return result;
}

function summarizeOverlap(priceList, members, herdShareCustomerIds) {
  const overlaps = members
    .map((member) => ({
      priceListId: Number(priceList.id),
      priceListName: priceList.name || null,
      memberId: getMemberId(member),
      customerId: getMemberCustomerId(member),
      isDefault: Boolean(member.is_customer_default_price_list)
    }))
    .filter((row) => row.memberId && row.customerId && herdShareCustomerIds.has(row.customerId));

  return {
    priceListId: Number(priceList.id),
    priceListName: priceList.name || null,
    active: Boolean(priceList.active),
    memberCount: Number(priceList.members_count || members.length || 0),
    overlaps
  };
}

function dedupeCustomerIds(rows) {
  return Array.from(
    new Set(rows.map((row) => normalizeCustomerId(row)).filter(Boolean))
  );
}

async function fetchOtherPriceListOverlaps({
  accessToken,
  herdSharePriceListId,
  herdShareCustomerIds
}) {
  const priceLists = await fetchLocalLinePriceLists(accessToken);
  const otherPriceLists = priceLists
    .filter((priceList) => Number(priceList?.id) !== Number(herdSharePriceListId))
    .filter((priceList) => Number(priceList?.id));
  const overlapsByPriceList = [];

  for (const priceList of otherPriceLists) {
    const memberCount = Number(priceList.members_count || 0);
    if (memberCount <= 0) {
      overlapsByPriceList.push({
        priceListId: Number(priceList.id),
        priceListName: priceList.name || null,
        active: Boolean(priceList.active),
        memberCount,
        overlaps: []
      });
      continue;
    }

    const members = await fetchLocalLinePriceListMembers(priceList.id, accessToken);
    overlapsByPriceList.push(summarizeOverlap(priceList, members, herdShareCustomerIds));
  }

  return overlapsByPriceList;
}

function buildErrorSummary(error, context = {}) {
  return {
    ...context,
    error: error?.message || String(error)
  };
}

export async function enforceHerdSharePriceListMembers({
  herdSharePriceListId = getConfiguredHerdSharePriceListId(),
  dryRun = true,
  throwOnError = false
} = {}) {
  if (!isLocalLineAuthConfigured()) {
    throw new Error("Local Line auth is not configured.");
  }
  if (!herdSharePriceListId) {
    throw new Error("LL_PRICE_LIST_HERDSHARE_ID is not configured.");
  }

  const accessToken = await getLocalLineAccessToken();
  const [priceList, members] = await Promise.all([
    fetchLocalLinePriceList(herdSharePriceListId, accessToken),
    fetchLocalLinePriceListMembers(herdSharePriceListId, accessToken)
  ]);
  const memberRows = members
    .map((member) => ({
      memberId: getMemberId(member),
      customerId: getMemberCustomerId(member),
      isDefault: Boolean(member.is_customer_default_price_list)
    }))
    .filter((row) => row.memberId && row.customerId);
  const herdShareCustomerIds = new Set(memberRows.map((row) => row.customerId));
  const defaultUpdateCandidates = memberRows.filter((row) => !row.isDefault);
  const overlapsByPriceList = await fetchOtherPriceListOverlaps({
    accessToken,
    herdSharePriceListId,
    herdShareCustomerIds
  });
  const overlappingMemberships = overlapsByPriceList.flatMap((row) => row.overlaps);
  const errors = [];
  let herdShareDefaultsUpdated = 0;
  let otherPriceListMembershipsRemoved = 0;

  for (const row of defaultUpdateCandidates) {
    try {
      await putPriceListMemberDefault({
        accessToken,
        priceListId: herdSharePriceListId,
        memberId: row.memberId,
        customerId: row.customerId,
        dryRun
      });
      if (!dryRun) herdShareDefaultsUpdated += 1;
    } catch (error) {
      errors.push(buildErrorSummary(error, {
        action: "set-herd-share-default",
        priceListId: Number(herdSharePriceListId),
        memberId: row.memberId,
        customerId: row.customerId
      }));
      if (throwOnError) throw error;
    }
  }

  for (const row of overlappingMemberships) {
    try {
      await deletePriceListMember({
        accessToken,
        priceListId: row.priceListId,
        memberId: row.memberId,
        dryRun
      });
      if (!dryRun) otherPriceListMembershipsRemoved += 1;
    } catch (error) {
      errors.push(buildErrorSummary(error, {
        action: "remove-other-price-list",
        priceListId: row.priceListId,
        memberId: row.memberId,
        customerId: row.customerId
      }));
      if (throwOnError) throw error;
    }
  }

  if (throwOnError && errors.length) {
    throw new Error(`Herd-share price-list enforcement failed for ${errors.length} membership changes.`);
  }

  return {
    dryRun,
    herdSharePriceList: {
      id: Number(priceList.id || herdSharePriceListId),
      name: priceList.name || null,
      active: Boolean(priceList.active),
      membersCount: Number(priceList.members_count || members.length || 0)
    },
    herdShareMemberRows: members.length,
    uniqueHerdShareCustomers: herdShareCustomerIds.size,
    duplicateHerdShareMemberRows: Math.max(0, memberRows.length - herdShareCustomerIds.size),
    herdShareDefaultsAlreadySelected: memberRows.length - defaultUpdateCandidates.length,
    herdShareDefaultsNeedingUpdate: defaultUpdateCandidates.length,
    herdShareDefaultsUpdated,
    otherPriceListMembershipsFound: overlappingMemberships.length,
    otherPriceListMembershipsRemoved,
    overlapsByPriceList: overlapsByPriceList
      .filter((row) => row.overlaps.length)
      .map((row) => ({
        priceListId: row.priceListId,
        priceListName: row.priceListName,
        active: row.active,
        memberCount: row.memberCount,
        overlapCount: row.overlaps.length
      })),
    errors
  };
}

async function loadLinkedHerdShareCustomerIds() {
  const [rows] = await getPool().query(
    `
      SELECT DISTINCT link.external_customer_id AS externalCustomerId
      FROM member_herdshare_statuses herdshare
      JOIN member_external_account_links link
        ON link.user_id = herdshare.user_id
       AND link.provider = 'localline'
      WHERE COALESCE(NULLIF(TRIM(herdshare.status), ''), 'active') IN ('active', 'paused')
        AND link.external_customer_id IS NOT NULL
        AND TRIM(link.external_customer_id) <> ''
    `
  );
  return dedupeCustomerIds(rows.map((row) => row.externalCustomerId));
}

export async function enforceLinkedHerdShareCustomerPriceListDefaults({
  herdSharePriceListId = getConfiguredHerdSharePriceListId(),
  dryRun = false,
  removeOtherPriceLists = false,
  throwOnError = true
} = {}) {
  if (!isLocalLineAuthConfigured()) {
    throw new Error("Local Line auth is not configured.");
  }
  if (!herdSharePriceListId) {
    throw new Error("LL_PRICE_LIST_HERDSHARE_ID is not configured.");
  }

  const customerIds = await loadLinkedHerdShareCustomerIds();
  if (!customerIds.length) {
    return {
      dryRun,
      herdSharePriceListId: Number(herdSharePriceListId),
      linkedHerdShareCustomers: 0,
      missingMemberships: 0,
      createdMemberships: 0,
      defaultsNeedingUpdate: 0,
      defaultsUpdated: 0,
      otherPriceListMembershipsFound: 0,
      otherPriceListMembershipsRemoved: 0,
      errors: []
    };
  }

  const accessToken = await getLocalLineAccessToken();
  const members = await fetchLocalLinePriceListMembers(herdSharePriceListId, accessToken);
  const memberByCustomerId = new Map();
  members.forEach((member) => {
    const customerId = getMemberCustomerId(member);
    const memberId = getMemberId(member);
    if (customerId && memberId && !memberByCustomerId.has(customerId)) {
      memberByCustomerId.set(customerId, {
        memberId,
        customerId,
        isDefault: Boolean(member.is_customer_default_price_list)
      });
    }
  });

  const missingCustomerIds = customerIds.filter((customerId) => !memberByCustomerId.has(customerId));
  const defaultUpdateCandidates = customerIds
    .map((customerId) => memberByCustomerId.get(customerId))
    .filter((row) => row && !row.isDefault);
  const errors = [];
  let createdMemberships = 0;
  let defaultsUpdated = 0;
  let otherPriceListMembershipsFound = 0;
  let otherPriceListMembershipsRemoved = 0;

  for (const customerId of missingCustomerIds) {
    try {
      await postPriceListMember({
        accessToken,
        priceListId: herdSharePriceListId,
        customerId,
        dryRun
      });
      if (!dryRun) createdMemberships += 1;
    } catch (error) {
      errors.push(buildErrorSummary(error, {
        action: "create-herd-share-membership",
        priceListId: Number(herdSharePriceListId),
        customerId
      }));
      if (throwOnError) throw error;
    }
  }

  for (const row of defaultUpdateCandidates) {
    try {
      await putPriceListMemberDefault({
        accessToken,
        priceListId: herdSharePriceListId,
        memberId: row.memberId,
        customerId: row.customerId,
        dryRun
      });
      if (!dryRun) defaultsUpdated += 1;
    } catch (error) {
      errors.push(buildErrorSummary(error, {
        action: "set-herd-share-default",
        priceListId: Number(herdSharePriceListId),
        memberId: row.memberId,
        customerId: row.customerId
      }));
      if (throwOnError) throw error;
    }
  }

  if (removeOtherPriceLists) {
    const targetCustomerIds = new Set(customerIds);
    const overlapsByPriceList = await fetchOtherPriceListOverlaps({
      accessToken,
      herdSharePriceListId,
      herdShareCustomerIds: targetCustomerIds
    });
    const overlappingMemberships = overlapsByPriceList.flatMap((row) => row.overlaps);
    otherPriceListMembershipsFound = overlappingMemberships.length;

    for (const row of overlappingMemberships) {
      try {
        await deletePriceListMember({
          accessToken,
          priceListId: row.priceListId,
          memberId: row.memberId,
          dryRun
        });
        if (!dryRun) otherPriceListMembershipsRemoved += 1;
      } catch (error) {
        errors.push(buildErrorSummary(error, {
          action: "remove-other-price-list",
          priceListId: row.priceListId,
          memberId: row.memberId,
          customerId: row.customerId
        }));
        if (throwOnError) throw error;
      }
    }
  }

  if (throwOnError && errors.length) {
    throw new Error(`Linked herd-share price-list enforcement failed for ${errors.length} membership changes.`);
  }

  return {
    dryRun,
    herdSharePriceListId: Number(herdSharePriceListId),
    linkedHerdShareCustomers: customerIds.length,
    missingMemberships: missingCustomerIds.length,
    createdMemberships,
    defaultsNeedingUpdate: defaultUpdateCandidates.length,
    defaultsUpdated,
    otherPriceListMembershipsFound,
    otherPriceListMembershipsRemoved,
    errors
  };
}
