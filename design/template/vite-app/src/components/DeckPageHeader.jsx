import React, { useState } from "react";

export function DeckPageHeader({
  navLinks = [],
  authLabel = "",
  onAuthAction = null
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="subscribe-header">
      <div className="container subscribe-header-row">
        <a className="subscribe-wordmark" href="https://www.deckfamilyfarm.com">
          <img
            className="subscribe-wordmark-logo"
            src="/images/subscribe-logo.avif"
            alt="Deck Family Farm logo"
          />
        </a>
        {authLabel && onAuthAction ? (
          <div className="subscribe-header-utility">
            <button className="subscribe-auth-link" type="button" onClick={onAuthAction}>
              {authLabel}
            </button>
          </div>
        ) : null}
        <button
          className={`subscribe-mobile-menu-button${mobileMenuOpen ? " open" : ""}`}
          type="button"
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileMenuOpen ? "true" : "false"}
          onClick={() => setMobileMenuOpen((value) => !value)}
        >
          <span />
          <span />
          <span />
        </button>
        <nav className={`subscribe-nav${mobileMenuOpen ? " mobile-open" : ""}`}>
          {navLinks.map((link) =>
            Array.isArray(link.children) && link.children.length > 0 ? (
              <div key={link.label} className="subscribe-nav-group">
                <span className="subscribe-nav-group-title">{link.label}</span>
                <div className="subscribe-nav-group-links">
                  {link.children.map((child) => (
                    <a
                      key={`${link.label}-${child.label}-${child.href}`}
                      href={child.href}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      {child.label}
                    </a>
                  ))}
                </div>
              </div>
            ) : (
              <a
                key={`${link.label}-${link.href}`}
                className="subscribe-nav-single"
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            )
          )}
        </nav>
      </div>
    </header>
  );
}
