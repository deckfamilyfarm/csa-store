import Stripe from "stripe";
import { desc, eq } from "drizzle-orm";
import { getDb, getPool } from "../db.js";
import {
  memberCreditMirrors,
  memberExternalAccountLinks,
  memberHerdshareStatuses,
  memberLedgerAccounts,
  memberLedgerEntries,
  memberProfiles,
  memberSubscriptions,
  subscriptionSettings,
  users
} from "../schema.js";

export const MEMBER_PLAN_DEFINITIONS = {
  forager: {
    key: "forager",
    label: "Forager",
    amountCents: 20000
  },
  grazer: {
    key: "grazer",
    label: "Grazer",
    amountCents: 30000
  },
  harvester: {
    key: "harvester",
    label: "Harvester",
    amountCents: 50000
  }
};

let stripeClient;

export function getStripeClient() {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeSecret) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecret);
  }
  return stripeClient;
}

export function getStripePriceIdForPlan(planKey) {
  if (planKey === "forager") return cleanEnv(process.env.STRIPE_PRICE_200);
  if (planKey === "grazer") return cleanEnv(process.env.STRIPE_PRICE_300);
  if (planKey === "harvester") return cleanEnv(process.env.STRIPE_PRICE_500);
  return null;
}

function cleanEnv(value) {
  const next = String(value || "").trim();
  return next || null;
}

export function normalizePlanKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MEMBER_PLAN_DEFINITIONS[normalized] ? normalized : null;
}

export function getPlanDefinition(planKey) {
  const normalized = normalizePlanKey(planKey);
  return normalized ? MEMBER_PLAN_DEFINITIONS[normalized] : null;
}

export function normalizeBillingDay(value, fallback = 1) {
  const day = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(day) && day >= 1 && day <= 28) return day;
  return fallback;
}

export function computeNextBillingDate(dayOfMonth, fromDate = new Date()) {
  const safeDay = normalizeBillingDay(dayOfMonth, 1);
  const base = new Date(fromDate);
  const next = new Date(
    base.getFullYear(),
    base.getMonth(),
    safeDay,
    9,
    0,
    0,
    0
  );

  if (next.getTime() <= base.getTime()) {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

export function computeStripeBillingAnchor(dayOfMonth, fromDate = new Date()) {
  return Math.floor(computeNextBillingDate(dayOfMonth, fromDate).getTime() / 1000);
}

export async function loadSubscriptionSettings(db = getDb()) {
  const rows = await db.select().from(subscriptionSettings).orderBy(subscriptionSettings.id).limit(1);
  return (
    rows[0] || {
      id: 1,
      dividendRatePercent: "3.000",
      herdshareMonthlyFeeCents: 500
    }
  );
}

export async function getUserById(userId, db = getDb()) {
  const rows = await db.select().from(users).where(eq(users.id, Number(userId))).limit(1);
  return rows[0] || null;
}

export async function getMemberProfileByUserId(userId, db = getDb()) {
  const rows = await db.select().from(memberProfiles).where(eq(memberProfiles.userId, Number(userId))).limit(1);
  return rows[0] || null;
}

export async function getMemberSubscriptionByUserId(userId, db = getDb()) {
  const rows = await db
    .select()
    .from(memberSubscriptions)
    .where(eq(memberSubscriptions.userId, Number(userId)))
    .limit(1);
  return rows[0] || null;
}

export async function getMemberHerdshareStatusByUserId(userId, db = getDb()) {
  const rows = await db
    .select()
    .from(memberHerdshareStatuses)
    .where(eq(memberHerdshareStatuses.userId, Number(userId)))
    .limit(1);
  return rows[0] || null;
}

export async function ensureMemberLedgerAccount(userId, accountType, db = getDb()) {
  const existing = await db
    .select()
    .from(memberLedgerAccounts)
    .where(eq(memberLedgerAccounts.userId, Number(userId)))
    .orderBy(memberLedgerAccounts.id);
  const match = existing.find((row) => row.accountType === accountType);
  if (match) return match;

  const now = new Date();
  const result = await db.insert(memberLedgerAccounts).values({
    userId: Number(userId),
    accountType,
    currency: "USD",
    createdAt: now,
    updatedAt: now
  });
  const insertedId = Number(result[0]?.insertId);
  return {
    id: insertedId,
    userId: Number(userId),
    accountType,
    currency: "USD",
    createdAt: now,
    updatedAt: now
  };
}

export async function ensureMemberLedgerAccounts(userId, db = getDb()) {
  const wallet = await ensureMemberLedgerAccount(userId, "wallet", db);
  const dividendReserve = await ensureMemberLedgerAccount(userId, "dividend_reserve", db);
  const externalActivity = await ensureMemberLedgerAccount(userId, "external_activity", db);
  return { wallet, dividendReserve, externalActivity };
}

export async function createLedgerEntry({
  accountId,
  userId,
  entryType,
  amountCents,
  effectiveDate = new Date(),
  referenceType = null,
  referenceId = null,
  description = null,
  metadata = null
}) {
  const db = getDb();
  const now = new Date();
  await db.insert(memberLedgerEntries).values({
    accountId: Number(accountId),
    userId: Number(userId),
    entryType: String(entryType || "").trim(),
    amountCents: Number(amountCents || 0),
    effectiveDate,
    referenceType,
    referenceId,
    description,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
    createdAt: now,
    updatedAt: now
  });
}

export async function sumAccountBalance(userId, accountType) {
  const [rows] = await getPool().query(
    `
      SELECT COALESCE(SUM(e.amount_cents), 0) AS total
      FROM member_ledger_entries e
      JOIN member_ledger_accounts a ON a.id = e.account_id
      WHERE a.user_id = ?
        AND a.account_type = ?
    `,
    [Number(userId), accountType]
  );
  return Number(rows[0]?.total || 0);
}

export async function listRecentLedgerEntries(userId, limit = 50, db = getDb()) {
  const [rows] = await getPool().query(
    `
      SELECT
        e.*,
        a.account_type AS account_type
      FROM member_ledger_entries e
      JOIN member_ledger_accounts a ON a.id = e.account_id
      WHERE e.user_id = ?
      ORDER BY e.effective_date DESC, e.id DESC
      LIMIT ?
    `,
    [Number(userId), Number(limit)]
  );

  return rows.map((row) => {
    let metadata = null;
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json);
      } catch (_error) {
        metadata = null;
      }
    }
    return {
      id: row.id,
      accountId: row.account_id,
      userId: row.user_id,
      entryType: row.entry_type,
      amountCents: Number(row.amount_cents || 0),
      effectiveDate: row.effective_date,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      description: row.description,
      metadataJson: row.metadata_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountType: row.account_type,
      metadata
    };
  });
}

