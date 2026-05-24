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
        <div className="subscribe-header-utility">
          <button className="subscribe-auth-link" type="button" onClick={onAuthAction}>
            {authLabel}
          </button>
        </div>
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
          {navLinks.map((link) => (
            <a
              key={`${link.label}-${link.href}`}
              className="subscribe-nav-single"
              href={link.href}
              onClick={() => setMobileMenuOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
