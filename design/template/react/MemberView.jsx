import React from "react";
import { Storefront } from "./components/Storefront.jsx";
import "./styles.css";

export default function MemberView() {
  return <Storefront userState="member" />;
}