export async function ledgerReferenceExists(userId, referenceType, referenceId) {
  const [rows] = await getPool().query(
    `
      SELECT id
      FROM member_ledger_entries
      WHERE user_id = ?
        AND reference_type = ?
        AND reference_id = ?
      LIMIT 1
    `,
    [Number(userId), referenceType, String(referenceId || "")]
  );
  return rows.length > 0;
}

export async function getPrimaryExternalLink(userId, provider, db = getDb()) {
  const rows = await db
    .select()
    .from(memberExternalAccountLinks)
    .where(eq(memberExternalAccountLinks.userId, Number(userId)))
    .orderBy(desc(memberExternalAccountLinks.id));
  return rows.find((row) => row.provider === provider) || null;
}

export async function getCreditMirrorForLink(externalLinkId, db = getDb()) {
  const rows = await db
    .select()
    .from(memberCreditMirrors)
    .where(eq(memberCreditMirrors.externalLinkId, Number(externalLinkId)))
    .limit(1);
  return rows[0] || null;
}

export async function buildMemberPortalSummary(userId) {
  const db = getDb();
  const [user, profile, subscription, herdshare, settings] = await Promise.all([
    getUserById(userId, db),
    getMemberProfileByUserId(userId, db),
    getMemberSubscriptionByUserId(userId, db),
    getMemberHerdshareStatusByUserId(userId, db),
    loadSubscriptionSettings(db)
  ]);

  const [{ wallet, dividendReserve }, entries, locallineLink] = await Promise.all([
    ensureMemberLedgerAccounts(userId, db),
    listRecentLedgerEntries(userId, 50, db),
    getPrimaryExternalLink(userId, "localline", db)
  ]);

  const [walletBalanceCents, dividendAccruedCents, totalDepositedCents, totalSpentCents] =
    await Promise.all([
      sumAccountBalance(userId, wallet.accountType),
      sumAccountBalance(userId, dividendReserve.accountType),
      sumByEntryType(userId, ["subscription_deposit", "dividend_credit"]),
      sumByEntryType(userId, ["purchase_debit", "herdshare_charge"])
    ]);

  const creditMirror = locallineLink
    ? await getCreditMirrorForLink(locallineLink.id, db)
    : null;

  const decoratedEntries = decorateLedgerEntries(dedupeLedgerEntries(entries), {
    walletBalanceCents,
    dividendAccruedCents,
    externalActivityBalanceCents: Number.isFinite(Number(creditMirror?.lastLedgerImportedBalanceCents))
      ? Number(creditMirror.lastLedgerImportedBalanceCents)
      : null
  });

  const localLineSetupStatus =
    locallineLink?.externalCustomerId
      ? "connected"
      : profile?.localLineSetupStatus || "not_connected";

  return {
    user: user
      ? {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name
        }
      : null,
    profile,
    subscription: subscription
      ? {
          ...subscription,
          planLabel: getPlanDefinition(subscription.planKey)?.label || subscription.planKey
        }
      : null,
    herdshare,
    settings: {
      dividendRatePercent: Number(settings.dividendRatePercent || 3),
      herdshareMonthlyFeeCents: Number(settings.herdshareMonthlyFeeCents || 500)
    },
    wallet: {
      availableBalanceCents: walletBalanceCents,
      totalReceivedCents: totalDepositedCents,
      totalSpentCents: Math.abs(totalSpentCents)
    },
    dividends: {
      accruedCents: dividendAccruedCents,
      ratePercent: Number(settings.dividendRatePercent || 3)
    },
    localline: {
      link: locallineLink,
      mirror: creditMirror,
      importStatus: creditMirror
        ? {
            lastLedgerImportAt: creditMirror.lastLedgerImportAt || null,
            lastLedgerImportedTransactionId: creditMirror.lastLedgerImportedTransactionId || null,
            lastLedgerImportedTransactionAt: creditMirror.lastLedgerImportedTransactionAt || null,
            lastLedgerImportedBalanceCents: Number.isFinite(Number(creditMirror.lastLedgerImportedBalanceCents))
              ? Number(creditMirror.lastLedgerImportedBalanceCents)
              : null,
            ledgerBackfillCompleted: Boolean(creditMirror.ledgerBackfillCompleted),
            lastLedgerImportError: creditMirror.lastLedgerImportError || null
          }
        : null,
      setupStatus: localLineSetupStatus,
      setupMode: profile?.localLineSetupMode || null,
      setupNote: profile?.localLineSetupNote || null
    },
    entries: decoratedEntries
  };
}

function dedupeLedgerEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (
      entry.referenceType === "localline_credit_transaction" &&
      entry.referenceId
    ) {
      const key = `${entry.referenceType}:${entry.referenceId}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

function decorateLedgerEntries(entries, {
  walletBalanceCents = 0,
  dividendAccruedCents = 0,
  externalActivityBalanceCents = null
} = {}) {
  let walletCursor = Number(walletBalanceCents || 0);
  let dividendCursor = Number(dividendAccruedCents || 0);
  let externalCursor =
    Number.isFinite(Number(externalActivityBalanceCents)) && Number(externalActivityBalanceCents) !== 0
      ? Number(externalActivityBalanceCents)
      : null;

  return entries.map((entry) => {
    let runningBalanceCents = null;

    if (entry.accountType === "wallet") {
      runningBalanceCents = walletCursor;
      walletCursor -= Number(entry.amountCents || 0);
    } else if (entry.accountType === "dividend_reserve") {
      runningBalanceCents = dividendCursor;
      dividendCursor -= Number(entry.amountCents || 0);
    } else if (entry.accountType === "external_activity") {
      if (externalCursor === null) {
        const remoteBalance = Number(
          entry?.metadata?.store_credit_balance ??
            entry?.metadata?.storeCreditBalance ??
            NaN
        );
        if (Number.isFinite(remoteBalance)) {
          externalCursor = Math.round(remoteBalance * 100);
        }
      }
      if (externalCursor !== null) {
        runningBalanceCents = externalCursor;
        externalCursor -= Number(entry.amountCents || 0);
      }
    }

    return {
      ...entry,
      runningBalanceCents
    };
  });
}

export async function sumByEntryType(userId, entryTypes = []) {
  const values = Array.isArray(entryTypes) ? entryTypes.filter(Boolean) : [];
  if (!values.length) return 0;
  const placeholders = values.map(() => "?").join(", ");
  const [rows] = await getPool().query(
    `
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM member_ledger_entries
      WHERE user_id = ?
        AND entry_type IN (${placeholders})
    `,
    [Number(userId), ...values]
  );
  return Number(rows[0]?.total || 0);
}

export async function ensureLocalLineMirror(userId, externalLinkId, provider = "localline", db = getDb()) {
  const existing = await db
    .select()
    .from(memberCreditMirrors)
    .where(eq(memberCreditMirrors.externalLinkId, Number(externalLinkId)))
    .limit(1);
  if (existing[0]) return existing[0];

  const now = new Date();
  const result = await db.insert(memberCreditMirrors).values({
    externalLinkId: Number(externalLinkId),
    userId: Number(userId),
    provider,
    lastKnownBalanceCents: 0,
    createdAt: now,
    updatedAt: now
  });
  return {
    id: Number(result[0]?.insertId),
    externalLinkId: Number(externalLinkId),
    userId: Number(userId),
    provider,
    lastKnownBalanceCents: 0,
    createdAt: now,
    updatedAt: now
  };
}
