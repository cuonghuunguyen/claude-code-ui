// Entry of the docs scenes: boots the real App with the scene's storage, theme and hash; the fake daemon (fake-client.ts) answers it.

import { createRoot } from "react-dom/client";
import { App } from "../src/App.tsx";
import { GUIDE_KEY, takeFirstUseSnapshot } from "../src/guide.ts";
import "../src/index.css";
import { applyTheme } from "../src/theme.ts";
import { SCENES } from "./index.ts";
import { sceneEmitted, sceneName } from "./fake-client.ts";

const scene = SCENES[sceneName()];
if (!scene) throw new Error(`unknown scene "${sceneName()}"`);
const params = new URLSearchParams(location.search);

// A clean browser every load: the scene's keys only. The guide is marked done so no tour starts.
localStorage.clear();
const storage = { [GUIDE_KEY]: JSON.stringify({ v: 1, origin: "existing", basics: "done", session: "done" }), ...scene.storage };
for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
takeFirstUseSnapshot();
applyTheme(params.get("theme") === "dark" ? "dark" : "light")();
if (location.hash !== scene.hash) location.hash = scene.hash;

createRoot(document.getElementById("root")!).render(
  <>
    <App />
  </>,
);

// Ready: the scene's events are in and the UI had time to render and measure.
void sceneEmitted
  .then(() => document.fonts.ready)
  .then(() => new Promise((r) => setTimeout(r, 1500)))
  .then(() => void (document.body.dataset.sceneReady = "1"));
