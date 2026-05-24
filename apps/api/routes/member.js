import express from "express";
import { eq } from "drizzle-orm";
import { ensureSubscriptionPortalSchema, getDb } from "../db.js";
import { requireUser } from "../middleware/auth.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl, isLocalLineAuthConfigured } from "../localLineAuth.js";
import {
  memberCreditMirrors,
  memberExternalAccountLinks,
  memberHerdshareStatuses,
  memberProfiles,
  memberSubscriptions
} from "../schema.js";
import {
  buildMemberPortalSummary,
  computeNextBillingDate,
  computeStripeBillingAnchor,
  createLedgerEntry,
  ensureLocalLineMirror,
  ensureMemberLedgerAccounts,
  getMemberProfileByUserId,
  getMemberSubscriptionByUserId,
  getPlanDefinition,
  getPrimaryExternalLink,
  getStripeClient,
  getStripePriceIdForPlan,
  getUserById,
  ledgerReferenceExists,
  loadSubscriptionSettings,
  normalizeBillingDay,
  normalizePlanKey
} from "../lib/memberPortal.js";
import { importMemberLocalLineLedgerActivity } from "../lib/memberPortalSync.js";

const router = express.Router();

function getLocalLineStorefrontBaseUrl() {
  return String(
    process.env.LOCAL_LINE_BASE_URL ||
      process.env.PUBLIC_STORE_URL ||
      "https://fullfarmcsa.deckfamilyfarm.com"
  ).replace(/\/+$/, "");
}

function parseMetadataJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function stringifyMetadata(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_error) {
    return "{}";
  }
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

async function saveLocalLineLinkRecord({
  userId,
  externalCustomerId,
  externalEmail = null,
  metadata = {},
  mode = "manual"
}, db = getDb()) {
  const existing = await getPrimaryExternalLink(userId, "localline", db);
  const now = new Date();
  let linkId = existing?.id || null;
  if (existing) {
    const existingMetadata = parseMetadataJson(existing.metadataJson);
    await db
      .update(memberExternalAccountLinks)
      .set({
        externalCustomerId,
        externalEmail: externalEmail || null,
        metadataJson: stringifyMetadata({
          ...existingMetadata,
          ...metadata,
          connectionMode: mode,
          connectionStatus: "connected"
        }),
        linkedAt: existing.linkedAt || now,
        lastSyncedAt: existing.lastSyncedAt || null,
        updatedAt: now
      })
      .where(eq(memberExternalAccountLinks.id, existing.id));
    linkId = existing.id;
  } else {
    const result = await db.insert(memberExternalAccountLinks).values({
      userId,
      provider: "localline",
      externalCustomerId,
      externalEmail: externalEmail || null,
      metadataJson: stringifyMetadata({
        ...metadata,
        connectionMode: mode,
        connectionStatus: "connected"
      }),
      linkedAt: now,
      createdAt: now,
      updatedAt: now
    });
    linkId = Number(result[0]?.insertId);
  }

  await setLocalLineSetupState(
    userId,
    {
      status: "connected",
      mode,
      note: null
    },
    db
  );

  const mirror = await ensureLocalLineMirror(userId, linkId, "localline", db);
  return { linkId, mirror };
}

