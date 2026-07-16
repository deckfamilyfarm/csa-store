import React, { useEffect, useMemo, useState } from "react";
import { adminDownload, adminGet, adminPost, adminPut } from "../adminApi.js";

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In progress" },
  { value: "won", label: "Won" },
  { value: "inactive", label: "Inactive" }
];

function formatDateTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatStatusLabel(value) {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label || "In progress";
}

function formatMoney(cents) {
  const numeric = Number(cents || 0) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(numeric);
}

function truncateText(value, maxLength = 56) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function createLeadDraft(lead = {}) {
  return {
    status: lead.status || "in_progress",
    adminNotes: lead.adminNotes || ""
  };
}

function draftChanged(lead, draft) {
  return (
    String(draft?.status || "in_progress") !== String(lead?.status || "in_progress") ||
    String(draft?.adminNotes || "") !== String(lead?.adminNotes || "")
  );
}

function DetailRow({ label, value }) {
  return (
    <div>
      <div className="small">
        <strong>{label}</strong>
      </div>
      <div>{value || "—"}</div>
    </div>
  );
}

function DetailLinkRow({ label, href, text }) {
  return (
    <div>
      <div className="small">
        <strong>{label}</strong>
      </div>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {text || href}
        </a>
      ) : (
        <div>—</div>
      )}
    </div>
  );
}

function AgreementCell({ href }) {
  if (!href) return <span className="small">No PDF</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      Signed PDF
    </a>
  );
}

function LeadFlags({ lead = {} }) {
  const flags = [
    lead.hasCurrentSnapEbtCard ? "SNAP/EBT" : "",
    lead.isFarmEmployee ? "Employee" : ""
  ].filter(Boolean);
  if (!flags.length) return <span className="small">—</span>;
  return <span className="subscription-leads-cell-text">{flags.join(", ")}</span>;
}

