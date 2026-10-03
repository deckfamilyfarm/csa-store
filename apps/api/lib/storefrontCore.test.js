import assert from 'node:assert/strict';
import test from 'node:test';
import { integer, recordId, normalizeCheckout, tokenHash, checkoutReturnOrigin, parsePacificInput, pacificInput, validatePublish, csvCell } from './storefrontCore.js';
import { hasAdminPermission } from './adminRoles.js';

const customer = { name: 'Turkey Buyer', email: 'buyer@example.com', phone: '541-555-0100', addressLine1: '123 Main St', city: 'Eugene', state: 'OR', postalCode: '97401' };
test('Stripe returns to the same trusted storefront origin without accepting open redirects', () => {
  const store = 'https://store.deckfamilyfarm.com';
  const turkeys = 'https://turkeys.deckfamilyfarm.com';
  assert.equal(checkoutReturnOrigin(store, turkeys), turkeys);
  assert.equal(checkoutReturnOrigin(turkeys, store), store);
  assert.equal(checkoutReturnOrigin(store), store);
  assert.equal(checkoutReturnOrigin('http://localhost:5176', 'http://localhost:5176'), 'http://localhost:5176');
  assert.equal(checkoutReturnOrigin('https://staging.example.com', 'https://staging.example.com'), 'https://staging.example.com');
  for (const origin of ['null', 'https://evil.example', 'https://store.deckfamilyfarm.com.evil.example', 'https://evil.example@store.deckfamilyfarm.com', 'https://store.deckfamilyfarm.com/evil', 'http://store.deckfamilyfarm.com']) {
    assert.throws(() => checkoutReturnOrigin(store, origin), /store website/);
  }
  for (const configured of ['not a URL', 'http://evil.example', 'ftp://localhost', 'https://user:password@example.com']) {
    assert.throws(() => checkoutReturnOrigin(configured), error => error.status === 503);
  }
});
test('record IDs support the database range without relaxing inventory or quantity limits', () => {
  for (const value of [1, 1000001, '2000000001', 2147483647]) assert.equal(recordId(value, 'Catalog product'), Number(value));
  for (const value of [0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, null, '', true, [], {}]) assert.throws(() => recordId(value, 'Catalog product'), /whole number/);
  assert.throws(() => integer(1000001, 'Pre-order inventory'), /whole number/);
  const request = { customer, pickupId: 2000000001, items: [{ optionId: 1000001, quantity: 1 }] };
  assert.equal(normalizeCheckout(request).pickupId, 2000000001);
  assert.deepEqual(normalizeCheckout(request).items, [{ optionId: 1000001, quantity: 1 }]);
  assert.throws(() => normalizeCheckout({ ...request, items: [{ optionId: 1000001, quantity: 1001 }] }), /Quantity/);
});
test('checkout validates contact data and quantities and ignores client prices', () => {
  const body = { customer, pickupId: 1, items: [{ optionId: 2, quantity: 1, priceCents: 1 }], totalCents: 1 };
  const result = normalizeCheckout(body);
  assert.deepEqual(result.items, [{ optionId: 2, quantity: 1 }]);
  assert.equal(result.customer.country, 'US');
  assert.equal(result.totalCents, undefined);
  for (const quantity of [0,-1,1.5,1001,null,'',true,[],{}]) assert.throws(() => normalizeCheckout({ ...body, items: [{ optionId: 2, quantity }] }));
  assert.throws(() => normalizeCheckout({ ...body, items: [body.items[0], body.items[0]] }), /once/);
  assert.throws(() => normalizeCheckout({ ...body, customer: { ...customer, email: 'bad' } }), /email/);
  assert.throws(() => normalizeCheckout({ ...body, customer: { ...customer, phone: '123' } }), /phone/);
});
test('guest order tokens require 256 bits and are hashed', () => {
  const token = 'ab'.repeat(32);
  assert.equal(tokenHash(token).length, 64);
  assert.notEqual(tokenHash(token), token);
  for (const invalid of ['', '123', null, 'x'.repeat(64)]) assert.throws(() => tokenHash(invalid));
});
test('Pacific cutoff conversion handles November standard time and summer daylight time', () => {
  assert.equal(new Date(parsePacificInput('2026-11-20T17:00')).toISOString(), '2026-11-21T01:00:00.000Z');
  assert.equal(new Date(parsePacificInput('2026-10-20T17:00')).toISOString(), '2026-10-21T00:00:00.000Z');
  assert.equal(pacificInput(parsePacificInput('2026-11-20T17:00')), '2026-11-20T17:00');
  assert.throws(() => parsePacificInput('2026-03-08T02:30'), /does not exist/);
});
test('publishing requires real prices, pickup details and a future cutoff', () => {
  const sale = { title: 'Turkeys', description: 'Farm turkeys', contact_email: 'farm@example.com', notify_email: 'staff@example.com', pickup_date: '2026-11-21', closes_ms: parsePacificInput('2026-11-20T17:00') };
  const options = [{ active: 1, label: 'Small', price_cents: 10000, on_hand: 0 }];
  const groups = [{ id: 1, active: 1, name: 'Portland' }];
  const pickups = [{ group_id: 1, active: 1, name: 'Market', address: 'Market address', hours: '9 AM–1 PM', instructions: 'Farm booth' }];
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.doesNotThrow(() => validatePublish(sale, options, pickups, now, groups));
  assert.doesNotThrow(() => validatePublish(sale, options, Array(8).fill(pickups[0]), now, groups));
  assert.throws(() => validatePublish(sale, [{ ...options[0], price_cents: 0 }], pickups, now, groups), /Price/);
  assert.throws(() => validatePublish(sale, [], pickups, now, groups), /size/);
  assert.throws(() => validatePublish(sale, options, [], now, groups), /at least one active location/);
  assert.throws(() => validatePublish(sale, options, pickups, now, []), /active pickup group/);
  assert.throws(() => validatePublish(sale, options, [{ ...pickups[0], hours: '' }], now, groups), /every active pickup/);
  assert.throws(() => validatePublish({ ...sale, closes_ms: now - 1 }, options, pickups, now, groups), /cutoff/);
});
test('storefront grants do not imply Local Line inventory or pricing grants', () => {
  assert.equal(hasAdminPermission(['storefront_admin'], 'storefront_admin'), true);
  assert.equal(hasAdminPermission(['admin'], 'storefront_admin'), true);
  for (const roles of [[], ['inventory_admin'], ['pricing_admin'], ['localline_push']]) assert.equal(hasAdminPermission(roles, 'storefront_admin'), false);
  assert.equal(hasAdminPermission(['storefront_admin'], 'localline_push'), false);
});
test('pickup CSV escapes formulas and quoted customer values', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('Jane "J" Doe'), '"Jane ""J"" Doe"');
});
