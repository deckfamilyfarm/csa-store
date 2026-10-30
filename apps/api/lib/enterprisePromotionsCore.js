import { validateActiveLocalLinePriceListIds, isRetiredLocalLineList, enrolledLocalLineLists } from "./localLinePricingLists.js";
import { roundRatio } from "./enterprisePricingEngine.js";

const fail = message => { throw new Error(message); };
// A null end is intentional: only an explicit cancellation ends this sale.
export const promotionEndTime = input => input.endAt == null || input.endAt === '' ? Infinity :
  Number.isFinite(Date.parse(input.endAt)) ? Date.parse(input.endAt) : -Infinity;
export const promotionIsActive = (input, now = Date.now()) => Date.parse(input.startAt) <= now && now < promotionEndTime(input);
const positiveIds = (values, label) => {
  if (!Array.isArray(values) || !values.length) fail(`Select ${label}.`);
  const result = [...new Set(values.map(Number))];
  if (result.some(value => !Number.isSafeInteger(value) || value <= 0)) fail(`Invalid ${label}.`);
  return result;
};

export function normalizePromotion(input) {
  if (!input || typeof input !== "object") fail("Promotion details are required.");
  const discountBp = Number(input.discountBp);
  if (!Number.isSafeInteger(discountBp) || discountBp <= 0 || discountBp >= 10000) fail("Sale percentage must be between 0% and 100%.");
  const start = new Date(input.startAt), end = input.endAt == null || input.endAt === '' ? null : new Date(input.endAt);
  if (!input.startAt || !Number.isFinite(start.getTime())) fail("Enter a valid sale start.");
  if (end && (!Number.isFinite(end.getTime()) || end <= start)) fail("Sale end must follow its start.");
  const channels = [...new Set(input.channels || [])];
  if (!channels.length || channels.some(value => !["localline", "square"].includes(value))) fail("Select Local Line, Square, or both.");
  const packageIds = positiveIds(input.packageIds, "one or more packages");
  const squareLocationIds = channels.includes("square") ? [...new Set((input.squareLocationIds || []).map(String).filter(Boolean))] : [];
  if (channels.includes("square") && !squareLocationIds.length) fail("Select the Square locations for this promotion.");
  const timezone = String(input.timezone || "America/Los_Angeles");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
  catch { fail("Promotion timezone is invalid."); }
  return { name: String(input.name || "").trim().slice(0, 255), description: String(input.description || "").trim().slice(0, 2000),
    discountBp, startAt: start.toISOString(), endAt: end?.toISOString() ?? null, timezone, packageIds, channels, squareLocationIds };
}

export function promotionPrices(regularPackages, discountBp) {
  return regularPackages.map(pkg => {
    if (!Number.isSafeInteger(pkg.localLineRegularCents) || pkg.localLineRegularCents < 0) fail("A package has no approved regular Local Line price.");
    const saleCents = roundRatio(BigInt(pkg.localLineRegularCents) * BigInt(10000 - discountBp), 10000n);
    return { packageId: Number(pkg.packageId), regularCents: pkg.localLineRegularCents, saleCents,
      baskets: Object.fromEntries(["guest", "herdShare", "snap"].map(key => [key, saleCents])) };
  });
}

export function promotionsOverlap(left, right) {
  return Date.parse(left.startAt) < promotionEndTime(right) && Date.parse(right.startAt) < promotionEndTime(left) &&
    left.packageIds.some(value => right.packageIds.includes(value)) &&
    left.channels.some(value => right.channels.includes(value));
}

