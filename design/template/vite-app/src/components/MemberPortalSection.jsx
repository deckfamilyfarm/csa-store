import React, { useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { DeckPageHeader } from "./DeckPageHeader.jsx";
import {
  cancelMemberSubscription,
  createMemberSetupIntent,
  deleteMemberPaymentMethod,
  fetchMemberLocalLineCredit,
  fetchMemberLocalLineCustomer,
  fetchMemberPortal,
  importMemberLocalLineLedger,
  loginMemberLocalLine,
  pauseMemberSubscription,
  requestPasswordReset,
  requestMemberLocalLineCreate,
  resumeMemberSubscription,
  saveMemberLocalLineLink,
  setMemberPaymentMethodDefault,
  updateMemberSubscription
} from "../api.js";

function formatMoney(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString();
}

function formatEntryLabel(entryType) {
  const normalized = String(entryType || "").trim().toLowerCase();
  if (normalized === "localline_credit_import") return "Local Line credit";
  if (normalized === "localline_debit_import") return "Local Line debit";
  return String(entryType || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLocalLineMethod(value) {
  return String(value || "")
    .trim()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatLocalLineStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "connected") return "Connected";
  if (normalized === "pending_create") return "Pending setup";
  if (normalized === "manual_help") return "Needs manual help";
  return "Not connected";
}

function formatLocalLineDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function getLocalLineTransactionAmount(transaction) {
  const amount = Number(
    transaction?.amount ??
      transaction?.amount_total ??
      transaction?.amountTotal ??
      0
  );
  if (!Number.isFinite(amount)) return "$0.00";
  return `$${Math.abs(amount).toFixed(2)}`;
}

function getLocalLineTransactionLabel(transaction) {
  return (
    transaction?.transaction_type ||
    transaction?.transactionType ||
    transaction?.type ||
    "Activity"
  );
}

function formatAccountHolder(portal, fallbackUser) {
  const firstName = String(portal?.profile?.firstName || "").trim();
  const lastName = String(portal?.profile?.lastName || "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return fullName || portal?.user?.name || fallbackUser?.name || "Account holder";
}

function getLedgerEntryMethod(entry) {
  if (entry?.referenceType !== "localline_credit_transaction") return "";
  return (
    entry?.metadata?.transaction_type ||
    entry?.metadata?.transactionType ||
    ""
  );
}

function getLedgerEntryNote(entry) {
  if (entry?.referenceType !== "localline_credit_transaction") return "";
  return String(entry?.metadata?.note || entry?.metadata?.description || "").trim();
}

function memberPortalStoreUrl() {
  return "https://fullfarmcsa.deckfamilyfarm.com/";
}

function PaymentSetupForm({ token, onSaved }) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setSaving(true);
    setError("");
    try {
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required"
      });
      if (result.error) {
        throw new Error(result.error.message || "Unable to save payment method.");
      }
      const paymentMethodId = result.setupIntent?.payment_method;
      if (typeof paymentMethodId !== "string" || !paymentMethodId) {
        throw new Error("Stripe did not return a saved payment method.");
      }
      await setMemberPaymentMethodDefault(token, paymentMethodId);
      onSaved?.();
    } catch (nextError) {
      setError(nextError?.message || "Unable to save payment method.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="member-portal-payment-form" onSubmit={handleSubmit}>
      <div className="member-portal-payment-element">
        <PaymentElement />
      </div>
      {error ? <div className="small member-portal-error">{error}</div> : null}
      <button className="button" type="submit" disabled={saving || !stripe || !elements}>
        {saving ? "Saving..." : "Save payment method"}
      </button>
    </form>
  );
}

export function MemberPortalSection({
  token,
  user,
  onLogout,
  subscribeUrl = "",
  adminUrl = "",
  canAccessAdmin = false
}) {
  const [portal, setPortal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [localLineFeedback, setLocalLineFeedback] = useState({ message: "", error: "" });
  const [busyAction, setBusyAction] = useState("");
  const [setupClientSecret, setSetupClientSecret] = useState("");
  const [localLineChoice, setLocalLineChoice] = useState("choose");
  const [localLineForm, setLocalLineForm] = useState({ externalCustomerId: "", externalEmail: user?.email || "" });
  const [localLineLoginForm, setLocalLineLoginForm] = useState({ email: user?.email || "", password: "" });
  const [localLineCustomer, setLocalLineCustomer] = useState(null);
  const [localLineCredit, setLocalLineCredit] = useState(null);
  const [localLineActivityUpdatedAt, setLocalLineActivityUpdatedAt] = useState("");
  const stripePromise = useMemo(() => {
    const key = import.meta.env.VITE_STRIPE_PK || import.meta.env.VITE_STRIPE_PUBLIC_KEY;
    return key ? loadStripe(key) : null;
  }, []);
  const portalBaseHref = useMemo(() => {
    return String(subscribeUrl || memberPortalStoreUrl()).replace(/#.*$/, "").replace(/\/+$/, "");
  }, [subscribeUrl]);
  const subscribeRouteUrl = useMemo(() => `${portalBaseHref}#/subscribe`, [portalBaseHref]);
  const portalAccountUrl = useMemo(() => `${portalBaseHref}#/account`, [portalBaseHref]);
  const portalNavLinks = useMemo(
    () => [
      { label: "Home", href: "https://www.deckfamilyfarm.com/" },
      { label: "Subscribe", href: subscribeRouteUrl },
      { label: "Member Portal", href: portalAccountUrl },
      { label: "Shop", href: memberPortalStoreUrl() }
    ],
    [portalAccountUrl, subscribeRouteUrl]
  );

  const subscriptionForm = useMemo(
    () => ({
      planKey: portal?.subscription?.planKey || "forager",
      billingDayOfMonth: portal?.subscription?.billingDayOfMonth || 1
    }),
    [portal]
  );
  const [pendingPlanKey, setPendingPlanKey] = useState("forager");
  const [pendingBillingDay, setPendingBillingDay] = useState(1);
  const localLineConnected = Boolean(portal?.localline?.link?.externalCustomerId);
  const mirroredLocalLineBalanceCents = Number(portal?.localline?.mirror?.lastKnownBalanceCents || 0);
  const hasRemoteLocalLineBalance = localLineCredit?.results?.length
    ? Number.isFinite(
        Number(
          localLineCredit.results[0]?.store_credit_balance ??
            localLineCredit.results[0]?.storeCreditBalance
        )
      )
    : false;
  const remoteLocalLineBalanceCents = hasRemoteLocalLineBalance
    ? Math.round(
        Number(
          localLineCredit.results[0]?.store_credit_balance ??
            localLineCredit.results[0]?.storeCreditBalance
        ) * 100
      )
    : null;
  const localLineSyncDeltaCents =
    remoteLocalLineBalanceCents === null ? null : remoteLocalLineBalanceCents - mirroredLocalLineBalanceCents;

  async function refreshLocalLineDetails(externalCustomerId = null) {
    const connectedCustomerId =
      externalCustomerId || portal?.localline?.link?.externalCustomerId || null;
    if (!connectedCustomerId) {
      setLocalLineCustomer(null);
      setLocalLineCredit(null);
      setLocalLineActivityUpdatedAt("");
      return;
    }

    const [customerResult, creditResult] = await Promise.allSettled([
      fetchMemberLocalLineCustomer(token),
      fetchMemberLocalLineCredit(token, 1, 10)
    ]);

    if (customerResult.status === "fulfilled") {
      setLocalLineCustomer(customerResult.value?.customer || null);
    } else {
      setLocalLineCustomer(null);
    }

    if (creditResult.status === "fulfilled") {
      setLocalLineCredit(creditResult.value?.credit || null);
      setLocalLineActivityUpdatedAt(new Date().toISOString());
    } else {
      setLocalLineCredit(null);
      setLocalLineActivityUpdatedAt("");
    }
  }

  async function loadPortal() {
    setLoading(true);
    setError("");
    try {
      let response = await fetchMemberPortal(token);
      if (response?.localline?.link?.externalCustomerId) {
        try {
          const importResponse = await importMemberLocalLineLedger(token);
          if (importResponse?.summary) {
            response = importResponse.summary;
          }
          const importSummary = importResponse?.importResult?.results?.[0] || null;
          if (importSummary?.importedCount > 0) {
            setLocalLineFeedback({
              message: `Imported ${importSummary.importedCount} Local Line ledger entr${importSummary.importedCount === 1 ? "y" : "ies"}.`,
              error: ""
            });
          }
        } catch (importError) {
          setLocalLineFeedback({
            message: "",
            error: importError?.message || "Unable to import Local Line ledger activity."
          });
        }
      }
      setPortal(response);
      setPendingPlanKey(response?.subscription?.planKey || "forager");
      setPendingBillingDay(response?.subscription?.billingDayOfMonth || 1);
      setLocalLineForm({
        externalCustomerId: response?.localline?.link?.externalCustomerId || "",
        externalEmail: response?.localline?.link?.externalEmail || user?.email || ""
      });
      setLocalLineLoginForm((current) => ({
        ...current,
        email: response?.localline?.link?.externalEmail || user?.email || current.email || ""
      }));
      if (response?.localline?.setupStatus === "pending_create") {
        setLocalLineChoice("create");
      } else if (response?.localline?.link?.externalCustomerId) {
        setLocalLineChoice("choose");
      }
      await refreshLocalLineDetails(response?.localline?.link?.externalCustomerId || null);
    } catch (nextError) {
      setError(nextError?.message || "Unable to load member portal.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSetupIntent() {
    if (!stripePromise) return;
    try {
      const response = await createMemberSetupIntent(token);
      setSetupClientSecret(response.clientSecret || "");
    } catch (nextError) {
      setError(nextError?.message || "Unable to initialize payment setup.");
    }
  }

  useEffect(() => {
    loadPortal();
  }, [token]);

  useEffect(() => {
    if (!loading && stripePromise) {
      refreshSetupIntent();
    }
  }, [loading, stripePromise]);

  async function runAction(actionKey, callback, successMessage) {
    setBusyAction(actionKey);
    setMessage("");
    setError("");
    try {
      const response = await callback();
      if (response?.user || response?.wallet || response?.subscription) {
        setPortal(response);
      } else {
        await loadPortal();
      }
      if (stripePromise) {
        await refreshSetupIntent();
      }
      setMessage(successMessage);
    } catch (nextError) {
      setError(nextError?.message || "Unable to complete that action.");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveSubscription(event) {
    event.preventDefault();
    await runAction(
      "subscription",
      () =>
        updateMemberSubscription(token, {
          planKey: pendingPlanKey,
          billingDayOfMonth: pendingBillingDay
        }),
      "Subscription settings updated."
    );
  }

  async function handleSaveLocalLine(event) {
    event.preventDefault();
    setLocalLineFeedback({ message: "", error: "" });
    try {
      await runAction(
        "localline",
        () => saveMemberLocalLineLink(token, localLineForm),
        "Local Line link saved."
      );
      setLocalLineFeedback({ message: "Local Line link saved.", error: "" });
    } catch (_error) {
      // runAction already sets top-level error
    }
  }

  async function handleLoginLocalLine(event) {
    event.preventDefault();
    setBusyAction("localline-login");
    setMessage("");
    setError("");
    setLocalLineFeedback({ message: "", error: "" });
    try {
      const response = await loginMemberLocalLine(token, localLineLoginForm);
      if (response?.customer) {
        setLocalLineCustomer(response.customer);
      }
      const summary = response?.summary || (await fetchMemberPortal(token));
      setPortal(summary);
      if (stripePromise) {
        await refreshSetupIntent();
      }
      const importSummary = response?.importResult?.results?.[0] || null;
      await refreshLocalLineDetails(summary?.localline?.link?.externalCustomerId || null);
      setMessage("Your Local Line shopping account is connected.");
      setLocalLineFeedback({
        message:
          importSummary?.importedCount > 0
            ? `Your Local Line shopping account is connected. Imported ${importSummary.importedCount} Local Line ledger entr${importSummary.importedCount === 1 ? "y" : "ies"}.`
            : "Your Local Line shopping account is connected.",
        error: ""
      });
    } catch (nextError) {
      const nextMessage =
        nextError?.message || "Unable to connect your Local Line account.";
      setError(nextMessage);
      setLocalLineFeedback({ message: "", error: nextMessage });
    } finally {
      setBusyAction("");
    }
    setLocalLineLoginForm((current) => ({
      ...current,
      password: ""
    }));
  }

  async function handleRequestLocalLineCreate(event) {
    event.preventDefault();
    setLocalLineFeedback({ message: "", error: "" });
    try {
      await runAction(
        "localline-create",
        () =>
          requestMemberLocalLineCreate(token, {
            email: localLineLoginForm.email || user?.email || ""
          }),
        "We saved your Local Line account setup request."
      );
      setLocalLineFeedback({ message: "We saved your Local Line account setup request.", error: "" });
    } catch (_error) {
      // runAction already sets top-level error
    }
  }

  async function handlePasswordResetRequest() {
    const username = portal?.user?.username || user?.username || "";
    if (!username) {
      setError("Unable to determine your username for password reset.");
      return;
    }
    await runAction(
      "password-reset",
      () => requestPasswordReset(username),
      `Password reset email sent for ${username}.`
    );
  }

  if (loading) {
    return (
      <section className="section">
        <div className="container">
          <div className="card pad">
            <div className="small">Loading member portal...</div>
          </div>
        </div>
      </section>
    );
  }

  const localLineSection = (
    <div className="card pad">
      <div className="eyebrow">Local Line bridge</div>
      <p className="small">
        CSA Store is the ledger source of truth. Local Line remains the temporary shopping
        surface. Keep a backup credit card on file in Local Line for purchases that go beyond
        your mirrored portal credit.
      </p>
      <div className="small">
        Status: <strong>{formatLocalLineStatus(portal?.localline?.setupStatus)}</strong>
      </div>
      {hasRemoteLocalLineBalance ? (
        <div className="small">
          Local Line credit balance: <strong>{formatMoney(remoteLocalLineBalanceCents)}</strong>
        </div>
      ) : (
        <div className="small">
          CSA mirrored Local Line credit: <strong>{formatMoney(mirroredLocalLineBalanceCents)}</strong>
        </div>
      )}
      {hasRemoteLocalLineBalance ? (
        localLineSyncDeltaCents === 0 ? (
          <div className="small">
            CSA mirror status: <strong>In sync</strong>
          </div>
        ) : (
          <>
            <div className="small">
              CSA mirror balance: <strong>{formatMoney(mirroredLocalLineBalanceCents)}</strong>
            </div>
            <div className="small">
              Sync gap: <strong>{formatMoney(localLineSyncDeltaCents)}</strong>
            </div>
          </>
        )
      ) : null}
      {portal?.localline?.importStatus?.lastLedgerImportAt ? (
        <div className="small">
          Ledger import checked:{" "}
          <strong>{formatLocalLineDate(portal.localline.importStatus.lastLedgerImportAt)}</strong>
        </div>
      ) : null}
      {portal?.localline?.importStatus?.ledgerBackfillCompleted ? (
        <div className="small">
          Local Line history import: <strong>Complete</strong>
        </div>
      ) : null}
      {portal?.localline?.importStatus?.lastLedgerImportError ? (
        <div className="small member-portal-error">
          Last ledger import error: {portal.localline.importStatus.lastLedgerImportError}
        </div>
      ) : null}
      {localLineFeedback.message ? (
        <div className="small member-portal-message">{localLineFeedback.message}</div>
      ) : null}
      {localLineFeedback.error ? (
        <div className="small member-portal-error">{localLineFeedback.error}</div>
      ) : null}
      {localLineConnected ? (
        <div className="member-portal-localline-status">
          <div className="small">
            Connected email: <strong>{portal?.localline?.link?.externalEmail || "Unknown"}</strong>
          </div>
          <div className="small">
            Local Line customer id:{" "}
            <strong>{portal?.localline?.link?.externalCustomerId || "Unknown"}</strong>
          </div>
          {localLineCustomer ? (
            <div className="small">
              Customer name:{" "}
              <strong>
                {localLineCustomer.name ||
                  localLineCustomer.business_name ||
                  [localLineCustomer.first_name, localLineCustomer.last_name]
                    .filter(Boolean)
                    .join(" ") ||
                  "Unknown"}
              </strong>
            </div>
          ) : null}
          {localLineCredit?.results?.length ? (
            <>
              <div className="small">
                Recent Local Line activity checked:{" "}
                <strong>{formatLocalLineDate(localLineActivityUpdatedAt)}</strong>
              </div>
              <div className="member-portal-localline-activity">
                <strong>Recent Local Line credit activity</strong>
                <div className="member-portal-localline-activity-list">
                  {localLineCredit.results.slice(0, 6).map((transaction, index) => (
                    <div
                      key={
                        transaction?.id ||
                        transaction?.uuid ||
                        `${transaction?.created_at || transaction?.createdAt || "entry"}-${index}`
                      }
                      className="member-portal-localline-activity-item"
                    >
                      <div className="small">
                        <strong>{getLocalLineTransactionLabel(transaction)}</strong>
                      </div>
                      <div className="small">
                        {getLocalLineTransactionAmount(transaction)}
                      </div>
                      <div className="small">
                        {transaction?.note || transaction?.description || "No note"}
                      </div>
                      <div className="small">
                        {formatLocalLineDate(transaction?.created_at || transaction?.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <div className="member-portal-choice-grid">
            <button
              className={`button ${localLineChoice === "existing" ? "" : "alt"}`}
              type="button"
              onClick={() => setLocalLineChoice("existing")}
            >
              Find my Local Line account
            </button>
            <button
              className={`button ${localLineChoice === "create" ? "" : "alt"}`}
              type="button"
              onClick={() => setLocalLineChoice("create")}
            >
              Create my Local Line account
            </button>
            <button
              className={`button ${localLineChoice === "manual" ? "" : "alt"}`}
              type="button"
              onClick={() => setLocalLineChoice("manual")}
            >
              Manual help
            </button>
          </div>

          {localLineChoice === "existing" ? (
            <form className="admin-form" onSubmit={handleLoginLocalLine}>
              <div className="small">
                Already shop in Local Line? Sign in once and we will connect the correct
                shopping account automatically.
              </div>
              <label className="filter-field">
                <span className="small">Local Line email or username</span>
                <input
                  className="input"
                  type="text"
                  value={localLineLoginForm.email}
                  onChange={(event) =>
                    setLocalLineLoginForm((current) => ({
                      ...current,
                      email: event.target.value
                    }))
                  }
                />
              </label>
              <label className="filter-field">
                <span className="small">Local Line password</span>
                <input
                  className="input"
                  type="password"
                  value={localLineLoginForm.password}
                  onChange={(event) =>
                    setLocalLineLoginForm((current) => ({
                      ...current,
                      password: event.target.value
                    }))
                  }
                />
              </label>
              <button
                className="button"
                type="submit"
                disabled={busyAction === "localline-login"}
              >
                {busyAction === "localline-login" ? "Connecting..." : "Connect my Local Line account"}
              </button>
            </form>
          ) : null}

          {localLineChoice === "create" ? (
            <form className="admin-form" onSubmit={handleRequestLocalLineCreate}>
              <div className="small">
                New to Local Line? We will mark your shopping account for setup using this
                email, and you can keep moving through the portal.
              </div>
              <label className="filter-field">
                <span className="small">Email for your shopping account</span>
                <input
                  className="input"
                  type="email"
                  value={localLineLoginForm.email}
                  onChange={(event) =>
                    setLocalLineLoginForm((current) => ({
                      ...current,
                      email: event.target.value
                    }))
                  }
                />
              </label>
              <button
                className="button"
                type="submit"
                disabled={busyAction === "localline-create"}
              >
                {busyAction === "localline-create" ? "Saving..." : "Save Local Line setup request"}
              </button>
              {portal?.localline?.setupNote ? (
                <div className="small">{portal.localline.setupNote}</div>
              ) : null}
            </form>
          ) : null}

          {localLineChoice === "manual" ? (
            <form className="admin-form" onSubmit={handleSaveLocalLine}>
              <div className="small">
                Use this only if you already know your Local Line customer id or farm staff
                asked you to enter it.
              </div>
              <label className="filter-field">
                <span className="small">Local Line customer id</span>
                <input
                  className="input"
                  value={localLineForm.externalCustomerId}
                  onChange={(event) =>
                    setLocalLineForm((current) => ({
                      ...current,
                      externalCustomerId: event.target.value
                    }))
                  }
                />
              </label>
              <label className="filter-field">
                <span className="small">Local Line email</span>
                <input
                  className="input"
                  type="email"
                  value={localLineForm.externalEmail}
                  onChange={(event) =>
                    setLocalLineForm((current) => ({
                      ...current,
                      externalEmail: event.target.value
                    }))
                  }
                />
              </label>
              <button className="button" type="submit" disabled={busyAction === "localline"}>
                {busyAction === "localline" ? "Saving..." : "Save manual Local Line link"}
              </button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );

  const accountSection = (
    <div className="card pad member-portal-account-card">
      <div className="eyebrow">Account</div>
      <h3>{formatAccountHolder(portal, user)}</h3>
      <div className="member-portal-account-list">
        <div className="small">
          Account username: <strong>{portal?.user?.username || user?.username || "Not set"}</strong>
        </div>
        <div className="small">
          Contact email: <strong>{portal?.user?.email || user?.email || "Not set"}</strong>
        </div>
        <div className="small">
          Member since: <strong>{formatDate(portal?.profile?.createdAt)}</strong>
        </div>
      </div>
      <button
        className="button alt member-portal-inline-button"
        type="button"
        disabled={busyAction === "password-reset"}
        onClick={handlePasswordResetRequest}
      >
        {busyAction === "password-reset" ? "Sending..." : "Send password reset email"}
      </button>
    </div>
  );

  return (
    <div className="member-portal-shell" id="account">
      <DeckPageHeader navLinks={portalNavLinks} authLabel="Log out" onAuthAction={onLogout} />

      <section className="section member-portal-section">
      <div className="container">
        <div className="card pad member-portal-intro-card">
          <div className="member-portal-header">
            <div>
              <div className="eyebrow">Member portal</div>
              <h2 className="h2">Subscription and wallet</h2>
              <p className="lede">
                Manage your plan, billing day, payment methods, herdshare, dividend accrual, and
                Local Line bridge in one place.
              </p>
            </div>
            <div className="button-row">
              {canAccessAdmin && adminUrl ? (
                <a className="button alt" href={adminUrl}>
                  Admin
                </a>
              ) : null}
              <button className="button alt" type="button" onClick={loadPortal}>
                Refresh
              </button>
            </div>
          </div>
        </div>

        {message ? <div className="small member-portal-message">{message}</div> : null}
        {error ? <div className="small member-portal-error">{error}</div> : null}

        <div className="member-portal-card-columns">
          {!localLineConnected ? localLineSection : null}
          {accountSection}
          <div className="card pad">
            <div className="eyebrow">CSA wallet</div>
            <h3 className="member-portal-money">{formatMoney(portal?.wallet?.availableBalanceCents)}</h3>
            <div className="small">
              CSA Store account credit available for your membership ledger.
            </div>
            <div className="member-portal-stat-grid">
              <div>
                <strong>{formatMoney(portal?.wallet?.totalReceivedCents)}</strong>
                <span>Total credited</span>
              </div>
              <div>
                <strong>{formatMoney(portal?.wallet?.totalSpentCents)}</strong>
                <span>Total spent / charged</span>
              </div>
              <div>
                <strong>{formatMoney(portal?.dividends?.accruedCents)}</strong>
                <span>{portal?.dividends?.ratePercent || 3}% year-end dividend accrual</span>
              </div>
              <div>
                <strong>{formatMoney(portal?.settings?.herdshareMonthlyFeeCents)}</strong>
                <span>Monthly herdshare charge</span>
              </div>
            </div>
          </div>

          <div className="card pad">
            <div className="eyebrow">Current plan</div>
            <h3>{portal?.subscription?.planLabel || "Forager"}</h3>
            <div className="small">
              Status: <strong>{portal?.subscription?.status || "pending_payment_method"}</strong>
            </div>
            <div className="small">
              Next billing date: <strong>{formatDate(portal?.subscription?.nextBillingDate)}</strong>
            </div>
            <div className="small">
              Preferred pickup / delivery site:{" "}
              <strong>{portal?.profile?.preferredDropSite || "Not sure yet"}</strong>
            </div>
            <div className="small">
              Home delivery eligible:{" "}
              <strong>{portal?.profile?.insideHomeDeliveryArea ? "Yes" : "No"}</strong>
            </div>
          </div>

          <div className="card pad">
            <div className="eyebrow">Subscription settings</div>
            <form className="admin-form" onSubmit={handleSaveSubscription}>
              <label className="filter-field">
                <span className="small">Plan</span>
                <select
                  className="select"
                  value={pendingPlanKey}
                  onChange={(event) => setPendingPlanKey(event.target.value)}
                >
                  <option value="forager">Forager ($200 / month)</option>
                  <option value="grazer">Grazer ($300 / month)</option>
                  <option value="harvester">Harvester ($500 / month)</option>
                </select>
              </label>
              <label className="filter-field">
                <span className="small">Billing day of month</span>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="28"
                  value={pendingBillingDay}
                  onChange={(event) => setPendingBillingDay(Number(event.target.value || 1))}
                />
              </label>
              <div className="small">
                The monthly plan deposit pauses when you pause the subscription. The herdshare
                charge remains active and is intended to continue monthly.
              </div>
              <div className="button-row">
                <button className="button" type="submit" disabled={busyAction === "subscription"}>
                  {busyAction === "subscription" ? "Saving..." : "Save subscription"}
                </button>
                <button
                  className="button alt"
                  type="button"
                  disabled={busyAction === "pause"}
                  onClick={() =>
                    runAction("pause", () => pauseMemberSubscription(token), "Subscription paused.")
                  }
                >
                  {busyAction === "pause" ? "Pausing..." : "Pause"}
                </button>
                <button
                  className="button alt"
                  type="button"
                  disabled={busyAction === "resume"}
                  onClick={() =>
                    runAction("resume", () => resumeMemberSubscription(token), "Subscription resumed.")
                  }
                >
                  {busyAction === "resume" ? "Resuming..." : "Resume"}
                </button>
                <button
                  className="button alt"
                  type="button"
                  disabled={busyAction === "cancel"}
                  onClick={() =>
                    runAction("cancel", () => cancelMemberSubscription(token), "Subscription canceled.")
                  }
                >
                  {busyAction === "cancel" ? "Canceling..." : "Cancel"}
                </button>
              </div>
            </form>
          </div>
          <div className="card pad">
            <div className="eyebrow">Payment method</div>
            {stripePromise && setupClientSecret ? (
              <Elements stripe={stripePromise} options={{ clientSecret: setupClientSecret }}>
                <PaymentSetupForm
                  token={token}
                  onSaved={() =>
                    runAction("payment-refresh", () => fetchMemberPortal(token), "Payment method saved.")
                  }
                />
              </Elements>
            ) : (
              <div className="small">
                Stripe payment setup is not available yet. Add `VITE_STRIPE_PK` and backend Stripe
                env vars to enable card setup here.
              </div>
            )}
            {Array.isArray(portal?.stripe?.paymentMethods) && portal.stripe.paymentMethods.length ? (
              <div className="member-portal-payment-methods">
                {portal.stripe.paymentMethods.map((method) => (
                  <div key={method.id} className="member-portal-payment-method">
                    <div>
                      <strong>
                        {method.card?.brand || "Card"} ending in {method.card?.last4 || "----"}
                      </strong>
                      <div className="small">
                        Exp {method.card?.exp_month || "--"}/{method.card?.exp_year || "--"}
                        {portal?.stripe?.defaultPaymentMethodId === method.id ? " • Default" : ""}
                      </div>
                    </div>
                    <div className="button-row">
                      {portal?.stripe?.defaultPaymentMethodId !== method.id ? (
                        <button
                          className="button alt"
                          type="button"
                          onClick={() =>
                            runAction(
                              `pm-default-${method.id}`,
                              () => setMemberPaymentMethodDefault(token, method.id),
                              "Default payment method updated."
                            )
                          }
                        >
                          Set default
                        </button>
                      ) : null}
                      <button
                        className="button alt"
                        type="button"
                        onClick={() =>
                          runAction(
                            `pm-delete-${method.id}`,
                            () => deleteMemberPaymentMethod(token, method.id),
                            "Payment method removed."
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="card pad">
            <div className="eyebrow">Herdshare and dividend</div>
            <div className="small">
              Agreement signer: <strong>{portal?.herdshare?.agreementSignerName || "Not recorded"}</strong>
            </div>
            <div className="small">
              Signed at: <strong>{formatDate(portal?.herdshare?.signedAt)}</strong>
            </div>
            <div className="small">
              Next herdshare billing date: <strong>{formatDate(portal?.herdshare?.nextBillingDate)}</strong>
            </div>
            {portal?.herdshare?.agreementRecordUrl ? (
              <a
                className="button alt member-portal-inline-button"
                href={portal.herdshare.agreementRecordUrl}
                target="_blank"
                rel="noreferrer"
              >
                View signed herdshare PDF
              </a>
            ) : null}
          </div>
          {localLineConnected ? localLineSection : null}
        </div>

        <div className="card pad member-portal-ledger-card">
          <div className="eyebrow">Ledger activity</div>
          <div className="member-portal-ledger-shell">
            <table className="admin-table member-portal-ledger-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {Array.isArray(portal?.entries) && portal.entries.length ? (
                  portal.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.effectiveDate)}</td>
                      <td>
                        <div>{formatEntryLabel(entry.entryType)}</div>
                        {getLedgerEntryMethod(entry) ? (
                          <div className="small">
                            Method: {formatLocalLineMethod(getLedgerEntryMethod(entry))}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div>{entry.description || ""}</div>
                        {entry.referenceType === "localline_credit_transaction" &&
                        getLedgerEntryNote(entry) ? (
                          <div className="small">
                            {`Note: ${getLedgerEntryNote(entry)}`}
                          </div>
                        ) : null}
                      </td>
                      <td>{formatMoney(entry.amountCents)}</td>
                      <td>
                        {typeof entry.runningBalanceCents === "number"
                          ? formatMoney(entry.runningBalanceCents)
                          : "—"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="5" className="small">
                      No ledger entries yet. Once your subscription is activated and orders begin,
                      your credits, herdshare charges, and purchase debits will appear here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </section>

      <footer className="subscribe-footer">
        <div className="container subscribe-footer-row">
          <div className="subscribe-footer-brand">
            <div className="subscribe-footer-brand-top">
              <img
                className="subscribe-footer-logo"
                src="/images/subscribe-footer-logo.avif"
                alt="Deck Family Farm icon logo"
              />
              <strong className="subscribe-footer-wordmark">Deck Family Farm</strong>
            </div>
            <div className="small">
              Full Farm CSA is Deck Family Farm’s CSA membership program, featuring
              pasture-raised food from our farm and trusted local partners, with convenient
              neighborhood pickup sites and home delivery.
            </div>
          </div>
          <div className="subscribe-footer-contact">
            <div>25362 High Pass Road</div>
            <div>Junction City, OR 97448</div>
            <div>
              <a href="tel:15413210925">541-321-0925</a>
            </div>
            <div>
              <a href="mailto:fullfarmcsa@deckfamilyfarm.com">fullfarmcsa@deckfamilyfarm.com</a>
            </div>
          </div>
          <div className="subscribe-footer-links">
            <a
              className="subscribe-review-link"
              href="https://app.goodreviews.io/mode?type=link&grid=GRI_ZN9UOZ3YIM5"
              target="_blank"
              rel="noreferrer"
            >
              <span className="subscribe-review-link-star" aria-hidden="true">
                ☆
              </span>
              <span>Leave us a Review!</span>
            </a>
          </div>
        </div>
        {canAccessAdmin && adminUrl ? (
          <div className="container member-portal-footer-admin">
            <a href={adminUrl}>Admin portal</a>
          </div>
        ) : null}
      </footer>
    </div>
  );
}
