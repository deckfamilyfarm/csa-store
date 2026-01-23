import React from "react";

export function HeaderNav({ navLinks }) {
  return (
    <header className="site-header">
      <div className="container header-row">
        <div className="logo">Deck Family Farm CSA</div>
        <nav className="nav">
          {navLinks.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
