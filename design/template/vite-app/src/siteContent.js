export function buildSiteContentLookup(rows = []) {
  const lookup = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const page = String(row?.page || "").trim();
    const section = String(row?.section || "").trim();
    const field = String(row?.field || "").trim();
    if (!page || !section || !field) continue;
    lookup[`${page}.${section}.${field}`] = String(row?.value ?? "");
  }
  return lookup;
}

export function getSiteContentValue(lookup, page, section, field, fallback = "") {
  const key = `${page}.${section}.${field}`;
  if (!lookup || !Object.prototype.hasOwnProperty.call(lookup, key)) {
    return fallback;
  }
  return lookup[key];
}
