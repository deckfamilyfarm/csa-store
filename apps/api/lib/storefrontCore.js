import crypto from 'node:crypto';

export const HOLD_MS = 30 * 60 * 1000;
export const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function integer(value, name, min = 0, max = 1000000) {
  if (!['number', 'string'].includes(typeof value) || !/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(`${name} must be a whole number between ${min} and ${max}.`);
  return Number(value);
}
// Record IDs use the MySQL signed INT range, independently of stock/quantity limits.
export function recordId(value, name) {
  return integer(value, name, 1, 2147483647);
}
export function text(value, name, max = 500, required = true) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > max) fail(`Enter a valid ${name} (up to ${max} characters).`);
  return result;
}
export function email(value, name = 'email') {
  const result = text(value, name, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(`Enter a valid ${name}.`);
  return result;
}
export function tokenHash(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) fail('Invalid order access token.', 401);
  return hash(token);
}
export function normalizeCheckout(body) {
  const customer = body.customer || {};
  const phone = text(customer.phone, 'phone', 40);
  if (phone.replace(/\D/g, '').length < 7) fail('Enter a valid phone number.');
  const result = {
    customer: {
      name: text(customer.name, 'name', 150), email: email(customer.email), phone,
      addressLine1: text(customer.addressLine1, 'street address', 200),
      addressLine2: text(customer.addressLine2, 'address line 2', 200, false),
      city: text(customer.city, 'city', 100), state: text(customer.state, 'state or province', 100),
      postalCode: text(customer.postalCode, 'postal code', 20), country: text(customer.country || 'US', 'country', 2)
    },
    pickupId: recordId(body.pickupId, 'Pickup location'),
    items: []
  };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) fail('Choose at least one turkey size.');
  const seen = new Set();
  result.items = body.items.map(item => {
    const optionId = recordId(item.optionId, 'Turkey size');
    if (seen.has(optionId)) fail('Each turkey size can appear only once.');
    seen.add(optionId);
    return { optionId, quantity: integer(item.quantity, 'Quantity', 1, 1000),
      ...(item.expectedPriceCents === undefined ? {} : { expectedPriceCents: integer(item.expectedPriceCents, 'Displayed retail price', 50, 10000000) }) };
  }).sort((a, b) => a.optionId - b.optionId);
  return result;
}
export function pacificInput(ms) {
  if (!ms) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(Number(ms))).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function parsePacificInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value))) fail('Enter a valid Pacific sales cutoff.');
  const wall = Date.parse(`${value}:00Z`);
  // Accept only wall times which round-trip; this rejects the spring DST gap.
  for (const offset of [7, 8]) {
    const candidate = wall + offset * 3600000;
    if (Number.isFinite(candidate) && pacificInput(candidate) === value) return candidate;
  }
  fail('That Pacific time does not exist. Choose another cutoff time.');
}
export function validatePublish(sale, options, pickups, now = Date.now(), groups = []) {
  if (!sale.title || !sale.description) fail('Add a title and description before publishing.');
  email(sale.contact_email, 'contact email'); email(sale.notify_email, 'notification email');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sale.pickup_date) || !Number.isFinite(Date.parse(`${sale.pickup_date}T12:00:00Z`))) fail('Enter a pickup date.');
  if (!(Number(sale.closes_ms) > now) || pacificInput(sale.closes_ms).slice(0, 10) >= sale.pickup_date) fail('Set a future sales cutoff before pickup day.');
  const active = options.filter(option => option.active);
  if (!active.length) fail('Add an active turkey size before publishing.');
  for (const option of active) {
    text(option.label, 'size label', 255);
    integer(option.price_cents, 'Price in cents', 50, 10000000);
    integer(option.on_hand, 'Stock');
  }
  const activeGroups = groups.filter(group => group.active);
  if (!activeGroups.length) fail('Add at least one active pickup group.');
  for (const group of activeGroups) {
    const locations = pickups.filter(pickup => pickup.group_id === group.id && pickup.active);
    if (!locations.length) fail('Each active pickup group needs at least one active location.');
    if (locations.some(p => !p.name || !p.address || !p.hours || !p.instructions)) fail('Complete the title, address, hours, and instructions for every active pickup location.');
  }
}
export function csvCell(value) {
  let result = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}
