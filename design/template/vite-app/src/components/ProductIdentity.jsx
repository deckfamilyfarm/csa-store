import React from "react";
import "./ProductIdentity.css";

export function ProductIdentity({ name, thumbnailUrl, unit, vendor, href, onClick }) {
  return <div className="product-identity">
    {thumbnailUrl && <img src={thumbnailUrl} alt="" loading="lazy" />}
    <div className="product-identity-copy">
      <strong title={name}>{href ? <a href={href} title={name} onClick={onClick}>{name}</a> : name}</strong>
      <span className="product-identity-meta">{[unit, vendor].filter(Boolean).join(" · ")}</span>
    </div>
  </div>;
}
