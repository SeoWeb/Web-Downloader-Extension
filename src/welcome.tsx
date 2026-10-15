import React from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import "./styles/rtl.css"; // RTL support styles
import "./i18n/config"; // Initialize i18n
import Welcome from "./components/welcome";

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <Welcome />
  </React.StrictMode>,
);
