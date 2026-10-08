import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { takeFirstUseSnapshot } from "./guide.ts";
import "./index.css";
import { applyTheme, loadPref } from "./theme.ts";

// First thing, before the theme or the app write any claude-ui.* key: the guided tour starts only in a browser that has none (docs/spec.md "First-use guide").
takeFirstUseSnapshot();

// Before the first render, so a dark theme does not flash light. App's effect owns the "system" listener; stop this one.
applyTheme(loadPref())();

// Pasting the pairing URL into an already open tab only changes the fragment; reload to reconnect with the token.
addEventListener("hashchange", () => location.hash.includes("token=") && location.reload());

// Web Push needs a service worker; secure contexts only (https or localhost).
void navigator.serviceWorker?.register("/sw.js").catch((e) => console.error("service worker:", e));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
