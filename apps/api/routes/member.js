import express from "express";
import { eq } from "drizzle-orm";
import { ensureSubscriptionPortalSchema, getDb } from "../db.js";
import { requireUser } from "../middleware/auth.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl, isLocalLineAuthConfigured } from "../localLineAuth.js";
import {
  memberProfiles
} from "../schema.js";
import {
  buildMemberPortalSummary,
  computeStripeBillingAnchor,
  ensureLocalLineMirror,
  ensureMemberLedgerAccounts,
  getMemberProfileByUserId,
  getMemberSubscriptionByUserId,
  getPlanDefinition,
  getPrimaryExternalLink,
  getStripeClient,
  getStripePriceIdForPlan,
  getUserById,
  loadSubscriptionSettings,
  normalizeBillingDay,
  normalizePlanKey
} from "../lib/memberPortal.js";
import { importMemberLocalLineLedgerActivity } from "../lib/memberPortalSync.js";

import { runMemberBilling } from '../lib/memberBilling.js';
import { getMemberOperation } from '../lib/memberFinancialOperations.js';
import { processMemberStripeEvent } from '../lib/memberStripeEvents.js';
import { requireVerifiedLocalLineLink, saveVerifiedLocalLineLink } from '../lib/memberExternalLinks.js';
const router = express.Router();

function getLocalLineStorefrontBaseUrl() {
  return String(
    process.env.LOCAL_LINE_BASE_URL ||
      process.env.PUBLIC_STORE_URL ||
      "https://fullfarmcsa.deckfamilyfarm.com"
  ).replace(/\/+$/, "");
}

async function setLocalLineSetupState(userId, {
  status = null,
  mode = null,
  note = null
} = {}, db = getDb()) {
  await db
    .update(memberProfiles)
    .set({
      localLineSetupStatus: status,
      localLineSetupMode: mode,
      localLineSetupNote: note,
      updatedAt: new Date()
    })
    .where(eq(memberProfiles.userId, Number(userId)));
}

async function ensurePortalContext(userId) {
  const db = getDb();
  await ensureSubscriptionPortalSchema();
  const user = await getUserById(userId, db);
  const profile = await getMemberProfileByUserId(userId, db);
  if (!profile) {
    return { error: "Member portal profile not found.", status: 404 };
  }
  const subscription = await getMemberSubscriptionByUserId(userId, db);
  const settings = await loadSubscriptionSettings(db);
  const accounts = await ensureMemberLedgerAccounts(userId, db);
  return { db, user, profile, subscription, settings, accounts };
}

async function ensureStripeCustomer({ stripe, userId, subscription }) {
  if (subscription?.stripeCustomerId) return subscription.stripeCustomerId;
  const result = await runMemberBilling({userId,kind:'customer',requestKey:'stripe-customer-v1',stripe});
  return result.stripeCustomerId;
}

async function fetchStripeOverview(subscriptionRow) {
  const stripe = getStripeClient();
  if (!stripe || !subscriptionRow?.stripeCustomerId) {
    return {
      configured: Boolean(stripe),
      paymentMethods: [],
      defaultPaymentMethodId: null,
      stripeSubscription: null
    };
  }

  const [paymentMethods, customer] = await Promise.all([
    stripe.paymentMethods.list({
      customer: subscriptionRow.stripeCustomerId,
      type: "card"
    }),
    stripe.customers.retrieve(subscriptionRow.stripeCustomerId)
  ]);

  let stripeSubscription = null;
  if (subscriptionRow.stripeSubscriptionId) {
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(subscriptionRow.stripeSubscriptionId);
    } catch (_error) {
      stripeSubscription = null;
    }
  }

  return {
    configured: true,
    paymentMethods: paymentMethods.data || [],
    defaultPaymentMethodId:
      customer && !customer.deleted
        ? customer.invoice_settings?.default_payment_method || null
        : null,
    stripeSubscription
  };
}

router.get("/portal", requireUser, async (req, res) => {
  try {
    const userId = Number(req.user.userId);
    await ensureSubscriptionPortalSchema();
    const summary = await buildMemberPortalSummary(userId);
    const stripeData = await fetchStripeOverview(summary.subscription);
    res.json({
      ...summary,
      stripe: stripeData
    });
  } catch (error) {
    console.error("Member portal summary failed:", error);
    res.status(500).json({ error: "Unable to load member portal." });
  }
});