export function AdminMemberCreditsSection({ token }) {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [opsBusy, setOpsBusy] = useState("");
  const [opsResult, setOpsResult] = useState(null);
  const [creditStatusLoading, setCreditStatusLoading] = useState(true);
  const [creditStatusRows, setCreditStatusRows] = useState([]);
  const [creditStatusMeta, setCreditStatusMeta] = useState({
    count: 0,
    includeRemote: true,
    localLineAuthConfigured: false
  });

  async function loadCreditStatus() {
    setCreditStatusLoading(true);
    try {
      const response = await adminGet("subscription-ops/localline-credit-status", token);
      setCreditStatusRows(Array.isArray(response?.rows) ? response.rows : []);
      setCreditStatusMeta({
        count: Number(response?.count || 0),
        includeRemote: response?.includeRemote !== false,
        localLineAuthConfigured: response?.localLineAuthConfigured === true
      });
    } catch (nextError) {
      setError(nextError?.message || "Failed to load Local Line credit status.");
    } finally {
      setCreditStatusLoading(false);
    }
  }

  useEffect(() => {
    loadCreditStatus();
  }, [token]);

  async function runSubscriptionOp(actionKey, path, dryRun = true) {
    setOpsBusy(actionKey);
    setError("");
    setMessage("");
    try {
      const response = await adminPost(path, token, { dryRun });
      setOpsResult({
        actionKey,
        dryRun,
        response
      });
      await loadCreditStatus();
      setMessage(
        dryRun
          ? "Subscription operation preview complete."
          : "Subscription operation executed."
      );
    } catch (nextError) {
      setError(nextError?.message || "Subscription operation failed.");
    } finally {
      setOpsBusy("");
    }
  }

  return (
    <section className="admin-section">
      <h3>Member Credits</h3>
      <div className="small">
        Preview and run member credit sync jobs, purchase debit sync, and related Local Line balance checks.
      </div>
      <div className="response-card" style={{ marginTop: 16, marginBottom: 16 }}>
        <div className="title">Subscription Operations</div>
        <div className="small">
          Preview or run Local Line credit sync, Local Line purchase debit sync, and paused-member
          herdshare billing from here.
        </div>
        <div className="button-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <button
            className="button alt"
            type="button"
            onClick={() => runSubscriptionOp("credits-preview", "subscription-ops/localline-credits-sync", true)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "credits-preview" ? "Running..." : "Preview Credit Sync"}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => runSubscriptionOp("credits-run", "subscription-ops/localline-credits-sync", false)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "credits-run" ? "Running..." : "Run Credit Sync"}
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() => runSubscriptionOp("purchases-preview", "subscription-ops/localline-purchase-sync", true)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "purchases-preview" ? "Running..." : "Preview Purchase Debit Sync"}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => runSubscriptionOp("purchases-run", "subscription-ops/localline-purchase-sync", false)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "purchases-run" ? "Running..." : "Run Purchase Debit Sync"}
          </button>
          <button
            className="button alt"
            type="button"
            onClick={() => runSubscriptionOp("herdshare-preview", "subscription-ops/process-paused-herdshare", true)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "herdshare-preview" ? "Running..." : "Preview Paused Herdshare"}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => runSubscriptionOp("herdshare-run", "subscription-ops/process-paused-herdshare", false)}
            disabled={Boolean(opsBusy)}
          >
            {opsBusy === "herdshare-run" ? "Running..." : "Run Paused Herdshare"}
          </button>
        </div>
        {opsResult ? (
          <pre className="small" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(opsResult.response, null, 2)}
          </pre>
        ) : null}
      </div>
      <div className="response-card" style={{ marginTop: 16, marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap"
          }}
        >
          <div>
            <div className="title">Local Line Credit Status</div>
            <div className="small">
              Inspect linked members, wallet balance, mirrored balance, remote Local Line balance,
              and sync deltas before running credit sync.
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              Linked members: {creditStatusMeta.count} · Remote balance checks:{" "}
              {creditStatusMeta.localLineAuthConfigured ? "enabled" : "not configured"}
            </div>
          </div>
          <button
            className="button alt"
            type="button"
            onClick={loadCreditStatus}
            disabled={creditStatusLoading || Boolean(opsBusy)}
          >
            {creditStatusLoading ? "Refreshing..." : "Refresh Credit Status"}
          </button>
        </div>
        {creditStatusLoading ? (
          <div className="small" style={{ marginTop: 12 }}>
            Loading Local Line credit status...
          </div>
        ) : !creditStatusRows.length ? (
          <div className="small" style={{ marginTop: 12 }}>
            No Local Line member links yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Local Line Id</th>
                  <th>Wallet</th>
                  <th>Mirrored</th>
                  <th>Remote</th>
                  <th>Delta vs Remote</th>
                  <th>Delta vs Mirror</th>
                  <th>Orders</th>
                  <th>Last Mirror</th>
                </tr>
              </thead>
              <tbody>
                {creditStatusRows.map((row) => (
                  <tr key={`credit-status-${row.userId}`}>
                    <td>
                      <div>{row.memberName || "—"}</div>
                      <div className="small">{row.email || row.username || "—"}</div>
                    </td>
                    <td title={row.externalEmail || ""}>
                      <div>{row.externalCustomerId || "—"}</div>
                      <div className="small">{row.externalEmail || "—"}</div>
                    </td>
                    <td>{formatMoney(row.walletBalanceCents)}</td>
                    <td>{formatMoney(row.mirroredBalanceCents)}</td>
                    <td>
                      {typeof row.remoteBalanceCents === "number"
                        ? formatMoney(row.remoteBalanceCents)
                        : row.remoteError
                          ? "Error"
                          : "—"}
                      {row.remoteError ? (
                        <div className="small" title={row.remoteError}>
                          {truncateText(row.remoteError, 52)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {typeof row.deltaFromRemoteCents === "number"
                        ? formatMoney(row.deltaFromRemoteCents)
                        : "—"}
                    </td>
                    <td>{formatMoney(row.deltaFromMirrorCents)}</td>
                    <td>
                      <div>{Number(row.syncableOrderCount || 0)} syncable</div>
                      <div className="small">{Number(row.linkedOrderCount || 0)} linked</div>
                    </td>
                    <td>
                      <div>{row.lastMirroredAt ? formatDateTime(row.lastMirroredAt) : "Never"}</div>
                      <div className="small">
                        Orders: {row.lastOrderSyncedAt ? formatDateTime(row.lastOrderSyncedAt) : "Never"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {message ? <div className="small">{message}</div> : null}
      {error ? <div className="small">{error}</div> : null}
    </section>
  );
}

export function AdminSubscriptionLeadsSection({ token }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [leads, setLeads] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [modalLeadId, setModalLeadId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingLeadId, setSavingLeadId] = useState(null);
  const [exportingLeads, setExportingLeads] = useState(false);
  const [editingNotesLeadId, setEditingNotesLeadId] = useState(null);

  async function loadLeads() {
    setLoading(true);
    setError("");
    try {
      const path = showInactive
        ? "subscription-leads?includeInactive=1"
        : "subscription-leads";
      const response = await adminGet(path, token);
      const nextLeads = response.leads || [];
      setLeads(nextLeads);
      setDrafts(() => {
        const nextDrafts = {};
        nextLeads.forEach((lead) => {
          nextDrafts[lead.id] = createLeadDraft(lead);
        });
        return nextDrafts;
      });
      setSelectedLeadId((current) => {
        if (current && nextLeads.some((lead) => lead.id === current)) return current;
        return nextLeads[0]?.id || null;
      });
    } catch (loadError) {
      setError(loadError?.message || "Failed to load subscription leads.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLeads();
  }, [token, showInactive]);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) || null,
    [leads, selectedLeadId]
  );
  const modalLead = useMemo(
    () => leads.find((lead) => lead.id === modalLeadId) || null,
    [leads, modalLeadId]
  );
  const visibleLeads = useMemo(
    () => (showInactive ? leads : leads.filter((lead) => lead.status !== "inactive")),
    [leads, showInactive]
  );
  function updateDraft(leadId, updates) {
    setDrafts((current) => ({
      ...current,
      [leadId]: {
        ...(current[leadId] || createLeadDraft(leads.find((lead) => lead.id === leadId) || {})),
        ...updates
      }
    }));
  }

  async function handleSaveLead(
    leadId,
    overrideDraft = null,
    successMessage = "Subscription lead updated."
  ) {
    const lead = leads.find((entry) => entry.id === leadId);
    const draft = overrideDraft || drafts[leadId] || createLeadDraft(lead);
    if (!lead || !draft) return;
    setSavingLeadId(leadId);
    setError("");
    setMessage("");
    try {
      const response = await adminPut(`subscription-leads/${leadId}`, token, draft);
      const updatedLead = response.lead || null;
      if (updatedLead) {
        setLeads((current) =>
          current.map((lead) => (lead.id === updatedLead.id ? updatedLead : lead))
        );
        setDrafts((current) => ({
          ...current,
          [updatedLead.id]: createLeadDraft(updatedLead)
        }));
      }
      setMessage(successMessage);
    } catch (saveError) {
      setError(saveError?.message || "Failed to update subscription lead.");
    } finally {
      setSavingLeadId(null);
    }
  }

  async function handleStatusChange(leadId, status) {
    const lead = leads.find((entry) => entry.id === leadId);
    if (!lead) return;
    const nextDraft = {
      ...(drafts[leadId] || createLeadDraft(lead)),
      status
    };
    updateDraft(leadId, { status });
    await handleSaveLead(leadId, nextDraft, "Subscription lead status saved.");
  }

  async function handleExportLeads() {
    setExportingLeads(true);
    setError("");
    setMessage("");
    try {
      const { blob, filename } = await adminDownload("subscription-leads/export", token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename || "subscription-leads.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("Subscription leads export downloaded.");
    } catch (exportError) {
      setError(exportError?.message || "Failed to export subscription leads.");
    } finally {
      setExportingLeads(false);
    }
  }

  return (
    <section className="admin-section">
      <h3>Subscription Leads</h3>
      <div className="small">
        Review subscribe form submissions captured by the store and track whether each lead is still
        in progress or won.
      </div>
      {message ? <div className="small">{message}</div> : null}
      {error ? <div className="small">{error}</div> : null}
      <div className="button-row" style={{ marginBottom: 12 }}>
        <label className="small" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
          />
          Show inactive
        </label>
        <button
          className="button alt"
          type="button"
          onClick={handleExportLeads}
          disabled={exportingLeads}
        >
          {exportingLeads ? "Exporting..." : "Export CSV"}
        </button>
        <button className="button alt" type="button" onClick={loadLeads} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading ? (
        <div className="small">Loading subscription leads...</div>
      ) : !visibleLeads.length ? (
        <div className="small">
          {showInactive
            ? "No subscription leads submitted yet."
            : "No active subscription leads shown."}
        </div>
      ) : (
        <>
          <table className="admin-table subscription-leads-table">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Name</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Drop Site</th>
                <th>Referral Source</th>
                <th>Flags</th>
                <th>Agreement</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLeads.map((lead) => {
                const draft = drafts[lead.id] || createLeadDraft(lead);
                const dirty = draftChanged(lead, draft);
                return (
                  <tr
                    key={lead.id}
                    className={lead.id === selectedLeadId ? "selected" : ""}
                    onClick={() => {
                      setSelectedLeadId(lead.id);
                      setModalLeadId(lead.id);
                      setMessage("");
                      setError("");
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td title={formatDateTime(lead.submittedAt || lead.createdAt)}>
                      <span className="subscription-leads-cell-text">
                        {truncateText(formatDateTime(lead.submittedAt || lead.createdAt), 22)}
                      </span>
                    </td>
                    <td title={[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}>
                      <span className="subscription-leads-cell-text">
                        {truncateText([lead.firstName, lead.lastName].filter(Boolean).join(" "), 28)}
                      </span>
                    </td>
                    <td title={lead.email || "—"}>
                      <span className="subscription-leads-cell-text">
                        {truncateText(lead.email, 28)}
                      </span>
                    </td>
                    <td title={lead.selectedPlanLabel || lead.selectedPlan || "—"}>
                      <span className="subscription-leads-cell-text">
                        {truncateText(lead.selectedPlanLabel || lead.selectedPlan, 24)}
                      </span>
                    </td>
                    <td title={lead.selectedDropSite || "—"}>
                      <span className="subscription-leads-cell-text">
                        {truncateText(lead.selectedDropSite, 32)}
                      </span>
                    </td>
                    <td title={lead.referralSource || "—"}>
                      <span className="subscription-leads-cell-text">
                        {truncateText(lead.referralSource, 32)}
                      </span>
                    </td>
                    <td
                      title={[
                        lead.hasCurrentSnapEbtCard ? "Has current SNAP/EBT card" : "",
                        lead.isFarmEmployee ? "Farm employee" : ""
                      ]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    >
                      <LeadFlags lead={lead} />
                    </td>
                    <td>
                      <AgreementCell href={lead.liabilityAgreementRecordUrl} />
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <select
                        className="input"
                        value={draft.status || "in_progress"}
                        disabled={savingLeadId === lead.id}
                        onChange={(event) => handleStatusChange(lead.id, event.target.value)}
                      >
                        {STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(event) => event.stopPropagation()} className="subscription-leads-notes-cell">
                      {editingNotesLeadId === lead.id ? (
                        <div className="subscription-leads-notes-editor">
                          <textarea
                            className="textarea"
                            rows={4}
                            value={draft.adminNotes || ""}
                            onChange={(event) =>
                              updateDraft(lead.id, { adminNotes: event.target.value })
                            }
                          />
                          <div className="button-row">
                            <button
                              className="button alt"
                              type="button"
                              onClick={() => setEditingNotesLeadId(null)}
                            >
                              Done
                            </button>
                            <button
                              className="button alt"
                              type="button"
                              onClick={() => {
                                updateDraft(lead.id, { adminNotes: lead.adminNotes || "" });
                                setEditingNotesLeadId(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="subscription-leads-notes-preview">
                          <span
                            className="subscription-leads-cell-text"
                            title={draft.adminNotes || "—"}
                          >
                            {truncateText(draft.adminNotes, 44)}
                          </span>
                          <button
                            className="button alt"
                            type="button"
                            onClick={() => setEditingNotesLeadId(lead.id)}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <button
                        className="button alt"
                        type="button"
                        disabled={!dirty || savingLeadId === lead.id}
                        onClick={() => handleSaveLead(lead.id)}
                      >
                        {savingLeadId === lead.id ? "Saving..." : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {modalLead ? (
        <div className="modal-backdrop" onClick={() => setModalLeadId(null)}>
          <div
            className="modal response-modal subscription-lead-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="button-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{[modalLead.firstName, modalLead.lastName].filter(Boolean).join(" ")}</strong>
                <div className="small">{modalLead.email}</div>
              </div>
              <button className="button alt" type="button" onClick={() => setModalLeadId(null)}>
                Close
              </button>
            </div>
            <div className="admin-grid" style={{ marginTop: 16 }}>
              <DetailRow label="Submitted" value={formatDateTime(modalLead.submittedAt || modalLead.createdAt)} />
              <DetailRow label="Phone" value={modalLead.phone} />
              <DetailRow label="Country" value={modalLead.country} />
              <DetailRow label="Address 1" value={modalLead.addressLine1} />
              <DetailRow label="Address 2" value={modalLead.addressLine2} />
              <DetailRow label="City" value={modalLead.city} />
              <DetailRow label="State / Province" value={modalLead.stateProvince} />
              <DetailRow label="Postal Code" value={modalLead.postalCode} />
              <DetailRow label="Validated Address" value={modalLead.geocodedDisplayName} />
              <DetailRow
                label="Closest Drop Site"
                value={
                  modalLead.closestDropSite
                    ? `${modalLead.closestDropSite}${
                        modalLead.closestDropSiteDistanceMiles
                          ? ` (${Number(modalLead.closestDropSiteDistanceMiles).toFixed(2)} miles)`
                          : ""
                      }`
                    : "—"
                }
              />
              <DetailRow
                label="Closest Drop Site Address"
                value={modalLead.closestDropSiteAddress}
              />
              <DetailRow
                label="Home Delivery Area"
                value={
                  typeof modalLead.insideHomeDeliveryArea === "number" ||
                  typeof modalLead.insideHomeDeliveryArea === "boolean"
                    ? Number(modalLead.insideHomeDeliveryArea)
                      ? "Inside delivery area"
                      : "Outside delivery area"
                    : "—"
                }
              />
              <DetailRow
                label="Geocoded Coordinates"
                value={
                  modalLead.geocodedLatitude && modalLead.geocodedLongitude
                    ? `${modalLead.geocodedLatitude}, ${modalLead.geocodedLongitude}`
                    : "—"
                }
              />
              <DetailRow label="Plan" value={modalLead.selectedPlanLabel || modalLead.selectedPlan} />
              <DetailRow label="Drop Site" value={modalLead.selectedDropSite} />
              <DetailRow
                label="SNAP/EBT Card"
                value={modalLead.hasCurrentSnapEbtCard ? "Yes" : "No"}
              />
              <DetailRow
                label="Farm Employee"
                value={modalLead.isFarmEmployee ? "Yes" : "No"}
              />
              <DetailRow label="Referral Source" value={modalLead.referralSource} />
              <DetailRow label="UTM Source" value={modalLead.utmSource} />
              <DetailRow label="UTM Medium" value={modalLead.utmMedium} />
              <DetailRow label="UTM Campaign" value={modalLead.utmCampaign} />
              <DetailRow label="UTM Content" value={modalLead.utmContent} />
              <DetailRow label="UTM Term" value={modalLead.utmTerm} />
              <DetailRow label="Source Host" value={modalLead.sourceHost} />
              <DetailRow label="Source Path" value={modalLead.sourcePath} />
              <DetailRow label="Agreement Signed" value={modalLead.liabilityAgreementSignedAt ? formatDateTime(modalLead.liabilityAgreementSignedAt) : "No"} />
              <DetailRow label="Agreement Signer" value={modalLead.liabilityAgreementSignerName} />
              <DetailLinkRow label="Agreement Source" href={modalLead.liabilityAgreementDocumentUrl} text="View agreement" />
              <DetailLinkRow label="Signed Agreement Record" href={modalLead.liabilityAgreementRecordUrl} text="Open signed agreement" />
            </div>
            <div style={{ marginTop: 20 }}>
              <div className="small">
                <strong>Customer Notes</strong>
              </div>
              <div>{modalLead.notes || "—"}</div>
            </div>
            {modalLead.liabilityAgreementRecordUrl ? (
              <div style={{ marginTop: 20 }}>
                <div className="small">
                  <strong>Signed Agreement Preview</strong>
                </div>
                <div className="button-row" style={{ marginTop: 8, marginBottom: 8 }}>
                  <a
                    className="button alt"
                    href={modalLead.liabilityAgreementRecordUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PDF in New Tab
                  </a>
                </div>
                <iframe
                  src={modalLead.liabilityAgreementRecordUrl}
                  title={`Signed agreement for ${modalLead.email}`}
                  style={{
                    width: "100%",
                    minHeight: 820,
                    border: "1px solid rgba(31, 27, 23, 0.12)",
                    borderRadius: 16,
                    background: "#fff"
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
