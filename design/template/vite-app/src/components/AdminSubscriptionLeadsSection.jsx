import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPut } from "../adminApi.js";

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In progress" },
  { value: "won", label: "Won" }
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

export function AdminSubscriptionLeadsSection({ token }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [leads, setLeads] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [modalLeadId, setModalLeadId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingLeadId, setSavingLeadId] = useState(null);

  async function loadLeads() {
    setLoading(true);
    setError("");
    try {
      const response = await adminGet("subscription-leads", token);
      const nextLeads = response.leads || [];
      setLeads(nextLeads);
      setDrafts((current) => {
        const nextDrafts = {};
        nextLeads.forEach((lead) => {
          nextDrafts[lead.id] = current[lead.id] || createLeadDraft(lead);
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
  }, [token]);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) || null,
    [leads, selectedLeadId]
  );
  const modalLead = useMemo(
    () => leads.find((lead) => lead.id === modalLeadId) || null,
    [leads, modalLeadId]
  );
  const selectedDraft = selectedLead ? drafts[selectedLead.id] || createLeadDraft(selectedLead) : null;
  const selectedDirty = selectedLead ? draftChanged(selectedLead, selectedDraft) : false;

  function updateDraft(leadId, updates) {
    setDrafts((current) => ({
      ...current,
      [leadId]: {
        ...(current[leadId] || createLeadDraft(leads.find((lead) => lead.id === leadId) || {})),
        ...updates
      }
    }));
  }

  async function handleSaveLead(leadId) {
    const lead = leads.find((entry) => entry.id === leadId);
    const draft = drafts[leadId] || createLeadDraft(lead);
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
      setMessage("Subscription lead updated.");
    } catch (saveError) {
      setError(saveError?.message || "Failed to update subscription lead.");
    } finally {
      setSavingLeadId(null);
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
      {loading ? (
        <div className="small">Loading subscription leads...</div>
      ) : !leads.length ? (
        <div className="small">No subscription leads submitted yet.</div>
      ) : (
        <>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Name</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Drop Site</th>
                <th>Agreement</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
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
                    <td>{formatDateTime(lead.submittedAt || lead.createdAt)}</td>
                    <td>{[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td>{lead.email || "—"}</td>
                    <td>{lead.selectedPlanLabel || lead.selectedPlan || "—"}</td>
                    <td>{lead.selectedDropSite || "—"}</td>
                    <td>
                      <AgreementCell href={lead.liabilityAgreementRecordUrl} />
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <select
                        className="input"
                        value={draft.status || "in_progress"}
                        onChange={(event) =>
                          updateDraft(lead.id, { status: event.target.value })
                        }
                      >
                        {STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <textarea
                        className="textarea"
                        rows={2}
                        value={draft.adminNotes || ""}
                        onChange={(event) =>
                          updateDraft(lead.id, { adminNotes: event.target.value })
                        }
                      />
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
          <div className="button-row" style={{ marginTop: 16 }}>
            <button className="button alt" type="button" onClick={loadLeads} disabled={loading}>
              Refresh
            </button>
          </div>
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
