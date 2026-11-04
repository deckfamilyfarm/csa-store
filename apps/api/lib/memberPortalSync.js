import { requireVerifiedLocalLineLink } from './memberExternalLinks.js';
import { reconcileMemberOrder } from './memberOrderReconciliation.js';
import { runMemberBilling } from './memberBilling.js';
import { processLocalLineEventTransfers } from './memberCreditTransfers.js';
import { financialError } from './memberFinancialSchema.js';
import { and, desc, eq, lte } from "drizzle-orm";
import { getDb, getPool } from "../db.js";
import { getLocalLineAccessToken, getLocalLineBaseUrl, isLocalLineAuthConfigured } from "../localLineAuth.js";
import {
  localLineOrders,
  memberCreditMirrors,
  memberExternalAccountLinks,
  memberHerdshareStatuses,
  memberSubscriptions
} from "../schema.js";
import {
  createLedgerEntry,
  ensureLocalLineMirror,
  ensureMemberLedgerAccounts,
  getMemberProfileByUserId,
  getUserById,
  ledgerReferenceExists,
  loadSubscriptionSettings,
  sumAccountBalance
} from "./memberPortal.js";

function normalizeExternalCustomerId(value) {
  const stringValue = String(value || "").trim();
  if (!stringValue) return null;
  const numeric = Number.parseInt(stringValue, 10);
  return Number.isFinite(numeric) ? numeric : stringValue;
}

function toCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function normalizeRemoteTransactionId(transaction) {
  const value = transaction?.id ?? transaction?.uuid ?? transaction?.reference ?? null;
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function getRemoteTransactionDate(transaction) {
  const raw =
    transaction?.created_at ||
    transaction?.createdAt ||
    transaction?.transaction_date ||
    transaction?.transactionDate ||
    transaction?.effective_date ||
    transaction?.effectiveDate ||
    null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRemoteTransactionType(transaction) {
  return String(
    transaction?.transaction_type ||
      transaction?.transactionType ||
      transaction?.type ||
      "activity"
  ).trim();
}

function getRemoteTransactionDescription(transaction) {
  const type = getRemoteTransactionType(transaction).replace(/_/g, " ");
  const note = String(transaction?.note || transaction?.description || "").trim();
  return note ? `Imported from Local Line: ${type} — ${note}` : `Imported from Local Line: ${type}`;
}

function getRemoteTransactionAmountCents(transaction) {
  const numeric = Number(
    transaction?.amount ??
      transaction?.amount_total ??
      transaction?.amountTotal ??
      0
  );
  if (!Number.isFinite(numeric) || numeric === 0) return 0;
  return Math.round(numeric * 100);
}

function getRemoteTransactionBalanceCents(transaction) {
  const numeric = Number(
    transaction?.store_credit_balance ??
      transaction?.storeCreditBalance ??
      transaction?.balance ??
      transaction?.current_balance ??
      transaction?.currentBalance ??
      NaN
  );
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function resolveImportedTransactionDeltaCents(transaction, previousBalanceCents = null) {
  const type = getRemoteTransactionType(transaction).toUpperCase();
  const rawAmountCents = getRemoteTransactionAmountCents(transaction);
  const remoteBalanceCents = getRemoteTransactionBalanceCents(transaction);

  if (type.includes("SET") && remoteBalanceCents !== null) {
    if (Number.isFinite(previousBalanceCents)) {
      return remoteBalanceCents - Number(previousBalanceCents);
    }
    return remoteBalanceCents;
  }

  if (!rawAmountCents && remoteBalanceCents !== null && Number.isFinite(previousBalanceCents)) {
    return remoteBalanceCents - Number(previousBalanceCents);
  }

  return rawAmountCents;
}

function shouldSkipImportedRemoteTransaction(transaction) {
  const type = getRemoteTransactionType(transaction).toUpperCase();
  const note = String(transaction?.note || transaction?.description || "").toLowerCase();
  if (note.includes("csa store member credit sync")) return true;
  if (note.includes("csa store purchase debit sync reconciliation")) return true;
  if (type.includes("ORDER")) return true;
  if (type.includes("PURCHASE")) return true;
  return false;
}

function shouldSyncOrder(order) {
  const status = String(order?.status || "").trim().toUpperCase();
  const paymentStatus = String(order?.paymentStatus || "").trim().toUpperCase();
  const allowedStatus = status === "OPEN" || status === "DRAFT" || status === "";
  const allowedPayment = paymentStatus === "PAID" || paymentStatus === "";
  return allowedStatus && allowedPayment;
}

async function fetchRemoteStoreCreditTransactions(externalCustomerId, page = 1, pageSize = 25) {
  if (!isLocalLineAuthConfigured()) {
    throw new Error("Local Line auth is not configured.");
  }
  const token = await getLocalLineAccessToken();
  const base = getLocalLineBaseUrl();
  const url = `${base}customers/${externalCustomerId}/store-credit-transaction/?page=${page}&page_size=${pageSize}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (_error) {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Local Line credit fetch failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function fetchAllRemoteStoreCreditTransactions(externalCustomerId, {
  fullHistory = false,
  pageSize = 100,
  latestImportedAt = null
} = {}) {
  const collected = [];
  const latestImportedTime = latestImportedAt ? new Date(latestImportedAt).getTime() : null;
  let page = 1;
  let keepGoing = true;
  let safety = 0;

  while (keepGoing && safety < 100) {
    safety += 1;
    const payload = await fetchRemoteStoreCreditTransactions(externalCustomerId, page, pageSize);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (!results.length) break;
    collected.push(...results);

    if (!fullHistory && latestImportedTime) {
      const hasOnlyOlderRows = results.every((transaction) => {
        const transactionDate = getRemoteTransactionDate(transaction);
        if (!transactionDate) return false;
        return transactionDate.getTime() <= latestImportedTime;
      });
      if (hasOnlyOlderRows) {
        break;
      }
    }

    const totalCount = Number(payload?.count || 0);
    const hasNext = Boolean(payload?.next);
    if (hasNext) {
      page += 1;
      continue;
    }
    if (totalCount > 0 && page * pageSize < totalCount) {
      page += 1;
      continue;
    }
    if (results.length === pageSize && totalCount === 0) {
      page += 1;
      continue;
    }
    keepGoing = false;
  }

  if (keepGoing && safety >= 100) throw new Error('Local Line credit history was truncated; no transfer is authorized.');
  return collected;
}

export async function importMemberLocalLineLedgerActivity({ userId = null, dryRun = false } = {}) {
  const db = getDb();
  const links = userId
    ? await db
        .select()
        .from(memberExternalAccountLinks)
        .where(
          and(
            eq(memberExternalAccountLinks.provider, "localline"),
            eq(memberExternalAccountLinks.userId, Number(userId))
          )
        )
    : await db
        .select()
        .from(memberExternalAccountLinks)
        .where(eq(memberExternalAccountLinks.provider, "localline"));

  const results = [];
  for (const link of links) {
    const mirror = await ensureLocalLineMirror(link.userId, link.id, "localline", db);
    try {
      await requireVerifiedLocalLineLink(link,link.userId);
      const accounts = await ensureMemberLedgerAccounts(link.userId, db);
      const fullHistory = !Boolean(mirror.ledgerBackfillCompleted);
      const remoteTransactions = await fetchAllRemoteStoreCreditTransactions(link.externalCustomerId, {
        fullHistory,
        latestImportedAt: mirror.lastLedgerImportedTransactionAt || null
      });

      const orderedTransactions = remoteTransactions
        .slice()
        .sort((left, right) => {
          const leftDate = getRemoteTransactionDate(left)?.getTime() || 0;
          const rightDate = getRemoteTransactionDate(right)?.getTime() || 0;
          return leftDate - rightDate;
        });
      const latestRemoteTransaction = orderedTransactions[orderedTransactions.length - 1] || null;

      let importedCount = 0;
      let skippedCount = 0;
      let newestImportedId = mirror.lastLedgerImportedTransactionId || null;
      let newestImportedAt = mirror.lastLedgerImportedTransactionAt || null;
      let newestImportedBalanceCents =
        Number.isFinite(Number(mirror.lastLedgerImportedBalanceCents))
          ? Number(mirror.lastLedgerImportedBalanceCents)
          : null;
      let previousBalanceCents = newestImportedBalanceCents;

      if (fullHistory) {
        previousBalanceCents = null;
      }

      for (const transaction of orderedTransactions) {
        const remoteId = normalizeRemoteTransactionId(transaction);
        if (!remoteId) {
          skippedCount += 1;
          continue;
        }
        if (shouldSkipImportedRemoteTransaction(transaction)) {
          skippedCount += 1;
          continue;
        }

        const referenceType = "localline_credit_transaction";
        const referenceId = `credit:${remoteId}`;
        if (await ledgerReferenceExists(link.userId, referenceType, referenceId)) {
          skippedCount += 1;
          continue;
        }

        const amountCents = resolveImportedTransactionDeltaCents(transaction, previousBalanceCents);
        const remoteBalanceCents = getRemoteTransactionBalanceCents(transaction);
        if (!amountCents) {
          if (remoteBalanceCents !== null) {
            previousBalanceCents = remoteBalanceCents;
            newestImportedBalanceCents = remoteBalanceCents;
          }
          skippedCount += 1;
          continue;
        }

        const effectiveDate = getRemoteTransactionDate(transaction) || new Date();
        const entryType = amountCents >= 0 ? "localline_credit_import" : "localline_debit_import";

        if (!dryRun) {
          try {
            await createLedgerEntry({
              accountId: accounts.externalActivity.id,
              userId: link.userId,
              entryType,
              amountCents,
              effectiveDate,
              referenceType,
              referenceId,
              description: getRemoteTransactionDescription(transaction),
              metadata: transaction
            });
          } catch (error) {
            if (error?.code === "ER_DUP_ENTRY") {
              skippedCount += 1;
              if (remoteBalanceCents !== null) {
                previousBalanceCents = remoteBalanceCents;
                newestImportedBalanceCents = remoteBalanceCents;
              }
              continue;
            }
            throw error;
          }
        }

        importedCount += 1;
        newestImportedId = remoteId;
        newestImportedAt = effectiveDate;
        if (remoteBalanceCents !== null) {
          newestImportedBalanceCents = remoteBalanceCents;
          previousBalanceCents = remoteBalanceCents;
        } else if (Number.isFinite(previousBalanceCents)) {
          previousBalanceCents = Number(previousBalanceCents) + amountCents;
          newestImportedBalanceCents = previousBalanceCents;
        } else {
          previousBalanceCents = amountCents;
          newestImportedBalanceCents = previousBalanceCents;
        }
      }

      if (
        latestRemoteTransaction &&
        (!Number.isFinite(Number(newestImportedBalanceCents)) || Number(newestImportedBalanceCents) === 0)
      ) {
        const latestRemoteBalanceCents = getRemoteTransactionBalanceCents(latestRemoteTransaction);
        if (latestRemoteBalanceCents !== null) {
          newestImportedBalanceCents = latestRemoteBalanceCents;
        }
      }

      const now = new Date();
      if (!dryRun) {
        await db
          .update(memberCreditMirrors)
          .set({
            lastLedgerImportAt: now,
            lastLedgerImportedTransactionId: newestImportedId,
            lastLedgerImportedTransactionAt: newestImportedAt,
            lastLedgerImportedBalanceCents: newestImportedBalanceCents,
            ledgerBackfillCompleted: 1,
            lastLedgerImportError: null,
            updatedAt: now
          })
          .where(eq(memberCreditMirrors.id, mirror.id));
      }

      results.push({
        userId: link.userId,
        externalCustomerId: link.externalCustomerId,
        fullHistory,
        fetchedCount: orderedTransactions.length,
        importedCount,
        skippedCount,
        newestImportedId,
        newestImportedAt,
        ok: true
      });
    } catch (error) {
      if (!dryRun) {
        await db
          .update(memberCreditMirrors)
          .set({
            lastLedgerImportAt: new Date(),
            lastLedgerImportError: error?.message || "Unable to import Local Line ledger activity.",
            updatedAt: new Date()
          })
          .where(eq(memberCreditMirrors.id, mirror.id));
      }
      results.push({
        userId: link.userId,
        externalCustomerId: link.externalCustomerId,
        ok: false,
        error: error?.message || "Unable to import Local Line ledger activity."
      });
    }
  }

  return {
    ok: true,
    dryRun,
    count: results.length,
    results
  };
}

async function postLocalLineStoreCreditTransaction({
  externalCustomerId,
  amountCents,
  transactionType,
  note
}) {
  if (!isLocalLineAuthConfigured()) {
    throw new Error("Local Line auth is not configured.");
  }
  const token = await getLocalLineAccessToken();
  const base = getLocalLineBaseUrl();
  const url = `${base}customers/${externalCustomerId}/store-credit-transaction/`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: Math.abs(amountCents) / 100,
      transaction_type: transactionType,
      note: note || "CSA Store member portal credit sync"
    })
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (_error) {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Local Line credit post failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

export async function listMemberLocalLineCreditStatus({
  userId = null,
  includeRemote = true
} = {}) {
  const db = getDb();
  const links = userId
    ? await db
        .select()
        .from(memberExternalAccountLinks)
        .where(
          and(
            eq(memberExternalAccountLinks.provider, "localline"),
            eq(memberExternalAccountLinks.userId, Number(userId))
          )
        )
    : await db
        .select()
        .from(memberExternalAccountLinks)
        .where(eq(memberExternalAccountLinks.provider, "localline"));

  const rows = [];
  for (const link of links) {
    const [user, profile] = await Promise.all([
      getUserById(link.userId, db),
      getMemberProfileByUserId(link.userId, db)
    ]);
    const externalCustomerId = normalizeExternalCustomerId(link.externalCustomerId);
    const mirror = await ensureLocalLineMirror(link.userId, link.id, "localline", db);
    const walletBalanceCents = await sumAccountBalance(link.userId, "wallet");
    const linkedOrders = await db
      .select()
      .from(localLineOrders)
      .where(eq(localLineOrders.customerId, Number(externalCustomerId)))
      .orderBy(desc(localLineOrders.fulfillmentDate), desc(localLineOrders.id));
    const syncableOrders = linkedOrders.filter((order) => shouldSyncOrder(order));

    const row = {
      userId: link.userId,
      memberName:
        String(profile?.displayName || "").trim() ||
        String(user?.name || "").trim() ||
        String(user?.username || "").trim() ||
        null,
      username: user?.username || null,
      email: user?.email || null,
      externalCustomerId,
      externalEmail: link.externalEmail || null,
      walletBalanceCents,
      mirroredBalanceCents: Number(mirror.lastKnownBalanceCents || 0),
      remoteBalanceCents: null,
      deltaFromMirrorCents: walletBalanceCents - Number(mirror.lastKnownBalanceCents || 0),
      deltaFromRemoteCents: null,
      linkedOrderCount: linkedOrders.length,
      syncableOrderCount: syncableOrders.length,
      lastMirroredAt: mirror.lastMirroredAt || null,
      lastOrderSyncedAt: mirror.lastOrderSyncedAt || null,
      remoteError: null
    };

    if (includeRemote) {
      try {
        await requireVerifiedLocalLineLink(link,link.userId);
        const remoteTransactions = await fetchRemoteStoreCreditTransactions(externalCustomerId, 1, 1);
        const remoteBalance =
          Number(
            remoteTransactions?.results?.[0]?.store_credit_balance ??
              remoteTransactions?.results?.[0]?.storeCreditBalance
          );
        if (Number.isFinite(remoteBalance)) {
          row.remoteBalanceCents = Math.round(remoteBalance * 100);
          row.deltaFromRemoteCents = walletBalanceCents - row.remoteBalanceCents;
        }
      } catch (error) {
        row.remoteError = error?.message || "Unable to fetch remote Local Line balance.";
      }
    }

    rows.push(row);
  }

  rows.sort((left, right) => {
    const leftName = String(left.memberName || left.email || "").toLowerCase();
    const rightName = String(right.memberName || right.email || "").toLowerCase();
    return leftName.localeCompare(rightName) || Number(left.userId || 0) - Number(right.userId || 0);
  });

  return {
    ok: true,
    includeRemote,
    localLineAuthConfigured: isLocalLineAuthConfigured(),
    count: rows.length,
    rows
  };
}

// Compatibility name: event transfers only. Never align total balances.
export async function syncMemberLocalLineCredits(options = {}) {
  return processLocalLineEventTransfers({...options,fetchTransactions:fetchAllRemoteStoreCreditTransactions,postTransaction:postLocalLineStoreCreditTransaction});
}

export async function syncMemberLocalLinePurchaseDebits({userId=null,dryRun=false}={}) {
  const db=getDb(),settings=await loadSubscriptionSettings(db);
  const links=await db.select().from(memberExternalAccountLinks).where(eq(memberExternalAccountLinks.provider,'localline'));
  const results=[];
  for(const link of links.filter(row=>!userId || Number(row.userId)===Number(userId))) {
    try {
      await requireVerifiedLocalLineLink(link,link.userId);
      const orders=await db.select().from(localLineOrders).where(eq(localLineOrders.customerId,Number(link.externalCustomerId)));
      for(const order of orders) {
        try {results.push({userId:link.userId,...await reconcileMemberOrder({link,order,dividendRateBp:Math.round(Number(settings.dividendRatePercent ?? 3)*100),dryRun})});}
        catch(e){results.push({userId:link.userId,orderId:order.localLineOrderId,held:true,error:e.message});}
      }
    }catch(e){results.push({userId:link.userId,held:true,error:e.message});}
  }
  return {ok:!results.some(row=>row.held),dryRun,count:results.length,results};
}

// Refunds with an ambiguous order snapshot require an explicit staff review of
// actual provider transactions. Never infer money returned from cancellation.
export async function reconcileMemberLocalLineOrderRefund({userId,orderId,transactionIds,dryRun=true}) {
  if(!Array.isArray(transactionIds) || !transactionIds.length || new Set(transactionIds.map(String)).size!==transactionIds.length)throw financialError('Choose distinct Local Line refund transaction IDs.',400);
  const db=getDb();
  const links=await db.select().from(memberExternalAccountLinks).where(eq(memberExternalAccountLinks.userId,Number(userId)));
  const link=links.find(row=>row.provider==='localline');
  await requireVerifiedLocalLineLink(link,userId);
  const orders=await db.select().from(localLineOrders).where(eq(localLineOrders.localLineOrderId,Number(orderId)));
  const order=orders[0];
  if(!order || String(order.customerId)!==String(link.externalCustomerId))throw financialError('Order does not belong to the verified Local Line customer.',403);
  const history=await fetchAllRemoteStoreCreditTransactions(link.externalCustomerId,{fullHistory:true});
  const selected=transactionIds.map(id=>history.find(row=>String(row.id)===String(id)));
  if(selected.some(row=>!row || String(row.order_id ?? row.order?.id ?? row.order)!==String(orderId) ||
    !['ORDER_CREDIT','ORDER_REFUND','MANUAL_CREDIT'].includes(String(row.transaction_type || '')) || !(Number(row.amount)>0)))throw financialError('Each refund needs a positive credit transaction explicitly linked to this order. Unsupported or missing provider evidence is held.');
  const cumulativeRefundCents=selected.reduce((total,row)=>total+Math.round(Number(row.amount)*100),0);
  const settings=await loadSubscriptionSettings(db);
  return reconcileMemberOrder({link,order,dividendRateBp:Math.round(Number(settings.dividendRatePercent ?? 3)*100),dryRun,
    refundEvidence:{transactionIds:transactionIds.map(String).sort(),cumulativeRefundCents}},getPool());
}

export async function processPausedMemberHerdshareBilling({userId=null,dryRun=false}={}) {
  const db=getDb(),{getStripeClient}=await import('./memberPortal.js'),stripe=getStripeClient();
  const rows=await db.select({subscription:memberSubscriptions,herdshare:memberHerdshareStatuses}).from(memberSubscriptions)
    .innerJoin(memberHerdshareStatuses,eq(memberHerdshareStatuses.userId,memberSubscriptions.userId))
    .where(and(eq(memberSubscriptions.status,'paused'),lte(memberHerdshareStatuses.nextBillingDate,new Date()),eq(memberHerdshareStatuses.status,'active')));
  const results=[];
  for(const {subscription,herdshare} of rows.filter(row=>!userId || Number(row.subscription.userId)===Number(userId))) {
    const period=new Date(herdshare.nextBillingDate).toISOString().slice(0,10);
    try {
      results.push(dryRun?{userId:subscription.userId,period,feeCents:herdshare.monthlyFeeCents,dryRun}:await runMemberBilling({userId:subscription.userId,kind:'paused_fee',requestKey:`paused-fee:${period}`,input:{period},stripe}));
    }catch(e){results.push({userId:subscription.userId,held:true,error:e.message,operationId:e.operationId});}
  }
  return {ok:!results.some(row=>row.held),dryRun,count:results.length,results};
}
