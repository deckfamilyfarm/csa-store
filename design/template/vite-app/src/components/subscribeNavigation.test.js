import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubscribeNavLinks } from './subscribeNavigation.js';

test('all shared menus link to merchandise, turkeys, subscribe and dropsites on their hosts', () => {
  for (const origin of ['http://localhost:5176', 'http://127.0.0.1:5176', 'https://store.deckfamilyfarm.com', 'https://subscribe.deckfamilyfarm.com', 'https://dropsites.deckfamilyfarm.com', 'https://turkeys.deckfamilyfarm.com', 'https://merchandise.deckfamilyfarm.com']) {
    globalThis.window = { location: new URL(origin) };
    try {
      const links = buildSubscribeNavLinks().flatMap(link => link.children || [link]);
      assert.equal(links.find(link => link.label === 'CSA Shopping').href, 'https://fullfarmcsa.deckfamilyfarm.com/');
      for (const [label, route] of [['Turkeys', 'turkeys'], ['Merchandise', 'merchandise'], ['Subscribe', 'subscribe'], ['Become a Drop Site Host', 'dropsites']]) {
        assert.equal(links.find(link => link.label === label).href,
          origin.startsWith('http:') ? `${origin}/${route}` : `https://${route}.deckfamilyfarm.com/`);
      }
    } finally { delete globalThis.window; }
  }
});
