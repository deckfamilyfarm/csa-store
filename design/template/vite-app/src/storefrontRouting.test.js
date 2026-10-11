import assert from 'node:assert/strict';
import test from 'node:test';
import { usesAdminPortal, usesTurkeyStorefront } from './storefrontRouting.js';

test('the admin host and local entry points open the staff portal', () => {
  for (const url of [
    'https://admin.deckfamilyfarm.com/',
    'https://admin.deckfamilyfarm.com/#/admin',
    'https://admin.deckfamilyfarm.com/#/home',
    'https://admin.deckfamilyfarm.com/#/turkeys',
    'https://admin.deckfamilyfarm.com/?experience=subscribe',
    'http://localhost:5176/admin',
    'http://localhost:5176/admin/',
    'http://localhost:5176/?experience=admin',
    'http://127.0.0.1:5176/?experience=admin#/admin?adminToken=launch'
  ]) {
    assert.equal(usesAdminPortal(url), true, url);
    assert.equal(usesTurkeyStorefront(url), false, url);
  }
});

test('admin routing preserves public sites, legacy admin links and password recovery', () => {
  for (const url of [
    'https://store.deckfamilyfarm.com/',
    'https://store.deckfamilyfarm.com/#/admin',
    'https://subscribe.deckfamilyfarm.com/',
    'https://dropsites.deckfamilyfarm.com/',
    'https://turkeys.deckfamilyfarm.com/',
    'http://localhost:5176/',
    'http://localhost:5176/administrator',
    'https://admin.deckfamilyfarm.com.evil.example/',
    'https://admin.deckfamilyfarm.com/#/reset-password?token=reset',
    'http://localhost:5176/admin#/reset-password?token=reset'
  ]) assert.equal(usesAdminPortal(url), false, url);
});

test('turkeys have a dedicated host and local path; the main store keeps its landing page', () => {
  for (const url of ['https://turkeys.deckfamilyfarm.com/', 'https://turkeys.deckfamilyfarm.com/#/turkeys?order=123', 'http://localhost:5176/turkeys', 'http://localhost:5176/?experience=turkeys', 'http://localhost:5176/#/turkeys?order=123', 'https://store.deckfamilyfarm.com/#/turkeys']) assert.equal(usesTurkeyStorefront(url), true, url);
  for (const url of ['https://store.deckfamilyfarm.com/', 'https://store.deckfamilyfarm.com/#/home', 'http://localhost:5176/', 'http://127.0.0.1:5176/', 'https://subscribe.deckfamilyfarm.com/', 'https://dropsites.deckfamilyfarm.com/', 'https://fullfarmcsa.deckfamilyfarm.com/', 'http://localhost:5173/', 'https://turkeys.deckfamilyfarm.com/?experience=store&storePreview=1#/home']) assert.equal(usesTurkeyStorefront(url), false, url);
});
test('admin, accounts, password resets, liability and subscription routes stay available', () => {
  for (const host of ['https://store.deckfamilyfarm.com', 'https://turkeys.deckfamilyfarm.com', 'http://localhost:5176']) {
    for (const path of ['/#/admin', '/#/account', '/#/reset-password?token=abc', '/#/subscribe', '/#/dropsites', '/#/liability/farm-visit', '/liability/farm-visit', '/subscribe', '/dropsites', '/?experience=subscribe']) assert.equal(usesTurkeyStorefront(`${host}${path}`), false, path);
  }
});

test('turkey detail and cart routes work on local, turkey, and legacy store URLs', () => {
  for (const host of ['https://store.deckfamilyfarm.com','https://turkeys.deckfamilyfarm.com','http://localhost:5176']) {
    for (const route of ['product','cart']) assert.equal(usesTurkeyStorefront(`${host}/#/turkeys/${route}?preview=1`), true);
  }
});