router.post('/setup-intent', requireUser, async (req,res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(503).json({error:'Stripe is not configured.'});
    await ensureSubscriptionPortalSchema();
    res.json(await runMemberBilling({userId:Number(req.user.userId),kind:'setup',requestKey:req.headers['idempotency-key'],stripe}));
  } catch(error) { res.status(error.status || 503).json({error:error.message,operationId:error.operationId}); }
});

router.post("/payment-method/default", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });
    const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
    if (!paymentMethodId) return res.status(400).json({ error: "Payment method is required." });

    const userId = Number(req.user.userId);
    const context = await ensurePortalContext(userId);
    if (context.error) {
      return res.status(context.status || 400).json({ error: context.error });
    }
    const { user, profile, subscription } = context;
    const stripeCustomerId = await ensureStripeCustomer({
      stripe,
      userId,
      profile: {
        ...profile,
        userEmail: user?.email
      },
      subscription
    });

    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (paymentMethod.customer && paymentMethod.customer !== stripeCustomerId) {
      return res.status(400).json({ error: "Payment method belongs to a different customer." });
    }
    if (!paymentMethod.customer) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
    }

    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    if (subscription?.stripeSubscriptionId) {
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        default_payment_method: paymentMethodId
      });
    }

    const stripeData = await fetchStripeOverview({
      ...subscription,
      stripeCustomerId
    });
    res.json(stripeData);
  } catch (error) {
    console.error("Set default payment method failed:", error);
    res.status(400).json({ error: error?.message || "Unable to set default payment method." });
  }
});

router.post("/payment-method/delete", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });
    const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
    if (!paymentMethodId) return res.status(400).json({ error: "Payment method is required." });

    const userId = Number(req.user.userId);
    const context = await ensurePortalContext(userId);
    if (context.error) {
      return res.status(context.status || 400).json({ error: context.error });
    }
    const { subscription } = context;
    if (!subscription?.stripeCustomerId) {
      return res.status(404).json({ error: "Stripe customer is not set up yet." });
    }

    const methods = await stripe.paymentMethods.list({
      customer: subscription.stripeCustomerId,
      type: "card"
    });
    if (subscription.stripeSubscriptionId && methods.data.length <= 1) {
      return res
        .status(400)
        .json({ error: "Cannot remove the last payment method while a subscription exists." });
    }

    await stripe.paymentMethods.detach(paymentMethodId);

    const stripeData = await fetchStripeOverview(subscription);
    res.json(stripeData);
  } catch (error) {
    console.error("Delete payment method failed:", error);
    res.status(400).json({ error: error?.message || "Unable to delete payment method." });
  }
});

for (const [path,kind] of [['/subscription','subscription'],['/subscription/pause','pause'],['/subscription/resume','resume'],['/subscription/cancel','cancel']]) {
  router.post(path, requireUser, async (req,res) => {
    try {
      const stripe = getStripeClient();
      if (!stripe) return res.status(503).json({error:'Stripe is not configured.'});
      await ensureSubscriptionPortalSchema();
      const input = kind==='subscription' ? {planKey:normalizePlanKey(req.body?.planKey || req.body?.selectedPlan),billingDayOfMonth:normalizeBillingDay(req.body?.billingDayOfMonth,1)} : {};
      const plan = kind==='subscription' ? getPlanDefinition(input.planKey) : null;
      if(kind==='subscription' && !plan) return res.status(400).json({error:'Choose a valid subscription plan.'});
      const result = await runMemberBilling({userId:Number(req.user.userId),kind,requestKey:req.headers['idempotency-key'],input,stripe,plan,
        priceId:plan ? getStripePriceIdForPlan(plan.key) : null,anchor:plan ? computeStripeBillingAnchor(input.billingDayOfMonth) : null});
      const summary = await buildMemberPortalSummary(Number(req.user.userId));
      res.json({...summary,operation:result});
    } catch(error) { res.status(error.status || 503).json({error:error.message,operationId:error.operationId}); }
  });
}
router.get('/operations/:id',requireUser,async(req,res)=>{
  try { res.json(await getMemberOperation(req.params.id,Number(req.user.userId))); }
  catch(e){res.status(e.status || 500).json({error:e.message});}
});

router.get("/localline-link", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    const userId = Number(req.user.userId);
    const link = await getPrimaryExternalLink(userId, "localline");
    if(link)await requireVerifiedLocalLineLink(link,userId);
    const mirror = link ? await ensureLocalLineMirror(userId, link.id) : null;
    res.json({ link, mirror });
  } catch (error) {
    console.error("Load Local Line link failed:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load Local Line link." });
  }
});

