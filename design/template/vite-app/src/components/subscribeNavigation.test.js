import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubscribeNavLinks } from './subscribeNavigation.js';

test('Shop links to turkeys from both shared subscribe and dropsite navigation', () => {
  for (const origin of ['http://localhost:5176', 'http://127.0.0.1:5176', 'https://subscribe.deckfamilyfarm.com', 'https://dropsites.deckfamilyfarm.com']) {
    globalThis.window = { location: new URL(origin) };
    try {
      const shop = buildSubscribeNavLinks().find(link => link.label === 'Shop');
      assert.ok(shop.children.some(link => link.label === 'CSA Shopping'));
      const turkey = shop.children.find(link => link.label === 'Turkeys');
      assert.equal(turkey.href, origin.startsWith('http:') ? `${origin}/turkeys` : 'https://turkeys.deckfamilyfarm.com/');
    } finally { delete globalThis.window; }
  }
});
