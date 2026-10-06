import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { stripeKeyMode, stripeOrderMode, storefrontStripeClients, storefrontStripeError, storefrontWebhookEvent } from './storefrontStripe.js';

test('historical session IDs identify mode, while payment-intent IDs do not', () => {
  assert.equal(stripeOrderMode({ stripe_session_id: 'cs_test_old' }), 'test');
  assert.equal(stripeOrderMode({ stripe_session_id: 'cs_live_old' }), 'live');
  assert.equal(stripeOrderMode({ stripe_mode: 'test' }), 'test');
  assert.equal(stripeOrderMode({ stripe_payment_id: 'pi_unknown' }), null);
  assert.equal(stripeKeyMode('rk_test_example'), 'test');
  assert.equal(stripeKeyMode('sk_live_example'), 'live');
  assert.equal(stripeKeyMode('pk_live_not_a_server_key'), null);
});

test('adding a historical test key preserves live checkout and the primary account', () => {
  const makeClient = key => ({ key });
  const result = storefrontStripeClients({ STRIPE_SECRET_KEY: 'sk_live_primary', STOREFRONT_STRIPE_TEST_SECRET_KEY: 'rk_test_original',
    STOREFRONT_STRIPE_LIVE_SECRET_KEY: 'sk_live_other' }, makeClient);
  assert.equal(result.stripeMode, 'live');
  assert.equal(result.stripe.key, 'sk_live_primary');
  assert.equal(result.stripeClients.live, result.stripe);
  assert.equal(result.stripeClients.test.key, 'rk_test_original');
  assert.equal(storefrontStripeClients({ STOREFRONT_STRIPE_TEST_SECRET_KEY: 'sk_test_only' }, makeClient).stripe, null);
  assert.throws(() => storefrontStripeClients({ STOREFRONT_STRIPE_TEST_SECRET_KEY: 'sk_live_wrong' }, makeClient), /must be a Stripe test-mode/);
  assert.throws(() => storefrontStripeClients({ STRIPE_SECRET_KEY: 'pk_live_public' }, makeClient), /STRIPE_SECRET_KEY must/);
});

test('mode mismatch errors are actionable without returning raw Stripe identifiers', () => {
  for (const mode of ['test', 'live']) {
    const error = storefrontStripeError(Object.assign(new Error(`No such payment_intent: 'pi_private'; a similar object exists in ${mode} mode, but another key was used.`), { code: 'resource_missing' }));
    assert.equal(error.status, 409);
    assert.equal(error.code, 'storefront_stripe_mode');
    assert.match(error.message, new RegExp(`${mode}-mode order`));
    assert.doesNotMatch(error.message, /pi_private/);
  }
  const missing = Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' });
  assert.equal(storefrontStripeError(missing), missing);
  const network = new Error('Connection lost');
  assert.equal(storefrontStripeError(network), network);
});

test('historical test webhooks need their own valid signature and matching event mode', () => {
  const stripe = new Stripe('sk_test_signature_only');
  const env = { STOREFRONT_STRIPE_WEBHOOK_SECRET: 'whsec_primary', STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET: 'whsec_historical' };
  const payload = JSON.stringify({ id: 'evt_test', livemode: false, type: 'refund.updated', data: { object: {} } });
  const sign = (body, secret) => stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  assert.equal(storefrontWebhookEvent(stripe, payload, sign(payload, env.STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET), env).id, 'evt_test');
  assert.equal(storefrontWebhookEvent(stripe, payload, sign(payload, env.STOREFRONT_STRIPE_WEBHOOK_SECRET), env).id, 'evt_test');
  assert.throws(() => storefrontWebhookEvent(stripe, payload, sign(payload, 'whsec_wrong'), env), error => error.status === 400);
  const live = JSON.stringify({ id: 'evt_live', livemode: true });
  assert.throws(() => storefrontWebhookEvent(stripe, live, sign(live, env.STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET), env), error => error.status === 400);
  assert.throws(() => storefrontWebhookEvent(null, payload, '', env), error => error.status === 503);
});
