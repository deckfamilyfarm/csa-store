import React from "react";
import { Storefront } from "./components/Storefront.jsx";
import "./styles.css";

export default function GuestView() {
  return <Storefront userState="guest" />;
}
