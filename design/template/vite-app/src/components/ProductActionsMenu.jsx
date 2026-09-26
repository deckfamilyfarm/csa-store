import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ProductActionsMenu({
  label,
  children = "More",
  disabled,
  items,
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef(null);
  const menu = useRef(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current.getBoundingClientRect();
    const panel = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(
          anchor.right - panel.width,
          window.innerWidth - panel.width - 8,
        ),
      ),
      top: Math.max(
        8,
        anchor.bottom + panel.height + 6 <= window.innerHeight - 8
          ? anchor.bottom + 6
          : anchor.top - panel.height - 6,
      ),
    });
    menu.current
      .querySelector("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    const dismissOutside = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const dismissOnScroll = (event) => {
      if (!menu.current?.contains(event.target)) {
        if (menu.current?.contains(document.activeElement))
          trigger.current?.focus({ preventScroll: true });
        setOpen(false);
      }
    };
    const dismissOnResize = () => setOpen(false);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismissOnResize);
    };
  }, [open]);

  function onKeyDown(event) {
    if (["Escape", "Tab"].includes(event.key)) {
      if (event.key === "Escape") event.preventDefault();
      trigger.current.focus({ preventScroll: true });
      setOpen(false);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = [
        ...menu.current.querySelectorAll("button:not(:disabled)"),
      ];
      const current = buttons.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current +
                (event.key === "ArrowDown" ? 1 : -1) +
                buttons.length) %
              buttons.length;
      buttons[next]?.focus();
    }
  }

  return (
    <>
      <button
        className="button alt products-menu-trigger"
        type="button"
        ref={trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
        <span aria-hidden="true">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={menu}
            className="products-action-menu"
            role="menu"
            aria-label={label}
            style={position}
            onKeyDown={onKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={item.danger ? "products-action-danger" : undefined}
                disabled={item.disabled || disabled}
                onClick={() => {
                  trigger.current.focus({ preventScroll: true });
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
