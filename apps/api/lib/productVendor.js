const invalid = message => Object.assign(new Error(message), { status: 400 });

export function requireVendorId(value) {
  const id = Number(value);
  if (!["string", "number"].includes(typeof value) || !Number.isSafeInteger(id) || id <= 0) {
    throw invalid("A vendor is required. Select a vendor in Product Details before saving or publishing.");
  }
  return id;
}

export function requireProductVendor(product, vendor) {
  const id = requireVendorId(product?.vendorId);
  if (Number(vendor?.id) !== id || !String(vendor?.name || "").trim()) {
    throw invalid("The assigned vendor is invalid. Select an existing vendor in Product Details before saving or publishing.");
  }
  return vendor;
}

export async function validateVendorAssignment(connection, vendorId) {
  const id = requireVendorId(vendorId);
  const [[vendor]] = await connection.query("SELECT id, name FROM vendors WHERE id = ? LIMIT 1", [id]);
  return requireProductVendor({ vendorId: id }, vendor);
}

export async function validateSavedProductVendor(connection, productId) {
  const [[product]] = await connection.query("SELECT id, vendor_id AS vendorId FROM products WHERE id = ? LIMIT 1", [productId]);
  if (!product) throw Object.assign(new Error("Product not found"), { status: 404 });
  return validateVendorAssignment(connection, product.vendorId);
}

const vendorName = value => String(value || "").trim().toLowerCase();

export function matchLocalLineVendor(product, vendor, remoteVendors) {
  requireProductVendor(product, vendor);
  const matches = remoteVendors.filter(row => Number(row.id) > 0 && vendorName(row.name) === vendorName(vendor.name));
  const match = matches.find(row => Number(row.id) === Number(vendor.id)) || (matches.length === 1 ? matches[0] : null);
  if (!match) throw invalid(`Vendor "${vendor.name}" has ${matches.length ? "multiple matches" : "no matching vendor"} in Local Line. Resolve the vendor there before publishing.`);
  return requireVendorId(match.id);
}

export function localLineVendorId(remote) {
  const value = remote?.vendor;
  const id = Number(value && typeof value === "object" ? value.id : value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function confirmLocalLineVendor(remote, expectedId) {
  if (localLineVendorId(remote) !== requireVendorId(expectedId)) {
    throw new Error("Local Line did not confirm the assigned vendor. Check the product's vendor in Local Line before retrying.");
  }
}