router.post("/localline-link", requireUser, (_req, res) => {
  res.status(410).json({ error: 'Manual customer IDs are no longer accepted. Sign in to Local Line to verify account ownership.' });
});

router.post("/localline/login", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    const db = getDb();
    const userId = Number(req.user.userId);
    const identifier = String(req.body?.identifier || req.body?.email || "").trim();
    const normalizedEmail = identifier.toLowerCase();
    const password = String(req.body?.password || "");
    if (!identifier || !password) {
      return res.status(400).json({ error: "Local Line email or username and password are required." });
    }

    const storefrontBase = getLocalLineStorefrontBaseUrl();
    const tokenUrl = `${storefrontBase}/api/storefront/v2/token`;
    const loginCandidates = [];
    if (identifier.includes("@")) {
      loginCandidates.push({ email: normalizedEmail, password });
      loginCandidates.push({ username: identifier, password });
    } else {
      loginCandidates.push({ username: identifier, password });
      loginCandidates.push({ email: normalizedEmail, password });
    }
    let tokenResponse = null;
    let tokenText = "";
    let tokenJson = {};
    let accessToken = null;
    let tokenNetworkFailed = false;

    for (const payload of loginCandidates) {
      try {
        tokenResponse = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (_error) {
        tokenNetworkFailed = true;
        break;
      }
      tokenText = await tokenResponse.text();
      try {
        tokenJson = JSON.parse(tokenText);
      } catch (_error) {
        tokenJson = { raw: tokenText };
      }
      accessToken =
        tokenJson?.access_token ||
        tokenJson?.token ||
        tokenJson?.accessToken ||
        tokenJson?.access;
      if (tokenResponse.ok && accessToken) {
        break;
      }
    }

    if (tokenNetworkFailed || !tokenResponse) {
      return res.status(502).json({
        error:
          "We could not reach the Local Line storefront login service. Please try again shortly or contact farm staff."
      });
    }

    if (!tokenResponse.ok || !accessToken) {
      if (tokenResponse.status === 401 || tokenResponse.status === 403) {
        return res.status(400).json({
          error: "Local Line login failed. Double-check your Local Line email or username and password."
        });
      }
      if (tokenResponse.status === 404) {
        return res.status(502).json({
          error:
            "Local Line login is not configured correctly on this site right now. Please contact farm staff."
        });
      }
      if (String(tokenText || "").trim().startsWith("<!DOCTYPE") || String(tokenText || "").trim().startsWith("<html")) {
        return res.status(502).json({
          error:
            "The Local Line storefront returned a web page instead of a login response. Please contact farm staff."
        });
      }
      return res.status(400).json({
        error:
          tokenJson?.detail ||
          tokenJson?.error ||
          "Local Line login failed. Double-check your Local Line email or username and password."
      });
    }

    const setCookie = tokenResponse.headers.get("set-cookie") || "";
    const customerUrl = `${storefrontBase}/api/storefront/v2/customers/current/`;
    let customerResponse;
    try {
      customerResponse = await fetch(customerUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Cookie: setCookie
        }
      });
    } catch (_error) {
      return res.status(502).json({
        error:
          "We signed in to Local Line, but could not load your shopping account details. Please try again shortly."
      });
    }
    const customerText = await customerResponse.text();
    let customer = {};
    try {
      customer = JSON.parse(customerText);
    } catch (_error) {
      customer = { raw: customerText };
    }
    if (!customerResponse.ok || !customer?.id) {
      if (customerResponse.status === 404) {
        return res.status(404).json({
          error:
            "We signed in, but could not find a Local Line customer account for this login. If you are new to Local Line, choose Create my Local Line account instead."
        });
      }
      if (String(customerText || "").trim().startsWith("<!DOCTYPE") || String(customerText || "").trim().startsWith("<html")) {
        return res.status(502).json({
          error:
            "We signed in, but the Local Line storefront returned a web page instead of your account details. Please contact farm staff."
        });
      }
      return res.status(400).json({
        error:
          customer?.detail ||
          customer?.error ||
          "We signed in, but could not find your Local Line shopping account."
      });
    }

    const { linkId } = await saveVerifiedLocalLineLink({
      userId, externalCustomerId: String(customer.id),
      externalEmail: String(customer.email || normalizedEmail || '').trim() || null,
      method: 'storefront_login', actorUserId: userId,
      evidence: { endpoint: 'customers/current', customerId: String(customer.id) }
    });
    const mirror = await ensureLocalLineMirror(userId, linkId);

    const importResult = await importMemberLocalLineLedgerActivity({ userId });
    const summary = await buildMemberPortalSummary(userId);
    res.json({
      ok: true,
      linkId,
      customer,
      mirror,
      importResult,
      summary
    });
  } catch (error) {
    console.error("Local Line login failed:", error);
    res.status(400).json({ error: error?.message || "Unable to connect your Local Line account." });
  }
});

