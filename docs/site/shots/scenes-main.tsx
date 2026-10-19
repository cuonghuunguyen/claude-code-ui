// Entry of the docs screenshots: boots the real App with the scene's storage, theme and hash; the fake daemon (packages/web/src/fake-client.ts) answers it.

import { createRoot } from "react-dom/client";
import { App } from "../../../packages/web/src/App.tsx";
import { fakeEmitted, useFakeDaemon } from "../../../packages/web/src/fake-client.ts";
import { GUIDE_KEY, takeFirstUseSnapshot } from "../../../packages/web/src/guide.ts";
import "./shots.css";
import { applyTheme } from "../../../packages/web/src/theme.ts";
import { daemonFor } from "./defaults.ts";
import { SCENES } from "./index.ts";

const params = new URLSearchParams(location.search);
const name = params.get("scene") ?? "";
const scene = SCENES[name];
if (!scene) throw new Error(`unknown scene "${name}"; known: ${Object.keys(SCENES).join(", ")}`);

// A clean browser every load: the scene's keys only. The guide is marked done so no tour starts.
localStorage.clear();
const storage = { [GUIDE_KEY]: JSON.stringify({ v: 1, origin: "existing", basics: "done", session: "done" }), ...scene.storage };
for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
takeFirstUseSnapshot();
applyTheme(params.get("theme") === "dark" ? "dark" : "light")();
if (location.hash !== scene.hash) location.hash = scene.hash;
useFakeDaemon(daemonFor(scene));

createRoot(document.getElementById("root")!).render(
  <>
    <App />
  </>,
);

// Ready: the scene's events are in and the UI had time to render and measure.
void fakeEmitted
  .then(() => document.fonts.ready)
  .then(() => new Promise((r) => setTimeout(r, 1500)))
  .then(() => void (document.body.dataset.sceneReady = "1"));
