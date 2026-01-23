import React from "react";
import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/guest", label: "Guest" },
  { to: "/member", label: "Member" },
  { to: "/page/plan-chooser", label: "Plan" },
  { to: "/page/pantry", label: "Pantry" },
  { to: "/page/products", label: "Products" },
  { to: "/page/product", label: "Product" },
  { to: "/page/delivery", label: "Delivery" },
  { to: "/page/account", label: "Account" },
  { to: "/page/recipes", label: "Recipes" },
];

export function RouterNav() {
  const location = useLocation();

  return (
    <div className="router-nav">
      <div className="container">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className={location.pathname === link.to ? "active" : ""}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
