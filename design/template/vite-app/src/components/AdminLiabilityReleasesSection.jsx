import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPost, adminPut, adminUploadFiles } from "../adminApi.js";

const RELEASE_TYPE_OPTIONS = [
  { value: "", label: "All release types" },
  { value: "product-liability", label: "Product Liability" },
  { value: "visitor", label: "Visitor" },
  { value: "firearm", label: "Firearms" }
];

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function createTemplateDraft(template = {}) {
  return {
    id: template.id || null,
    slug: template.slug || "",
    title: template.title || "",
    description: template.description || "",
    bodyText: template.bodyText || "",
    sourceUrl: template.sourceUrl || "",
    status: template.status || "draft",
    publicPath: template.publicPath || "",
    renewalMonths:
      template.renewalMonths === null || typeof template.renewalMonths === "undefined"
        ? ""
        : String(template.renewalMonths),
    requiresParticipants: Boolean(template.requiresParticipants),
    allowDrawnSignature: template.allowDrawnSignature !== 0
  };
}

function templateChanged(template, draft) {
  return JSON.stringify(createTemplateDraft(template)) !== JSON.stringify(draft);
}

function isLikelySpamRelease(release = {}) {
  const sourceType = String(release.sourceType || "").trim().toLowerCase();
  if (sourceType && sourceType !== "public") return false;

  const name = String(release.signerName || "").trim();
  const email = String(release.signerEmail || "").trim().toLowerCase();
  const phone = String(release.signerPhone || "").trim();
  const address = [
    release.signerAddressLine1,
    release.signerAddressLine2,
    release.signerCity,
    release.signerPostalCode
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const compactName = name.replace(/\s+/g, "");

  const randomTokenName =
    compactName.length >= 14 &&
    /^[a-z0-9]+$/i.test(compactName) &&
    /[a-z]/.test(compactName) &&
    /[A-Z]/.test(compactName) &&
    !phone &&
    !address;
  const invalidEmail = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const dotHeavyEmail = /^[^@]*\.{2,}[^@]*@/.test(email);

  return randomTokenName || invalidEmail || dotHeavyEmail;
}

export function AdminLiabilityReleasesSection({ token }) {
  const [activeTab, setActiveTab] = useState("releases");
  const [templates, setTemplates] = useState([]);
  const [releases, setReleases] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [templateDrafts, setTemplateDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [releaseFilter, setReleaseFilter] = useState("");
  const [releaseTypeFilter, setReleaseTypeFilter] = useState("");
  const [showHiddenReleases, setShowHiddenReleases] = useState(false);
  const [selectedReleaseId, setSelectedReleaseId] = useState(null);
  const [importFiles, setImportFiles] = useState([]);
  const [importResult, setImportResult] = useState(null);

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const releaseParams = new URLSearchParams();
      if (showHiddenReleases) {
        releaseParams.set("includeHidden", "1");
        releaseParams.set("includeSpam", "1");
      }
      if (releaseTypeFilter) releaseParams.set("templateSlug", releaseTypeFilter);
      const releasePath = `liability/releases${releaseParams.toString() ? `?${releaseParams}` : ""}`;
      const [templateResponse, releaseResponse] = await Promise.all([
        adminGet("liability/templates", token),
        adminGet(releasePath, token)
      ]);
      const nextTemplates = templateResponse.templates || [];
      const nextReleases = releaseResponse.releases || [];
      setTemplates(nextTemplates);
      setReleases(nextReleases);
      setTemplateDrafts((current) => {
        const next = {};
        nextTemplates.forEach((template) => {
          next[template.id] = current[template.id] || createTemplateDraft(template);
        });
        return next;
      });
      setSelectedTemplateId((current) => current || nextTemplates[0]?.id || null);
      setSelectedReleaseId((current) => current || nextReleases[0]?.id || null);
    } catch (loadError) {
      setError(loadError?.message || "Failed to load liability releases.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [token, releaseTypeFilter, showHiddenReleases]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );
  const selectedDraft = selectedTemplate
    ? templateDrafts[selectedTemplate.id] || createTemplateDraft(selectedTemplate)
    : createTemplateDraft();
  const filteredReleases = useMemo(() => {
    const query = releaseFilter.trim().toLowerCase();
    return releases.filter((release) => {
      if (releaseTypeFilter && release.templateSlug !== releaseTypeFilter) return false;
      if (!showHiddenReleases && release.status === "hidden") return false;
      if (!showHiddenReleases && isLikelySpamRelease(release)) return false;
      if (!query) return true;
      return [
        release.templateSlug,
        release.templateTitle,
        release.signerName,
        release.signerEmail,
        release.signerPhone,
        release.sourceSubmissionId
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [releases, releaseFilter, releaseTypeFilter, showHiddenReleases]);
  const selectedRelease = useMemo(
    () =>
      filteredReleases.find((release) => release.id === selectedReleaseId) ||
      filteredReleases[0] ||
      null,
    [selectedReleaseId, filteredReleases]
  );

  function updateTemplateDraft(updates) {
    if (!selectedTemplate) return;
    setTemplateDrafts((current) => ({
      ...current,
      [selectedTemplate.id]: {
        ...(current[selectedTemplate.id] || createTemplateDraft(selectedTemplate)),
        ...updates
      }
    }));
  }

  async function saveTemplate(templateId) {
    const draft = templateDrafts[templateId];
    if (!draft) return;
    setSaving(`save-${templateId}`);
    setError("");
    setMessage("");
    try {
      const response = await adminPut(`liability/templates/${templateId}`, token, draft);
      const updated = response.template;
      setTemplates((current) =>
        current.map((template) => (template.id === updated.id ? updated : template))
      );
      setTemplateDrafts((current) => ({
        ...current,
        [updated.id]: createTemplateDraft(updated)
      }));
      setMessage("Template saved.");
    } catch (saveError) {
      setError(saveError?.message || "Failed to save template.");
    } finally {
      setSaving("");
    }
  }

  async function publishTemplate(templateId) {
    setSaving(`publish-${templateId}`);
    setError("");
    setMessage("");
    try {
      const response = await adminPost(`liability/templates/${templateId}/publish`, token, {});
      const updated = response.template;
      if (updated) {
        setTemplates((current) =>
          current.map((template) => (template.id === updated.id ? updated : template))
        );
        setTemplateDrafts((current) => ({
          ...current,
          [updated.id]: createTemplateDraft(updated)
        }));
      }
      setMessage("Template published.");
    } catch (publishError) {
      setError(publishError?.message || "Failed to publish template.");
    } finally {
      setSaving("");
    }
  }

  async function updateReleaseStatus(release, status) {
    if (!release?.id) return;
    if (
      status === "hidden" &&
      typeof window !== "undefined" &&
      !window.confirm("Hide this signed release from the default admin list?")
    ) {
      return;
    }
    setSaving(`release-${release.id}`);
    setError("");
    setMessage("");
    try {
      await adminPut(`liability/releases/${release.id}/status`, token, {
        status,
        adminNotes:
          status === "hidden"
            ? "Hidden from the default admin signed-release list as spam/test/noise."
            : "Restored to the default admin signed-release list."
      });
      setMessage(status === "hidden" ? "Release hidden from default view." : "Release restored.");
      if (status === "hidden" && !showHiddenReleases) {
        setSelectedReleaseId(null);
      }
      await loadAll();
    } catch (statusError) {
      setError(statusError?.message || "Failed to update release visibility.");
    } finally {
      setSaving("");
    }
  }

  async function runImportValidation() {
    setSaving("validate-import");
    setError("");
    setMessage("");
    setImportResult(null);
    try {
      const result = await adminUploadFiles("liability/import/validate", token, importFiles);
      setImportResult(result);
      setMessage(result.ok ? "Import validation passed." : "Import validation found errors.");
    } catch (validationError) {
      setError(validationError?.message || "Failed to validate import.");
    } finally {
      setSaving("");
    }
  }

  async function commitImport() {
    setSaving("commit-import");
    setError("");
    setMessage("");
    try {
      const result = await adminUploadFiles("liability/import", token, importFiles);
      setImportResult(result);
      setMessage(`Imported ${result.importedCount || 0} legacy releases.`);
      await loadAll();
    } catch (importError) {
      setError(importError?.message || "Failed to import legacy releases.");
    } finally {
      setSaving("");
    }
  }

  if (loading) {
    return (
      <section className="admin-section">
        <h3>Liability Releases</h3>
        <p className="small">Loading liability release records...</p>
      </section>
    );
  }

  return (
    <section className="admin-section">
      <div className="admin-section-heading">
        <div>
          <h3>Liability Releases</h3>
          <p className="small">
            Manage release templates, signed records, and imported Jotform history.
          </p>
        </div>
        <button className="button alt" type="button" onClick={loadAll}>
          Refresh
        </button>
      </div>

      <div className="button-row">
        {["releases", "templates", "import"].map((tab) => (
          <button
            key={tab}
            className={`button alt ${activeTab === tab ? "selected" : ""}`}
            type="button"
            onClick={() => setActiveTab(tab)}
          >
            {tab === "releases" ? "Signed Releases" : tab === "templates" ? "Templates" : "Legacy Import"}
          </button>
        ))}
      </div>

      {error ? <div className="small form-error">{error}</div> : null}
      {message ? <div className="small">{message}</div> : null}

      {activeTab === "releases" ? (
        <div className="liability-admin-grid">
          <div>
            <div className="admin-form-grid">
              <label className="filter-field">
                <span className="small">Release type</span>
                <select
                  className="input"
                  value={releaseTypeFilter}
                  onChange={(event) => {
                    setReleaseTypeFilter(event.target.value);
                    setSelectedReleaseId(null);
                  }}
                >
                  {RELEASE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value || "all"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-field">
                <span className="small">Search signed releases</span>
                <input
                  className="input"
                  value={releaseFilter}
                  onChange={(event) => setReleaseFilter(event.target.value)}
                  placeholder="Signer, email, template, source id"
                />
              </label>
            </div>
            <label className="subscribe-agreement-check compact-check">
              <input
                type="checkbox"
                checked={showHiddenReleases}
                onChange={(event) => {
                  setShowHiddenReleases(event.target.checked);
                  setSelectedReleaseId(null);
                }}
              />
              <span>Show hidden/spam/test records</span>
            </label>
            <div className="admin-table-wrap">
              <table className="admin-table compact">
                <thead>
                  <tr>
                    <th>Signed</th>
                    <th>Release</th>
                    <th>Signer</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReleases.map((release) => (
                    <tr
                      key={release.id}
                      className={selectedRelease?.id === release.id ? "selected-row" : ""}
                      onClick={() => setSelectedReleaseId(release.id)}
                    >
                      <td>{formatDate(release.signedAt)}</td>
                      <td>
                        <div>{release.templateSlug}</div>
                        {release.status && release.status !== "signed" ? (
                          <div className="small">{release.status}</div>
                        ) : null}
                      </td>
                      <td>
                        <div>{release.signerName}</div>
                        <div className="small">{release.signerEmail || "No email"}</div>
                      </td>
                      <td>
                        {release.recordUrl ? (
                          <a
                            href={release.recordUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                          >
                            PDF
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="admin-detail-panel">
            {selectedRelease ? (
              <>
                <h4>{selectedRelease.templateTitle}</h4>
                <div className="detail-grid">
                  <div>
                    <strong>Signer</strong>
                    <div>{selectedRelease.signerName}</div>
                  </div>
                  <div>
                    <strong>Email</strong>
                    <div>{selectedRelease.signerEmail || "—"}</div>
                  </div>
                  <div>
                    <strong>Phone</strong>
                    <div>{selectedRelease.signerPhone || "—"}</div>
                  </div>
                  <div>
                    <strong>Signed</strong>
                    <div>{formatDate(selectedRelease.signedAt)}</div>
                  </div>
                  <div>
                    <strong>Source</strong>
                    <div>{selectedRelease.sourceType || "—"}</div>
                  </div>
                  <div>
                    <strong>Status</strong>
                    <div>{selectedRelease.status || "signed"}</div>
                  </div>
                  <div>
                    <strong>Expires</strong>
                    <div>{formatDate(selectedRelease.expiresAt)}</div>
                  </div>
                </div>
                <div className="button-row">
                  {selectedRelease.status === "hidden" ? (
                    <button
                      className="button alt"
                      type="button"
                      disabled={saving === `release-${selectedRelease.id}`}
                      onClick={() => updateReleaseStatus(selectedRelease, "signed")}
                    >
                      Restore to list
                    </button>
                  ) : (
                    <button
                      className="button alt"
                      type="button"
                      disabled={saving === `release-${selectedRelease.id}`}
                      onClick={() => updateReleaseStatus(selectedRelease, "hidden")}
                    >
                      Hide from list
                    </button>
                  )}
                </div>
                {selectedRelease.participants?.length ? (
                  <div>
                    <h4>Covered Participants</h4>
                    <ul>
                      {selectedRelease.participants.map((participant, index) => (
                        <li key={`${participant.name}-${index}`}>
                          {participant.name}
                          {participant.relationship ? `, ${participant.relationship}` : ""}
                          {participant.minor ? ", minor" : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {selectedRelease.recordUrl ? (
                  <iframe
                    className="liability-pdf-preview"
                    src={selectedRelease.recordUrl}
                    title={`Signed release ${selectedRelease.id}`}
                  />
                ) : null}
              </>
            ) : (
              <p className="small">No signed release selected.</p>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === "templates" ? (
        <div className="liability-admin-grid">
          <div className="admin-table-wrap">
            <table className="admin-table compact">
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr
                    key={template.id}
                    className={selectedTemplateId === template.id ? "selected-row" : ""}
                    onClick={() => setSelectedTemplateId(template.id)}
                  >
                    <td>{template.slug}</td>
                    <td>{template.status}</td>
                    <td>{template.currentVersionId ? `v${template.currentVersionId}` : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedTemplate ? (
            <div className="admin-detail-panel">
              <h4>Edit Template</h4>
              <div className="admin-form">
                <div className="admin-form-grid">
                  <label className="filter-field">
                    <span className="small">Slug</span>
                    <input
                      className="input"
                      value={selectedDraft.slug}
                      onChange={(event) => updateTemplateDraft({ slug: event.target.value })}
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Title</span>
                    <input
                      className="input"
                      value={selectedDraft.title}
                      onChange={(event) => updateTemplateDraft({ title: event.target.value })}
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Public path</span>
                    <input
                      className="input"
                      value={selectedDraft.publicPath}
                      onChange={(event) => updateTemplateDraft({ publicPath: event.target.value })}
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Renewal months</span>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      value={selectedDraft.renewalMonths}
                      onChange={(event) =>
                        updateTemplateDraft({ renewalMonths: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="filter-field">
                  <span className="small">Description</span>
                  <textarea
                    className="textarea"
                    rows="3"
                    value={selectedDraft.description}
                    onChange={(event) => updateTemplateDraft({ description: event.target.value })}
                  />
                </label>
                <label className="filter-field">
                  <span className="small">Source URL</span>
                  <input
                    className="input"
                    value={selectedDraft.sourceUrl}
                    onChange={(event) => updateTemplateDraft({ sourceUrl: event.target.value })}
                  />
                </label>
                <label className="filter-field">
                  <span className="small">Agreement text</span>
                  <textarea
                    className="textarea liability-template-textarea"
                    value={selectedDraft.bodyText}
                    onChange={(event) => updateTemplateDraft({ bodyText: event.target.value })}
                  />
                </label>
                <label className="subscribe-agreement-check compact-check">
                  <input
                    type="checkbox"
                    checked={selectedDraft.requiresParticipants}
                    onChange={(event) =>
                      updateTemplateDraft({ requiresParticipants: event.target.checked })
                    }
                  />
                  <span>Collect covered participants</span>
                </label>
                <label className="subscribe-agreement-check compact-check">
                  <input
                    type="checkbox"
                    checked={selectedDraft.allowDrawnSignature}
                    onChange={(event) =>
                      updateTemplateDraft({ allowDrawnSignature: event.target.checked })
                    }
                  />
                  <span>Allow drawn signature</span>
                </label>
                <div className="button-row">
                  <button
                    className="button"
                    type="button"
                    disabled={
                      saving === `save-${selectedTemplate.id}` ||
                      !templateChanged(selectedTemplate, selectedDraft)
                    }
                    onClick={() => saveTemplate(selectedTemplate.id)}
                  >
                    {saving === `save-${selectedTemplate.id}` ? "Saving..." : "Save Template"}
                  </button>
                  <button
                    className="button alt"
                    type="button"
                    disabled={saving === `publish-${selectedTemplate.id}`}
                    onClick={() => publishTemplate(selectedTemplate.id)}
                  >
                    {saving === `publish-${selectedTemplate.id}` ? "Publishing..." : "Publish Version"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "import" ? (
        <div className="admin-detail-panel">
          <h4>Legacy Jotform Import</h4>
          <p className="small">
            Upload one CSV or XLSX. Referenced signed PDFs can be included individually or inside
            one ZIP; Jotform exports with Signature URLs can be imported without per-person PDFs.
          </p>
          <input
            className="input"
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.pdf,.zip"
            onChange={(event) => setImportFiles(Array.from(event.target.files || []))}
          />
          <div className="button-row">
            <button
              className="button alt"
              type="button"
              disabled={!importFiles.length || saving === "validate-import"}
              onClick={runImportValidation}
            >
              {saving === "validate-import" ? "Validating..." : "Validate Import"}
            </button>
            <button
              className="button"
              type="button"
              disabled={!importFiles.length || saving === "commit-import" || importResult?.ok !== true}
              onClick={commitImport}
            >
              {saving === "commit-import" ? "Importing..." : "Commit Import"}
            </button>
          </div>
          {importResult ? (
            <div className="admin-table-wrap">
              <p className="small">
                Rows: {importResult.rowCount ?? importResult.importedCount ?? 0}; files:{" "}
                {importResult.fileCount ?? "—"}
              </p>
              {importResult.errors?.length ? (
                <ul>
                  {importResult.errors.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              ) : null}
              {importResult.rows?.length ? (
                <table className="admin-table compact">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Template</th>
                      <th>Signer</th>
                      <th>PDF</th>
                      <th>Signature URL</th>
                      <th>Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.rows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        <td>{row.templateSlug}</td>
                        <td>{row.signerName}</td>
                        <td>{row.pdfFilename}</td>
                        <td>{row.signatureUrl ? "Yes" : "—"}</td>
                        <td>{row.errors?.join("; ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
