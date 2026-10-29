import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ProductEditorDialog.css";

export function ProductEditorDialog({ name, sections, children, footer, onClose, onPrevious, onNext, busy, dirty, message }) {
  const dialog = useRef(null);
  const [active, setActive] = useState(sections[0]?.[0]);
  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    const focused = document.activeElement;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = previousOverflow; focused?.focus(); };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  return createPortal(<dialog ref={dialog} className="product-editor-dialog enterprise-pricing-page" aria-labelledby="product-editor-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="product-editor-header">
      <div><button autoFocus type="button" className="product-editor-back" disabled={busy} onClick={onClose}>← Back to products</button>
        <h2 id="product-editor-title">Edit {name || "product"}</h2></div>
      <div className="product-editor-neighbors"><button className="button alt" type="button" disabled={busy || !onPrevious} onClick={onPrevious}>← Previous product</button>
        <button className="button alt" type="button" disabled={busy || !onNext} onClick={onNext}>Next product →</button></div>
    </header>
    <div className="product-editor-body">
      <nav className="product-editor-nav" aria-label="Product sections">{sections.map(([id, label]) => <button key={id} type="button"
        aria-current={active === id ? "location" : undefined} onClick={() => {
          setActive(id); dialog.current.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}>{label}</button>)}</nav>
      <div className="product-editor-content">{children}</div>
    </div>
    <footer className="product-editor-footer"><span role="status">{message || (dirty ? "Unsaved changes" : "All changes saved")}</span>
      <div className="product-editor-actions">{footer}</div></footer>
  </dialog>, document.body);
}
