import { getPool } from '../db.js';
import { getStripeClient } from './memberPortal.js';
import { sendStorefrontEmail, storefrontEmailConfigured } from './email.js';
import { createStorefrontService } from './storefrontService.js';

let service;
export function getStorefrontService() {
  if (!service) service = createStorefrontService({
    pool: getPool(), stripe: getStripeClient(), sendEmail: sendStorefrontEmail,
    config: {
      enabled: process.env.STOREFRONT_CHECKOUT_ENABLED === 'true',
      baseUrl: process.env.STOREFRONT_BASE_URL || 'https://turkeys.deckfamilyfarm.com',
      webhookSecret: process.env.STOREFRONT_STRIPE_WEBHOOK_SECRET || '',
      emailReady: storefrontEmailConfigured()
    }
  });
  return service;
}