async function applyPaidInvoiceToMemberPortal({
  subscription,
  invoice,
  db
}) {
  if (!subscription) return;

  const settings = await loadSubscriptionSettings(db);
  const { wallet } = await ensureMemberLedgerAccounts(subscription.userId, db);
  const now = new Date();
  const referenceBase = String(invoice?.id || invoice?.subscription || subscription.stripeSubscriptionId || "").trim();
  if (!referenceBase) return;

  const depositReferenceId = referenceBase;
  const herdshareReferenceId = `${referenceBase}:herdshare`;
  const depositAmountCents =
    Number(subscription.planAmountCents || 0) || Number(invoice?.amount_paid || 0);
  const herdshareFeeCents = Number(settings.herdshareMonthlyFeeCents || 500);

  let createdDeposit = false;
  let createdHerdshareCharge = false;

  if (
    depositAmountCents > 0 &&
    !(await ledgerReferenceExists(subscription.userId, "stripe_invoice", depositReferenceId))
  ) {
    await createLedgerEntry({
      accountId: wallet.id,
      userId: subscription.userId,
      entryType: "subscription_deposit",
      amountCents: depositAmountCents,
      effectiveDate: now,
      referenceType: "stripe_invoice",
      referenceId: depositReferenceId,
      description: `Subscription deposit for ${subscription.planKey}`
    });
    createdDeposit = true;
  }

  if (
    herdshareFeeCents > 0 &&
    !(await ledgerReferenceExists(subscription.userId, "stripe_invoice", herdshareReferenceId))
  ) {
    await createLedgerEntry({
      accountId: wallet.id,
      userId: subscription.userId,
      entryType: "herdshare_charge",
      amountCents: -Math.abs(herdshareFeeCents),
      effectiveDate: now,
      referenceType: "stripe_invoice",
      referenceId: herdshareReferenceId,
      description: "Monthly herdshare charge"
    });
    createdHerdshareCharge = true;
  }

  const nextBillingDate =
    subscription.billingDayOfMonth
      ? computeNextBillingDate(subscription.billingDayOfMonth, now)
      : subscription.nextBillingDate || null;

  await db
    .update(memberSubscriptions)
    .set({
      status: "active",
      lastDepositAt: createdDeposit ? now : subscription.lastDepositAt || now,
      nextBillingDate,
      updatedAt: now
    })
    .where(eq(memberSubscriptions.id, subscription.id));

  if (createdDeposit || createdHerdshareCharge) {
    const link = await getPrimaryExternalLink(subscription.userId, "localline", db);
    if (link) {
      const mirror = await ensureLocalLineMirror(subscription.userId, link.id, "localline", db);
      const netCreditCents = Math.max(
        0,
        (createdDeposit ? depositAmountCents : 0) -
          (createdHerdshareCharge ? herdshareFeeCents : 0)
      );
      if (netCreditCents > 0) {
        await db
          .update(memberCreditMirrors)
          .set({
            lastKnownBalanceCents: Number(mirror.lastKnownBalanceCents || 0) + netCreditCents,
            lastMirroredAt: now,
            updatedAt: now
          })
          .where(eq(memberCreditMirrors.id, mirror.id));
      }
    }
  }
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

async function ensureStripeCustomer({ stripe, userId, profile, subscription }) {
  let stripeCustomerId = subscription?.stripeCustomerId || null;
  if (stripeCustomerId) return stripeCustomerId;

  const customer = await stripe.customers.create({
    email: profile.userEmail || undefined,
    name: `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || undefined,
    phone: profile.phone || undefined,
    metadata: {
      userId: String(userId),
      source: "csa-store"
    }
  });
  stripeCustomerId = customer.id;
  await getDb()
    .update(memberSubscriptions)
    .set({
      stripeCustomerId,
      updatedAt: new Date()
    })
    .where(eq(memberSubscriptions.userId, Number(userId)));
  return stripeCustomerId;
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

router.post("/setup-intent", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });

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

    const intent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      usage: "off_session",
      payment_method_types: ["card"]
    });

    res.json({ clientSecret: intent.client_secret, stripeCustomerId });
  } catch (error) {
    console.error("Member setup intent failed:", error);
    res.status(400).json({ error: error?.message || "Unable to create setup intent." });
  }
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

router.post("/subscription", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });

    const userId = Number(req.user.userId);
    const planKey = normalizePlanKey(req.body?.planKey || req.body?.selectedPlan);
    const billingDayOfMonth = normalizeBillingDay(req.body?.billingDayOfMonth, 1);
    const plan = getPlanDefinition(planKey);
    if (!plan) {
      return res.status(400).json({ error: "Choose a valid subscription plan." });
    }
    const priceId = getStripePriceIdForPlan(plan.key);
    if (!priceId) {
      return res.status(400).json({ error: "Stripe price is not configured for that plan." });
    }

    const db = getDb();
    const context = await ensurePortalContext(userId);
    if (context.error) {
      return res.status(context.status || 400).json({ error: context.error });
    }
    const { user, profile, subscription, settings } = context;
    const stripeCustomerId = await ensureStripeCustomer({
      stripe,
      userId,
      profile: {
        ...profile,
        userEmail: user?.email
      },
      subscription
    });
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const defaultPaymentMethodId =
      customer && !customer.deleted ? customer.invoice_settings?.default_payment_method : null;
    if (!defaultPaymentMethodId) {
      return res.status(400).json({
        error: "Add and set a default payment method before activating your subscription."
      });
    }

    const shouldCollectImmediateCharge =
      !subscription?.stripeSubscriptionId ||
      subscription?.status === "pending_payment_method" ||
      subscription?.status === "canceled";
    if (subscription?.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(subscription.stripeSubscriptionId, {
          invoice_now: false,
          prorate: false
        });
      } catch (_error) {
        // Ignore stale remote subscription ids and continue with recreation.
      }
    }

    const stripeSubscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: priceId }],
      default_payment_method: defaultPaymentMethodId,
      billing_cycle_anchor: computeStripeBillingAnchor(billingDayOfMonth),
      proration_behavior: "none",
      collection_method: "charge_automatically",
      payment_behavior: "allow_incomplete",
      metadata: {
        userId: String(userId),
        planKey: plan.key
      }
    });

    if (shouldCollectImmediateCharge) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        amount: plan.amountCents,
        currency: "usd",
        description: `Initial ${plan.label} subscription charge`,
        metadata: {
          userId: String(userId),
          planKey: plan.key,
          billingKind: "initial_subscription_charge"
        }
      });

      const immediateInvoice = await stripe.invoices.create({
        customer: stripeCustomerId,
        auto_advance: true,
        collection_method: "charge_automatically",
        metadata: {
          userId: String(userId),
          planKey: plan.key,
          billingKind: "initial_subscription_charge"
        }
      });

      await stripe.invoices.pay(immediateInvoice.id);
    }

    const now = new Date();
    const nextBillingDate =
      stripeSubscription.current_period_end
        ? new Date(stripeSubscription.current_period_end * 1000)
        : computeNextBillingDate(billingDayOfMonth, now);

    await db
      .update(memberSubscriptions)
      .set({
        planKey: plan.key,
        planAmountCents: plan.amountCents,
        billingDayOfMonth,
        stripeCustomerId,
        stripeSubscriptionId: stripeSubscription.id,
        status: stripeSubscription.pause_collection ? "paused" : stripeSubscription.status || "active",
        nextBillingDate,
        currentPeriodStart: stripeSubscription.current_period_start
          ? new Date(stripeSubscription.current_period_start * 1000)
          : now,
        currentPeriodEnd: stripeSubscription.current_period_end
          ? new Date(stripeSubscription.current_period_end * 1000)
          : nextBillingDate,
        pausedAt: null,
        canceledAt: null,
        updatedAt: now
      })
      .where(eq(memberSubscriptions.userId, userId));

    await db
      .update(memberHerdshareStatuses)
      .set({
        monthlyFeeCents: Number(settings.herdshareMonthlyFeeCents || 500),
        status: "active",
        nextBillingDate,
        updatedAt: now
      })
      .where(eq(memberHerdshareStatuses.userId, userId));

    const summary = await buildMemberPortalSummary(userId);
    const stripeData = await fetchStripeOverview(summary.subscription);
    res.json({ ...summary, stripe: stripeData });
  } catch (error) {
    console.error("Create/update subscription failed:", error);
    res.status(400).json({ error: error?.message || "Unable to update your subscription." });
  }
});

router.post("/subscription/pause", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });
    const userId = Number(req.user.userId);
    const subscription = await getMemberSubscriptionByUserId(userId);
    if (!subscription?.stripeSubscriptionId) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      pause_collection: { behavior: "mark_uncollectible" }
    });

    await getDb()
      .update(memberSubscriptions)
      .set({
        status: "paused",
        pausedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(memberSubscriptions.userId, userId));

    const summary = await buildMemberPortalSummary(userId);
    res.json(summary);
  } catch (error) {
    console.error("Pause subscription failed:", error);
    res.status(400).json({ error: error?.message || "Unable to pause subscription." });
  }
});

router.post("/subscription/resume", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });
    const userId = Number(req.user.userId);
    const subscription = await getMemberSubscriptionByUserId(userId);
    if (!subscription?.stripeSubscriptionId) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      pause_collection: null
    });

    await getDb()
      .update(memberSubscriptions)
      .set({
        status: "active",
        pausedAt: null,
        updatedAt: new Date()
      })
      .where(eq(memberSubscriptions.userId, userId));

    const summary = await buildMemberPortalSummary(userId);
    res.json(summary);
  } catch (error) {
    console.error("Resume subscription failed:", error);
    res.status(400).json({ error: error?.message || "Unable to resume subscription." });
  }
});

router.post("/subscription/cancel", requireUser, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return res.status(400).json({ error: "Stripe is not configured." });
    const userId = Number(req.user.userId);
    const subscription = await getMemberSubscriptionByUserId(userId);
    if (!subscription?.stripeSubscriptionId) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    await stripe.subscriptions.cancel(subscription.stripeSubscriptionId, {
      invoice_now: false,
      prorate: false
    });

    await getDb()
      .update(memberSubscriptions)
      .set({
        status: "canceled",
        canceledAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(memberSubscriptions.userId, userId));

    const summary = await buildMemberPortalSummary(userId);
    res.json(summary);
  } catch (error) {
    console.error("Cancel subscription failed:", error);
    res.status(400).json({ error: error?.message || "Unable to cancel subscription." });
  }
});

router.get("/localline-link", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    const userId = Number(req.user.userId);
    const link = await getPrimaryExternalLink(userId, "localline");
    const mirror = link ? await ensureLocalLineMirror(userId, link.id) : null;
    res.json({ link, mirror });
  } catch (error) {
    console.error("Load Local Line link failed:", error);
    res.status(500).json({ error: "Unable to load Local Line link." });
  }
});

router.post("/localline-link", requireUser, async (req, res) => {
  try {
    await ensureSubscriptionPortalSchema();
    const db = getDb();
    const userId = Number(req.user.userId);
    const externalCustomerId = String(req.body?.externalCustomerId || "").trim();
    const externalEmail = String(req.body?.externalEmail || req.body?.email || "").trim();
    if (!externalCustomerId) {
      return res.status(400).json({ error: "External customer id is required." });
    }

    const { linkId, mirror } = await saveLocalLineLinkRecord(
      {
        userId,
        externalCustomerId,
        externalEmail,
        metadata: {
          linkedBy: "manual_entry"
        },
        mode: "manual"
      },
      db
    );
    res.json({ ok: true, linkId, mirror });
  } catch (error) {
    console.error("Save Local Line link failed:", error);
    res.status(500).json({ error: "Unable to save Local Line link." });
  }
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

    const { linkId, mirror } = await saveLocalLineLinkRecord(
      {
        userId,
        externalCustomerId: String(customer.id),
        externalEmail: String(customer.email || normalizedEmail || "").trim() || null,
        metadata: {
          linkedBy: "storefront_login",
          lastCustomer: {
            id: customer.id,
            email: customer.email || normalizedEmail,
            name: customer.name || customer.business_name || null
          }
        },
        mode: "find_existing"
      },
      db
    );

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

    const token = await getLocalLineAccessToken();
    const url = `${getLocalLineBaseUrl()}customers/${encodeURIComponent(link.externalCustomerId)}/`;
    const response = await fetch(url, {
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
    res.status(500).json({ error: "Unable to load Local Line customer details." });
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

    const page = Number.parseInt(String(req.query?.page || "1"), 10) || 1;
    const pageSize = Number.parseInt(String(req.query?.page_size || "25"), 10) || 25;
    const token = await getLocalLineAccessToken();
    const url = `${getLocalLineBaseUrl()}customers/${encodeURIComponent(
      link.externalCustomerId
    )}/store-credit-transaction/?page=${page}&page_size=${pageSize}`;
    const response = await fetch(url, {
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
    res.status(500).json({ error: "Unable to load Local Line credit." });
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
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const stripeSubscriptionId = String(invoice.subscription || "").trim();
      const stripeCustomerId = String(invoice.customer || "").trim();
      const db = getDb();
      await ensureSubscriptionPortalSchema();

      let subscription = null;
      if (stripeSubscriptionId) {
        const rows = await db
          .select()
          .from(memberSubscriptions)
          .where(eq(memberSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
          .limit(1);
        subscription = rows[0] || null;
      }

      if (!subscription && stripeCustomerId) {
        const rows = await db
          .select()
          .from(memberSubscriptions)
          .where(eq(memberSubscriptions.stripeCustomerId, stripeCustomerId))
          .limit(1);
        subscription = rows[0] || null;
      }

      if (subscription) {
        await applyPaidInvoiceToMemberPortal({
          subscription,
          invoice,
          db
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

export default router;