router.post("/localline/import-ledger", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    if (!isLocalLineAuthConfigured()) {
      return res.status(400).json({ error: "Local Line backoffice auth is not configured." });
    }
    const userId = Number(req.user.userId);
    const link = await getPrimaryExternalLink(userId, "localline");
    if (!link?.externalCustomerId) {
      return res.status(404).json({ error: "Local Line account is not connected yet." });
    }
    await requireVerifiedLocalLineLink(link, userId);

    const importResult = await importMemberLocalLineLedgerActivity({ userId });
    const summary = await buildMemberPortalSummary(userId);
    res.json({
      ok: true,
      importResult,
      summary
    });
  } catch (error) {
    console.error("Local Line ledger import failed:", error);
    res.status(500).json({ error: error?.message || "Unable to import Local Line ledger activity." });
  }
});

router.post("/localline/request-create", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    const db = getDb();
    const userId = Number(req.user.userId);
    const email = String(req.body?.email || req.user?.email || "").trim().toLowerCase();
    const note = String(req.body?.note || "").trim();

    await setLocalLineSetupState(
      userId,
      {
        status: "pending_create",
        mode: "create_new",
        note: note || (email ? `Create Local Line account for ${email}` : "Create Local Line account")
      },
      db
    );

    const summary = await buildMemberPortalSummary(userId);
    res.json({
      ok: true,
      summary
    });
  } catch (error) {
    console.error("Local Line create request failed:", error);
    res.status(500).json({ error: "Unable to save Local Line setup request." });
  }
});

router.get("/localline/customer", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    if (!isLocalLineAuthConfigured()) {
      return res.status(400).json({ error: "Local Line backoffice auth is not configured." });
    }
    const userId = Number(req.user.userId);
    const link = await getPrimaryExternalLink(userId, "localline");
    if (!link?.externalCustomerId) {
      return res.status(404).json({ error: "Local Line account is not connected yet." });
    }
    await requireVerifiedLocalLineLink(link, userId);

    const token = await getLocalLineAccessToken();
    const url = `${getLocalLineBaseUrl()}customers/${encodeURIComponent(link.externalCustomerId)}/`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const text = await response.text();
    let customer = {};
    try {
      customer = JSON.parse(text);
    } catch (_error) {
      customer = { raw: text };
    }
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Local Line customer details."
      });
    }

    res.json({ customer });
  } catch (error) {
    console.error("Local Line customer fetch failed:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load Local Line customer details." });
  }
});

router.get("/localline/credit", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    if (!isLocalLineAuthConfigured()) {
      return res.status(400).json({ error: "Local Line backoffice auth is not configured." });
    }
    const userId = Number(req.user.userId);
    const link = await getPrimaryExternalLink(userId, "localline");
    if (!link?.externalCustomerId) {
      return res.status(404).json({ error: "Local Line account is not connected yet." });
    }
    await requireVerifiedLocalLineLink(link, userId);

    const page = Number.parseInt(String(req.query?.page || "1"), 10) || 1;
    const pageSize = Number.parseInt(String(req.query?.page_size || "25"), 10) || 25;
    const token = await getLocalLineAccessToken();
    const url = `${getLocalLineBaseUrl()}customers/${encodeURIComponent(
      link.externalCustomerId
    )}/store-credit-transaction/?page=${page}&page_size=${pageSize}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const text = await response.text();
    let credit = {};
    try {
      credit = JSON.parse(text);
    } catch (_error) {
      credit = { raw: text };
    }
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to fetch Local Line store credit."
      });
    }

    res.json({ credit });
  } catch (error) {
    console.error("Local Line credit fetch failed:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load Local Line credit." });
  }
});

export async function stripeWebhookHandler(req, res) {
  const stripe = getStripeClient();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!stripe || !webhookSecret) {
    return res.status(400).send("Stripe webhook is not configured.");
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).send("Missing Stripe signature.");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error);
    return res.status(400).send(`Webhook error: ${error?.message || "Invalid signature"}`);
  }

  try {
    res.json(await processMemberStripeEvent(event,{stripe}));
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

export default router;
