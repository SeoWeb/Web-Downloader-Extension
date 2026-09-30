import React from "react";
import { createRoot } from "react-dom/client";
import Welcome from "./components/welcome";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <Welcome />
  </React.StrictMode>,
);
