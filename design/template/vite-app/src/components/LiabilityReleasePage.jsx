import React, { useEffect, useRef, useState } from "react";
import { fetchLiabilityReleaseTemplate, submitLiabilityRelease } from "../api.js";

function createParticipant(overrides = {}) {
  return {
    name: overrides.name || "",
    relationship: overrides.relationship || "",
    minor: Boolean(overrides.minor),
    birthdate: overrides.birthdate || ""
  };
}

function createForm() {
  return {
    signerName: "",
    signerEmail: "",
    signerPhone: "",
    signerAddressLine1: "",
    signerAddressLine2: "",
    signerCity: "",
    signerStateProvince: "Oregon",
    signerPostalCode: "",
    participants: [],
    accepted: false,
    signatureMode: "typed",
    humanCheck: "",
    website: ""
  };
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function LiabilityReleasePage({ slug, homeUrl = "https://www.deckfamilyfarm.com/" }) {
  const [template, setTemplate] = useState(null);
  const [form, setForm] = useState(createForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setError("");
    setResult(null);
    fetchLiabilityReleaseTemplate(slug)
      .then((response) => {
        const nextTemplate = response.template || null;
        setTemplate(nextTemplate);
        setForm({
          ...createForm(),
          participants: nextTemplate?.requiresParticipants ? [createParticipant()] : []
        });
      })
      .catch((loadError) => {
        setError(loadError?.message || "Unable to load this liability release.");
      })
      .finally(() => setLoading(false));
  }, [slug]);

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateParticipant(index, updates) {
    setForm((current) => ({
      ...current,
      participants: current.participants.map((participant, participantIndex) =>
        participantIndex === index ? { ...participant, ...updates } : participant
      )
    }));
  }

  function addParticipant() {
    setForm((current) => ({
      ...current,
      participants: [...current.participants, createParticipant()]
    }));
  }

  function removeParticipant(index) {
    setForm((current) => ({
      ...current,
      participants: current.participants.filter((_participant, participantIndex) => participantIndex !== index)
    }));
  }

  function getCanvasPoint(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const source = event.touches?.[0] || event;
    return {
      x: source.clientX - rect.left,
      y: source.clientY - rect.top
    };
  }

  function beginDraw(event) {
    if (form.signatureMode !== "draw") return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const point = getCanvasPoint(event);
    drawingRef.current = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
    event.preventDefault();
  }

  function draw(event) {
    if (!drawingRef.current || form.signatureMode !== "draw") return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const point = getCanvasPoint(event);
    context.lineWidth = 2;
    context.lineCap = "round";
    context.strokeStyle = "#1c241f";
    context.lineTo(point.x, point.y);
    context.stroke();
    event.preventDefault();
  }

  function endDraw() {
    drawingRef.current = false;
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const signatureDataUrl =
        form.signatureMode === "draw" && canvasRef.current
          ? canvasRef.current.toDataURL("image/png")
          : "";
      const payload = {
        ...form,
        participants: form.participants.filter((participant) => participant.name.trim()),
        signatureDataUrl,
        sourcePath: window.location.pathname
      };
      const response = await submitLiabilityRelease(slug, payload);
      setResult(response.submission || null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (submitError) {
      setError(submitError?.message || "Unable to submit liability release.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <section className="section tight">
        <div className="container liability-page">
          <div className="eyebrow">Liability release</div>
          <h1 className="h2">Loading Release</h1>
        </div>
      </section>
    );
  }

  if (error && !template) {
    return (
      <section className="section tight">
        <div className="container liability-page">
          <div className="eyebrow">Liability release</div>
          <h1 className="h2">Release Not Available</h1>
          <p className="lede">{error}</p>
          <a className="button alt" href={homeUrl}>
            Return to store
          </a>
        </div>
      </section>
    );
  }

  if (result) {
    return (
      <section className="section tight">
        <div className="container liability-page">
          <div className="eyebrow">Liability release</div>
          <h1 className="h2">Release Signed</h1>
          <p className="lede">
            {result.templateTitle} was signed by {result.signerName} on {formatDate(result.signedAt)}.
          </p>
          <div className="button-row">
            {result.recordUrl ? (
              <a className="button" href={result.recordUrl} target="_blank" rel="noreferrer">
                Open Signed PDF
              </a>
            ) : null}
            <a className="button alt" href={homeUrl}>
              Return to Deck Family Farm
            </a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section tight">
      <div className="container liability-page">
        <div className="eyebrow">Liability release</div>
        <h1 className="h2">{template.title}</h1>
        {template.description ? <p className="lede">{template.description}</p> : null}

        <div className="liability-agreement-text">
          {String(template.bodyText || "")
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .map((paragraph, index) => (
              <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
            ))}
        </div>

        <form className="admin-form liability-form" onSubmit={handleSubmit}>
          <h2>Signer</h2>
          <div className="admin-form-grid">
            <label className="filter-field">
              <span className="small">Full legal name*</span>
              <input
                className="input"
                value={form.signerName}
                onChange={(event) => updateField("signerName", event.target.value)}
                required
              />
            </label>
            <label className="filter-field">
              <span className="small">Email</span>
              <input
                className="input"
                type="email"
                value={form.signerEmail}
                onChange={(event) => updateField("signerEmail", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">Phone</span>
              <input
                className="input"
                value={form.signerPhone}
                onChange={(event) => updateField("signerPhone", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">Address</span>
              <input
                className="input"
                value={form.signerAddressLine1}
                onChange={(event) => updateField("signerAddressLine1", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">Address line 2</span>
              <input
                className="input"
                value={form.signerAddressLine2}
                onChange={(event) => updateField("signerAddressLine2", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">City</span>
              <input
                className="input"
                value={form.signerCity}
                onChange={(event) => updateField("signerCity", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">State</span>
              <input
                className="input"
                value={form.signerStateProvince}
                onChange={(event) => updateField("signerStateProvince", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">Zip</span>
              <input
                className="input"
                value={form.signerPostalCode}
                onChange={(event) => updateField("signerPostalCode", event.target.value)}
              />
            </label>
          </div>

          <div className="liability-participants">
            <div className="button-row" style={{ justifyContent: "space-between" }}>
              <h2>
                {template.requiresParticipants
                  ? "Participants Covered by This Signature"
                  : "Participants Covered by This Signature (Optional)"}
              </h2>
              <button className="button alt" type="button" onClick={addParticipant}>
                Add participant
              </button>
            </div>
            {template.requiresParticipants || form.participants.length ? (
              <>
                {form.participants.map((participant, index) => (
                  <div className="liability-participant-row" key={`participant-${index}`}>
                    <label className="filter-field">
                      <span className="small">Participant name{template.requiresParticipants ? "*" : ""}</span>
                      <input
                        className="input"
                        value={participant.name}
                        onChange={(event) => updateParticipant(index, { name: event.target.value })}
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Relationship</span>
                      <input
                        className="input"
                        value={participant.relationship}
                        onChange={(event) =>
                          updateParticipant(index, { relationship: event.target.value })
                        }
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Birthdate</span>
                      <input
                        className="input"
                        type="date"
                        value={participant.birthdate}
                        onChange={(event) =>
                          updateParticipant(index, { birthdate: event.target.value })
                        }
                      />
                    </label>
                    <label className="subscribe-agreement-check compact-check">
                      <input
                        type="checkbox"
                        checked={participant.minor}
                        onChange={(event) =>
                          updateParticipant(index, { minor: event.target.checked })
                        }
                      />
                      <span>Minor</span>
                    </label>
                    {form.participants.length > 1 || !template.requiresParticipants ? (
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => removeParticipant(index)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </>
            ) : (
              <div className="small">Only add names here if this signer is covering other visitors.</div>
            )}
          </div>

          <div className="liability-signature-section">
            <h2>Signature</h2>
            {template.allowDrawnSignature ? (
              <div className="button-row liability-signature-mode">
                <label className="subscribe-agreement-check compact-check">
                  <input
                    type="radio"
                    name="signatureMode"
                    checked={form.signatureMode === "typed"}
                    onChange={() => updateField("signatureMode", "typed")}
                  />
                  <span>Typed name</span>
                </label>
                <label className="subscribe-agreement-check compact-check">
                  <input
                    type="radio"
                    name="signatureMode"
                    checked={form.signatureMode === "draw"}
                    onChange={() => updateField("signatureMode", "draw")}
                  />
                  <span>Draw signature</span>
                </label>
              </div>
            ) : null}

            {form.signatureMode === "draw" ? (
              <div>
                <canvas
                  ref={canvasRef}
                  className="liability-signature-pad"
                  width="620"
                  height="180"
                  onMouseDown={beginDraw}
                  onMouseMove={draw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={beginDraw}
                  onTouchMove={draw}
                  onTouchEnd={endDraw}
                />
                <button className="button alt" type="button" onClick={clearSignature}>
                  Clear signature
                </button>
              </div>
            ) : (
              <div className="small">
                Your typed full name will be used as your electronic signature.
              </div>
            )}
          </div>

          <label className="subscribe-agreement-check">
            <input
              type="checkbox"
              checked={form.accepted}
              onChange={(event) => updateField("accepted", event.target.checked)}
            />
            <span>I have reviewed this release and agree to sign it electronically.</span>
          </label>

          <div style={{ display: "none" }} aria-hidden="true">
            <label>
              Website
              <input
                tabIndex="-1"
                autoComplete="off"
                value={form.website}
                onChange={(event) => updateField("website", event.target.value)}
              />
            </label>
          </div>

          <label className="filter-field">
            <span className="small">Human check*</span>
            <input
              className="input"
              value={form.humanCheck}
              onChange={(event) => updateField("humanCheck", event.target.value)}
              placeholder='Type "farm"'
              required
            />
          </label>

          {error ? <div className="small form-error">{error}</div> : null}
          <div className="button-row">
            <button className="button" type="submit" disabled={submitting}>
              {submitting ? "Submitting..." : "Sign Release"}
            </button>
            <a className="button alt" href={homeUrl}>
              Return to Deck Family Farm
            </a>
          </div>
        </form>
      </div>
    </section>
  );
}
