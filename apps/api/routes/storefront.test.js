import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { storefrontAdminRouter, storefrontStripeWebhook } from './storefront.js';

test('storefront admin rejects unauthenticated requests and webhooks require a valid signature', async t => {
  const app = express();
  app.post('/webhook', express.raw({ type: 'application/json' }), storefrontStripeWebhook);
  app.use(express.json());
  app.use('/admin', storefrontAdminRouter);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, method] of [['settings','GET'],['settings','PUT'],['setup','GET'],['setup','PUT'],['orders','GET'],['orders/example/refund','POST'],['stock/1','POST']]) {
    const response = await fetch(`${base}/admin/${path}`, { method });
    assert.equal(response.status, 401);
  }
  const saved = { key: process.env.STRIPE_SECRET_KEY, secret: process.env.STOREFRONT_STRIPE_WEBHOOK_SECRET };
  t.after(() => {
    for (const [key, value] of [['STRIPE_SECRET_KEY',saved.key],['STOREFRONT_STRIPE_WEBHOOK_SECRET',saved.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STOREFRONT_STRIPE_WEBHOOK_SECRET;
  const payload = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"checkout.session.completed"}' };
  assert.equal((await fetch(`${base}/webhook`, payload)).status, 503);
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_signature_validation_only';
  process.env.STOREFRONT_STRIPE_WEBHOOK_SECRET = 'whsec_test_only';
  assert.equal((await fetch(`${base}/webhook`, payload)).status, 400);
  assert.equal((await fetch(`${base}/webhook`, { ...payload, headers: { ...payload.headers, 'stripe-signature': 'invalid' } })).status, 400);
});

test('product editors cannot change store visibility or authorize a staff preview', async t => {
  const app = express();
  app.use((req, _res, next) => { req.admin = { userId: 1, adminRoles: ['inventory_admin', 'local_pricelist_admin'] }; next(); });
  app.use('/admin', storefrontAdminRouter);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/settings`, { method });
    assert.equal(response.status, 403);
  }
});
