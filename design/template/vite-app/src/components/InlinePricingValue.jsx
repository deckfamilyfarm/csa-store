import React, { useRef, useState } from "react";

export function InlinePricingValue({ label, display, value, canEdit, min = 0, max, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const cancelled = useRef(false);
  const baseline = useRef("");

  async function save() {
    if (busy.current || cancelled.current) return;
    const text = draft.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) < min || (max != null && Number(text) > max)) {
      setError(`Enter a value ${max == null ? `of at least ${min}` : `between ${min} and ${max}`} with at most two decimal places.`);
      return;
    }
    if (baseline.current !== "" && Number(text) === Number(baseline.current)) { setEditing(false); return; }
    busy.current = true;
    setSaving(true); setError("");
    try {
      await onSave(text);
      setEditing(false);
    } catch (err) { setError(err.message || "Could not save. Try again."); }
    finally { busy.current = false; setSaving(false); }
  }

  if (!editing) return canEdit ? <button type="button" className="enterprise-pricing-edit-value" aria-label={`Edit ${label}`} onClick={() => {
    baseline.current = value == null ? "" : String(value);
    setDraft(baseline.current); setError(""); cancelled.current = false; setEditing(true);
  }}>{display}</button> : <span>{display}</span>;

  return <div className="enterprise-pricing-value-editor">
    <input className="input" type="text" inputMode="decimal" aria-label={label} aria-invalid={Boolean(error)}
      autoFocus readOnly={saving} value={draft} onFocus={event => event.target.select()}
      onChange={event => { setDraft(event.target.value); setError(""); }} onBlur={save}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); save(); }
        if (event.key === "Escape" && !busy.current) { event.preventDefault(); cancelled.current = true; setEditing(false); setError(""); }
      }} />
    {saving && <small role="status">Saving…</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
