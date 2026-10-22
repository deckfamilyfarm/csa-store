// Pricing timestamps stored in MySQL/JSON are UTC, including strings without a zone.
// Never reinterpret a persisted timestamp in the API host's local timezone.
export function pricingUtcDate(value, label) {
  let source = value;
  if (typeof value === "string") {
    source = value.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(source)) {
      source = source.replace(" ", "T") + "Z";
    }
  }
  const date = new Date(source);
  if (!value || !Number.isFinite(date.getTime())) {
    throw Object.assign(new Error(`${label} must be a valid date and time.`), { status: 400 });
  }
  return date.toISOString().slice(0, 19).replace("T", " ");
}
