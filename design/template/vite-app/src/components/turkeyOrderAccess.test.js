import assert from 'node:assert/strict';
import test from 'node:test';
import { readOrderAccess, rememberOrderAccess } from './turkeyOrderAccess.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const token = 'a'.repeat(64);
test('a new tab can recover only the matching order, within seven days', () => {
  const browser = { sessionStorage: memoryStorage(), localStorage: memoryStorage() };
  assert.equal(rememberOrderAccess('order-one', token, browser, 1000), true);
  assert.equal(readOrderAccess('order-one', browser, 2000), token);
  browser.sessionStorage = memoryStorage();
  assert.equal(readOrderAccess('order-one', browser, 2000), token);
  assert.equal(readOrderAccess('another-order', browser, 2000), null);
  assert.equal(readOrderAccess('order-one', browser, 1000 + 7 * 86400000), null);
  assert.equal(browser.localStorage.getItem('turkeyOrder:order-one'), null);
});
test('existing session tokens work and browser storage failures are handled', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const browser = { sessionStorage: memoryStorage(), localStorage: blocked };
  browser.sessionStorage.setItem('turkeyOrder:legacy', JSON.stringify(token));
  assert.equal(readOrderAccess('legacy', browser), token);
  assert.equal(rememberOrderAccess('new', token, browser), true);
  assert.equal(rememberOrderAccess('local-only', token, { sessionStorage: blocked, localStorage: memoryStorage() }), true);
  assert.equal(rememberOrderAccess('blocked', token, { sessionStorage: blocked, localStorage: blocked }), false);
  assert.equal(readOrderAccess('blocked', { sessionStorage: blocked, localStorage: blocked }), null);
});
test('malformed and unscoped browser values cannot be used as order access tokens', () => {
  const browser = { sessionStorage: memoryStorage(), localStorage: memoryStorage() };
  assert.equal(rememberOrderAccess('bad', 'not-an-access-token', browser), false);
  browser.sessionStorage.setItem('turkeyOrder:bad', '{');
  browser.localStorage.setItem('turkeyOrder:bad', JSON.stringify({ token, expiresAt: 'never' }));
  assert.equal(readOrderAccess('bad', browser), null);
  assert.equal(readOrderAccess('', browser), null);
});
