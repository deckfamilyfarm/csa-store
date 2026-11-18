import { getPool } from '../db.js';
import { stripeKeyMode, storefrontStripeClients, storefrontWebhookEvent } from './storefrontStripe.js';
import { sendOperationalEmail } from './email.js';
import { createPrintify, verifyPrintifySignature } from './printify.js';
import { createMerchandiseService } from './merchandiseService.js';
export function merchandiseConfig(env=process.env) {
  let taxRules={};
  try { taxRules=JSON.parse(env.MERCH_TAX_RULES_JSON || '{}'); } catch { throw new Error('MERCH_TAX_RULES_JSON must be valid JSON.'); }
  const mode=env.MERCH_STRIPE_MODE || 'test';
  return {mode,taxRules,catalogEnabled:env.MERCH_CATALOG_ENABLED==='true',checkoutEnabled:env.MERCH_CHECKOUT_ENABLED==='true',
    liveEnabled:env.MERCH_LIVE_CHECKOUT_ENABLED==='true',ordersEnabled:env.PRINTIFY_ORDER_CREATION_ENABLED==='true',
    productionEnabled:env.PRINTIFY_PRODUCTION_ENABLED==='true',manualApprovalVerified:env.PRINTIFY_MANUAL_APPROVAL_VERIFIED==='true',
    approvedShopId:env.PRINTIFY_APPROVED_SHOP_ID || '',accountId:env.MERCH_STRIPE_ACCOUNT_ID || '',
    // Prefer the existing shared storefront destination. The legacy generic
    // signing secret belongs to the primary key's mode, not both modes.
    webhookReady:Boolean(env[`STOREFRONT_STRIPE_${mode.toUpperCase()}_WEBHOOK_SECRET`] ||
      (stripeKeyMode(env.STRIPE_SECRET_KEY)===mode && env.STOREFRONT_STRIPE_WEBHOOK_SECRET) ||
      env[`MERCH_STRIPE_${mode.toUpperCase()}_WEBHOOK_SECRET`]),baseUrl:env.MERCH_BASE_URL || 'https://store.deckfamilyfarm.com'};
}
let service;
export function getMerchandiseService() {
  if (!service) {
    const config=merchandiseConfig(), {stripeClients}=storefrontStripeClients();
    service=createMerchandiseService({pool:getPool(),stripeClients,provider:createPrintify({token:process.env.PRINTIFY_API_TOKEN,config}),config,sendEmail:sendOperationalEmail});
  }
  return service;
}
export function merchandiseStripeEvent(body,signature,env=process.env) {
  const {stripe,stripeClients}=storefrontStripeClients(env);
  return storefrontWebhookEvent(stripe || stripeClients.test || stripeClients.live,body,signature,{
    STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET:env.MERCH_STRIPE_TEST_WEBHOOK_SECRET,
    STOREFRONT_STRIPE_LIVE_WEBHOOK_SECRET:env.MERCH_STRIPE_LIVE_WEBHOOK_SECRET
  });
}
export const merchandisePrintifyEvent=(body,signature)=>verifyPrintifySignature(body,signature,process.env.PRINTIFY_WEBHOOK_SECRET);
