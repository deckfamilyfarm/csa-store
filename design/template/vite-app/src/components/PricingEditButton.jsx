import React from "react";

export function PricingEditButton({ label, onClick }) {
  return <button type="button" className="enterprise-pricing-edit-icon" aria-label={label} title={label} onClick={onClick}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" />
      <path d="m13 6 5 5M4 15l5 5" />
    </svg>
  </button>;
}
