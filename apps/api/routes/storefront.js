import express from 'express';
import { requireAdminPermission } from '../middleware/auth.js';
import { getStorefrontService } from '../lib/storefrontRuntime.js';
import { getStripeClient } from '../lib/memberPortal.js';
import { storefrontWebhookEvent } from '../lib/storefrontStripe.js';

export const storefrontRouter = express.Router();
export const storefrontAdminRouter = express.Router();
const wrap = fn => async (req, res) => {
  try { await fn(req, res, getStorefrontService()); }
  catch (error) {
    if (!error.status) console.error('Storefront request failed:', error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to complete the request. Please try again.',
      ...(error.checkoutRejected ? { checkoutRejected: true } : {}) });
  }
};
const token = req => String(req.headers.authorization || '').replace(/^Bearer /, '');
const actor = req => req.admin.userId || req.admin.adminId;
const requests = new Map();
function limitCheckout(req, res, next) {
  const now = Date.now();
  for (const [key, value] of requests) if (value.expires < now) requests.delete(key);
  const key = req.ip;
  const entry = requests.get(key) || { count: 0, expires: now + 60000 };
  if (requests.size >= 10000 || ++entry.count > 120) return res.status(429).json({ error: 'Too many checkout attempts. Please wait a minute.' });
  requests.set(key, entry);
  next();
}
storefrontRouter.get('/sale', wrap(async (_req, res, service) => res.json(await service.catalog())));
storefrontRouter.get('/settings', wrap(async (_req, res, service) => res.set('Cache-Control', 'no-store').json(await service.storeSettings())));
storefrontRouter.post('/checkout', limitCheckout, wrap(async (req, res, service) => res.json(await service.checkout(req.body, req.get('origin')))));
storefrontRouter.get('/orders/:id', wrap(async (req, res, service) => res.json(await service.guestOrder(req.params.id, token(req)))));
storefrontRouter.post('/orders/:id/reconcile', limitCheckout, wrap(async (req, res, service) => {
  res.json(await service.reconcile(req.params.id, token(req)));
  service.deliverEmails().catch(error => console.error('Storefront mail retry deferred:', error.message));
}));
storefrontRouter.post('/orders/:id/cancel', limitCheckout, wrap(async (req, res, service) => res.json(await service.cancelReservation(req.params.id, token(req)))));

storefrontAdminRouter.use(requireAdminPermission('storefront_admin'));
storefrontAdminRouter.get('/settings', wrap(async (_req, res, service) => res.set('Cache-Control', 'no-store').json(await service.storeSettings())));
storefrontAdminRouter.put('/settings', wrap(async (req, res, service) => res.json(await service.saveStoreSettings(req.body, actor(req)))));
storefrontAdminRouter.get('/setup', wrap(async (_req, res, service) => res.json(await service.catalog(true))));
storefrontAdminRouter.put('/setup', wrap(async (req, res, service) => res.json(await service.saveSetup(req.body, actor(req)))));
storefrontAdminRouter.post('/stock/:id', wrap(async (req, res, service) => res.json(await service.adjustStock(req.params.id, req.body, actor(req)))));
storefrontAdminRouter.get('/stock/:id/history', wrap(async (req, res, service) => res.json(await service.stockHistory(req.params.id))));
storefrontAdminRouter.get('/orders.csv', wrap(async (req, res, service) => {
  res.set('Content-Disposition', 'attachment; filename="turkey-preorders.csv"');
  res.type('text/csv').send(await service.exportOrders(req.query));
}));
storefrontAdminRouter.get('/orders', wrap(async (req, res, service) => res.json({ orders: await service.orders(req.query), emailRetries: await service.emailStatus() })));
storefrontAdminRouter.post('/orders/:id/collect', wrap(async (req, res, service) => res.json(await service.collect(req.params.id, actor(req)))));
storefrontAdminRouter.post('/orders/:id/refund', wrap(async (req, res, service) => {
  res.json(await service.issueRefund(req.params.id, actor(req)));
  service.deliverEmails().catch(error => console.error('Storefront mail retry deferred:', error.message));
}));
storefrontAdminRouter.post('/orders/:id/reconcile', wrap(async (req, res, service) => res.json(await service.reconcile(req.params.id))));
storefrontAdminRouter.post('/orders/:id/stripe-receipt', wrap(async (req, res, service) => res.json(await service.attachSession(req.params.id, req.body.sessionId))));

export async function storefrontStripeWebhook(req, res) {
  const stripe = getStripeClient();
  let event;
  try { event = storefrontWebhookEvent(stripe, req.body, req.headers['stripe-signature']); }
  catch (error) { return res.status(error.status || 400).send(error.message); }
  try {
    const service = getStorefrontService();
    await service.webhook(event);
    res.json({ received: true });
    service.deliverEmails().catch(error => console.error('Storefront mail retry deferred:', error.message));
  } catch (error) {
    console.error('Storefront webhook deferred:', event.id, error.message);
    res.status(500).json({ error: 'Retry webhook processing.' });
  }
}
