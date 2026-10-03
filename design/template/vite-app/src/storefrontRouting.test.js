import assert from 'node:assert/strict';
import test from 'node:test';
import { usesTurkeyStorefront } from './storefrontRouting.js';

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