// A sale changes the three active basket entries for a reviewed package. Keep
// the regular unit price so the Local Line sale display can cross it out.
export function localLineSalePatch(remote, selectedPackages, priceListIds, saleActive) {
  if (!remote || !Array.isArray(remote.packages)) fail("Refresh the Local Line product before publishing a sale.");
  const lists = [...new Set(priceListIds.map(Number))];
  validateActiveLocalLinePriceListIds(priceListIds.map(Number));
  const wanted = new Map(selectedPackages.map(pkg => [Number(pkg.localLinePackageId), pkg]));
  const packages = remote.packages.map(pkg => {
    if (!wanted.has(Number(pkg.id))) {
      if (!Number.isFinite(Number(pkg.unit_price)) || Number(pkg.unit_price) < 0 || !pkg.price_list_entries?.length) {
        fail(`${pkg.name || pkg.id}: unchanged Local Line package pricing is incomplete. Review it before publishing a partial-package sale.`);
      }
      return {
        id: Number(pkg.id), name: pkg.name,
        unit_price: Number(pkg.unit_price),
        ...(pkg.inventory_per_unit == null ? {} : { inventory_per_unit: Number(pkg.inventory_per_unit) }),
        ...(pkg.package_code == null ? {} : { package_code: pkg.package_code }),
        price_list_entries: pkg.price_list_entries.filter(entry => !isRetiredLocalLineList(entry.price_list_id ?? entry.price_list)).map(entry => {
          const priceListId = Number(entry.price_list_id ?? entry.price_list);
          const entryId = Number(entry.product_price_list_entry ?? entry.id);
          const type = Number(entry.adjustment_type), value = Number(entry.adjustment_value);
          if (![1, 2, 3].includes(type) || ![priceListId, entryId, value].every(Number.isFinite)) {
            fail(`${pkg.name || pkg.id}: unchanged Local Line basket pricing is incomplete. Review it before publishing a partial-package sale.`);
          }
          return {
          adjustment: Boolean(entry.adjustment), adjustment_type: Number(entry.adjustment_type),
          adjustment_value: value,
          price_list: priceListId,
          product_price_list_entry: entryId,
          on_sale_toggle: Boolean(entry.on_sale_toggle ?? entry.on_sale),
          strikethrough_display_value: entry.strikethrough_display_value == null ? null : Number(entry.strikethrough_display_value),
          max_units_per_order: entry.max_units_per_order ?? null
        }; })
      };
    }
    const selected = wanted.get(Number(pkg.id));
    const entries = enrolledLocalLineLists(pkg, lists).map(listId => {
      const row = (pkg.price_list_entries || []).find(entry => Number(entry.price_list_id ?? entry.price_list) === listId);
      const entryId = Number(row?.product_price_list_entry ?? row?.id);
      if (!Number.isSafeInteger(entryId) || entryId <= 0) fail(`${pkg.name || pkg.id} needs a valid mapping for each enrolled Local Line basket.`);
      const amount = (saleActive ? selected.saleCents : selected.regularCents) / 100;
      return { adjustment: true, adjustment_type: 3, adjustment_value: amount,
        price_list: listId, product_price_list_entry: entryId,
        on_sale_toggle: Boolean(saleActive), strikethrough_display_value: saleActive ? selected.regularCents / 100 : null,
        max_units_per_order: row?.max_units_per_order ?? null };
    });
    return { id: Number(pkg.id), name: pkg.name, unit_price: selected.regularCents / 100,
      price_list_entries: entries };
  });
  if (remote.packages.filter(pkg => wanted.has(Number(pkg.id))).length !== wanted.size) fail("A Local Line package mapping changed. Review the sale again.");
  return { vendor: Number(remote.vendor?.id ?? remote.vendor), packages };
}

export function localLineSaleMatches(remote, selectedPackages, priceListIds, saleActive) {
  const desired = localLineSalePatch(remote, selectedPackages, priceListIds, saleActive);
  const selectedIds = new Set(selectedPackages.map(pkg => Number(pkg.localLinePackageId)));
  return desired.packages.filter(pkg => selectedIds.has(pkg.id)).every(pkg => {
    const current = remote.packages.find(row => Number(row.id) === pkg.id);
    return pkg.price_list_entries.every(entry => {
      const live = current.price_list_entries.find(row => Number(row.price_list_id ?? row.price_list) === entry.price_list);
      return Number(live.adjustment_type) === 3 &&
        Math.round(Number(live.adjustment_value) * 100) === Math.round(entry.adjustment_value * 100) &&
        Boolean(live.on_sale_toggle ?? live.on_sale) === Boolean(entry.on_sale_toggle);
    });
  });
}

function localWallTime(value, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

export function buildSquarePromotionCatalogObjects(promotionId, promotion, variationIds) {
  if (!promotion.channels.includes("square")) fail("Square is not a selected channel.");
  const variations = [...new Set(variationIds.map(String).filter(Boolean))];
  if (variations.length !== promotion.packageIds.length) fail("Each selected package needs an approved Square variation mapping.");
  if (variations.length > 5000) fail("A Square product set supports at most 5,000 variations.");
  const locations = promotion.squareLocationIds;
  const id = String(promotionId);
  const discountId = `#csa-promo-${id}-discount`, setId = `#csa-promo-${id}-set`;
  const ruleId = `#csa-promo-${id}-rule`;
  const common = { present_at_all_locations: false, present_at_location_ids: locations };
  const start = localWallTime(promotion.startAt, promotion.timezone);
  const end = promotion.endAt == null ? null : localWallTime(promotion.endAt, promotion.timezone);
  return [
    { type: "DISCOUNT", id: discountId, ...common, discount_data: { name: `CSA ${id}: ${promotion.name || "Sale"}`, discount_type: "FIXED_PERCENTAGE", percentage: (promotion.discountBp / 100).toFixed(2) } },
    { type: "PRODUCT_SET", id: setId, ...common, product_set_data: { product_ids_any: variations } },
    // Native validity bounds support an optional end. No invented expiry or
    // unsupported iCalendar DTEND; previously frozen requests remain unchanged.
    { type: "PRICING_RULE", id: ruleId, ...common, pricing_rule_data: { name: `CSA ${id}: ${promotion.name || "Sale"}`,
      valid_from_date: start.date, valid_from_local_time: start.time,
      ...(end ? { valid_until_date: end.date, valid_until_local_time: end.time } : {}),
      discount_id: discountId, match_products_id: setId, application_mode: "AUTOMATIC" } }
  ];
}
