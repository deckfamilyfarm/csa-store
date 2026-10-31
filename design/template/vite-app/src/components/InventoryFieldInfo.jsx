import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./FieldInfo.css";

export const INVENTORY_FIELD_HELP = {
  stockOnFarm: "Yes means some stock is available in a freezer or fridge anywhere on the farm. No means none and sets on-farm pounds to zero. Yes can be used when the weight is unknown. Not checked means farm availability has not been reviewed. Full Farm Stock is independent.",
  stockOnFarmLbs: "Total pounds currently in all farm freezers and fridges, regardless of selling unit or package size. Enter the total, not an amount to add. Blank means weight unknown; 0 means none. Positive pounds set Yes; 0 sets No. Saved locally only; sales do not yet deduct from this count. Full Farm Stock is independent.",
  inventory: "The quantity available through Full Farm. Enable Full Farm Track Inventory to edit this number. Saving sends the quantity to Local Line. This is separate from physical availability recorded by Stock on Farm.",
  trackInventory: "When enabled, Full Farm uses the stock quantity to limit how much can be ordered. Enable this to edit Full Farm Stock. Saving updates Local Line; it does not change Stock on Farm.",
  visible: "Controls whether the product is visible in the Full Farm storefront. Hiding a product does not change its stock quantity or Stock on Farm. Saving updates visibility in Local Line.",
};

export function InventoryFieldInfo({ field, label }) {
  return <FieldInfo label={label}>{INVENTORY_FIELD_HELP[field]}</FieldInfo>;
}

export function FieldInfo({ label, children }) {
  const id = useId();
  const button = useRef(null);
  const tooltip = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = button.current.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const below = anchor.bottom + 8;
    setPosition({
      top: Math.max(8, below + box.height <= window.innerHeight - 8 ? below : anchor.top - box.height - 8),
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const outside = event => {
      if (!button.current?.contains(event.target) && !tooltip.current?.contains(event.target)) dismiss();
    };
    const escape = event => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return <span className="inventory-field-info">
    <button ref={button} type="button" className="inventory-field-info-button" aria-label={`About ${label}`}
      aria-expanded={open} aria-describedby={open ? id : undefined}
      onFocus={() => setOpen(true)} onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <span aria-hidden="true">i</span>
    </button>
    {open && createPortal(<span ref={tooltip} id={id} role="tooltip" className="inventory-field-tooltip" style={position}>
      {children}
    </span>, document.body)}
  </span>;
}
