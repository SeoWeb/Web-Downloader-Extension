import React from "react";
import { createRoot } from "react-dom/client";
import SidePanel from "./components/sidepanel";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

chrome.runtime.connect({ name: 'sidepanel' });

root.render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);
