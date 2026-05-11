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

export function AdminSubscriptionLeadsSection({ token }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [leads, setLeads] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
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

  async function handleSaveSelected() {
    if (!selectedLead || !selectedDraft) return;
    setSavingLeadId(selectedLead.id);
    setError("");
    setMessage("");
    try {
      const response = await adminPut(`subscription-leads/${selectedLead.id}`, token, selectedDraft);
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
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={lead.id === selectedLeadId ? "selected" : ""}
                  onClick={() => {
                    setSelectedLeadId(lead.id);
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
                  <td>{formatStatusLabel(lead.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {selectedLead ? (
            <div className="card pad" style={{ marginTop: 20 }}>
              <div className="button-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>
                    {[selectedLead.firstName, selectedLead.lastName].filter(Boolean).join(" ")}
                  </strong>
                  <div className="small">{selectedLead.email}</div>
                </div>
                <button
                  className="button alt"
                  type="button"
                  onClick={loadLeads}
                  disabled={loading}
                >
                  Refresh
                </button>
              </div>

              <div className="admin-grid" style={{ marginTop: 16 }}>
                <DetailRow label="Submitted" value={formatDateTime(selectedLead.submittedAt || selectedLead.createdAt)} />
                <DetailRow label="Phone" value={selectedLead.phone} />
                <DetailRow label="Country" value={selectedLead.country} />
                <DetailRow label="Address 1" value={selectedLead.addressLine1} />
                <DetailRow label="Address 2" value={selectedLead.addressLine2} />
                <DetailRow label="City" value={selectedLead.city} />
                <DetailRow label="State / Province" value={selectedLead.stateProvince} />
                <DetailRow label="Postal Code" value={selectedLead.postalCode} />
                <DetailRow label="Plan" value={selectedLead.selectedPlanLabel || selectedLead.selectedPlan} />
                <DetailRow label="Drop Site" value={selectedLead.selectedDropSite} />
                <DetailRow label="Referral Source" value={selectedLead.referralSource} />
                <DetailRow label="UTM Source" value={selectedLead.utmSource} />
                <DetailRow label="UTM Medium" value={selectedLead.utmMedium} />
                <DetailRow label="UTM Campaign" value={selectedLead.utmCampaign} />
                <DetailRow label="UTM Content" value={selectedLead.utmContent} />
                <DetailRow label="UTM Term" value={selectedLead.utmTerm} />
                <DetailRow label="Source Host" value={selectedLead.sourceHost} />
                <DetailRow label="Source Path" value={selectedLead.sourcePath} />
              </div>

              <div style={{ marginTop: 20 }}>
                <div className="small">
                  <strong>Customer Notes</strong>
                </div>
                <div>{selectedLead.notes || "—"}</div>
              </div>

              <div className="admin-grid" style={{ marginTop: 20 }}>
                <div>
                  <label className="small" htmlFor="subscription-lead-status">
                    <strong>Status</strong>
                  </label>
                  <select
                    id="subscription-lead-status"
                    className="input"
                    value={selectedDraft?.status || "in_progress"}
                    onChange={(event) =>
                      updateDraft(selectedLead.id, { status: event.target.value })
                    }
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="small" htmlFor="subscription-lead-admin-notes">
                    <strong>Internal Notes</strong>
                  </label>
                  <textarea
                    id="subscription-lead-admin-notes"
                    className="textarea"
                    rows={6}
                    value={selectedDraft?.adminNotes || ""}
                    onChange={(event) =>
                      updateDraft(selectedLead.id, { adminNotes: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="button-row">
                <button
                  className="button alt"
                  type="button"
                  disabled={!selectedDirty || savingLeadId === selectedLead.id}
                  onClick={handleSaveSelected}
                >
                  {savingLeadId === selectedLead.id ? "Saving..." : "Save Lead"}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
