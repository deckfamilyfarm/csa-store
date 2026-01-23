import React from "react";
import ReactDOM from "react-dom/client";
import { Storefront } from "./components/Storefront.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Storefront />
  </React.StrictMode>
);
