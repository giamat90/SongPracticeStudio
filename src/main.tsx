import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import DetachedHost from "./windows/DetachedHost";
import { panelFromLabel } from "./windows/protocol";
import "./styles/global.css";
import "./styles/polish.css";

// A window opened for a detached panel carries its panel in its label.
function detachedPanel() {
  try {
    return panelFromLabel(getCurrentWindow().label);
  } catch (e) {
    console.warn("[main] could not read the window label, starting the full app:", e);
    return null;
  }
}

const panel = detachedPanel();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {panel ? <DetachedHost panel={panel} /> : <App />}
  </React.StrictMode>
);
