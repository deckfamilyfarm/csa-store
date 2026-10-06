import Stripe from 'stripe';

export function stripeKeyMode(key) {
  return /^(?:sk|rk)_(test|live)_/.exec(String(key || '').trim())?.[1] || null;
}

export function stripeOrderMode(order) {
  if (['test', 'live'].includes(order.stripe_mode)) return order.stripe_mode;
  return /^cs_(test|live)_/.exec(order.stripe_session_id || '')?.[1] || null;
}

export function stripeModeError(mode) {
  return Object.assign(new Error(`This is a Stripe ${mode}-mode order, but matching Stripe credentials are not configured. Ask an administrator to configure the original ${mode}-mode Stripe account, then retry. Preorder inventory remains unchanged.`),
    { status: 409, code: 'storefront_stripe_mode' });
}

export function storefrontStripeError(error) {
  const mode = error.code === 'resource_missing' && /a similar object exists in (test|live) mode/i.exec(error.message || '')?.[1];
  return mode ? stripeModeError(mode) : error;
}

// The primary key continues to control new checkout. Additional keys are only
// used to maintain existing orders from the other mode, never as a write retry.
export function storefrontStripeClients(env = process.env, makeClient = key => new Stripe(key)) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  const stripe = key ? makeClient(key) : null;
  const stripeMode = stripeKeyMode(key);
  if (key && !stripeMode) throw Object.assign(new Error('STRIPE_SECRET_KEY must identify a Stripe test or live mode secret or restricted key.'), { status: 503 });
  const stripeClients = {};
  if (stripeMode) stripeClients[stripeMode] = stripe;
  for (const mode of ['test', 'live']) {
    const name = `STOREFRONT_STRIPE_${mode.toUpperCase()}_SECRET_KEY`;
    const additionalKey = String(env[name] || '').trim();
    if (!additionalKey) continue;
    if (stripeKeyMode(additionalKey) !== mode) throw Object.assign(new Error(`${name} must be a Stripe ${mode}-mode secret or restricted key.`), { status: 503 });
    if (!stripeClients[mode]) stripeClients[mode] = makeClient(additionalKey);
  }
  return { stripe, stripeMode, stripeClients };
}

export function storefrontWebhookEvent(stripe, payload, signature, env = process.env) {
  const secrets = [
    [null, env.STOREFRONT_STRIPE_WEBHOOK_SECRET],
    ['test', env.STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET],
    ['live', env.STOREFRONT_STRIPE_LIVE_WEBHOOK_SECRET]
  ].filter(([, secret]) => secret);
  if (!stripe || !secrets.length) throw Object.assign(new Error('Storefront webhook is not configured.'), { status: 503 });
  for (const [mode, secret] of secrets) {
    try {
      const event = stripe.webhooks.constructEvent(payload, signature, secret);
      if (mode && event.livemode !== (mode === 'live')) continue;
      return event;
    } catch { /* Try only explicitly configured webhook signing secrets. */ }
  }
  throw Object.assign(new Error('Invalid Stripe signature.'), { status: 400 });
}
