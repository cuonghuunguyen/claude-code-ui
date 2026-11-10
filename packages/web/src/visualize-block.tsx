// Inline visualizations (GH-690, docs/spec.md "Inline visualizations"): a ```visualize fence drawn in a sandboxed frame of the daemon's /visualize shell page.
// The frame mounts only while the block is near the viewport (its last height stays as the placeholder); "Show code" returns the source.
import { createContext, useLayoutEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { clampHeight } from "./addons.ts";
import { useT } from "./i18n.ts";
import { useNear } from "./lib/use-near.ts";
import { useColorTheme, useDark } from "./theme.ts";

/** Settings › Chat › Inline visualizations: off (or an older daemon without the setting) shows the fence as code. */
export const VisualizeContext = createContext(false);

/** The host colours handed to the frame (a fixed list: the frame never reads the app). */
const VARS = ["--background", "--foreground", "--primary", "--primary-foreground", "--muted", "--muted-foreground", "--border", "--accent"];
const themeVars = () => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(VARS.map((n) => [n, cs.getPropertyValue(n).trim()] as const).filter(([, v]) => v));
};

/** Streamdown renderer of the `visualize` fence: code while the fence streams, the frame once it is closed. */
export function VisualizeFence({ code, isIncomplete }: { code: string; isIncomplete: boolean; language: string }) {
  return isIncomplete ? <CodeBlock code={code} language={"html" as never} /> : <VisualizeBlock code={code} />;
}

export function VisualizeBlock({ code }: { code: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const near = useNear(box);
  const [showCode, setShowCode] = useState(false);
  const [height, setHeight] = useState(48);
  const live = near && !showCode;
  const dark = useDark();
  const theme = useColorTheme();
  const html = useRef(code);
  html.current = code;
  // The frame has an opaque origin, so every message to it uses target "*"; its own messages are accepted only from this frame's window.
  useLayoutEffect(() => {
    if (!live) return;
    const on = (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      const d = e.data as { v?: unknown; type?: unknown; height?: unknown } | null;
      if (!w || e.source !== w || d?.v !== 1) return;
      if (d.type === "ready") w.postMessage({ v: 1, type: "render", html: html.current, vars: themeVars() }, "*");
      else if (d.type === "height" && typeof d.height === "number" && Number.isFinite(d.height)) setHeight(clampHeight(d.height, 800));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [live]);
  useLayoutEffect(() => void frame.current?.contentWindow?.postMessage({ v: 1, type: "theme", vars: themeVars() }, "*"), [dark, theme]);
  return (
    <div ref={box} data-testid="visualize-block" className="flex flex-col gap-1">
      <div className="flex justify-end">
        <button type="button" onClick={() => setShowCode((v) => !v)} aria-pressed={showCode} className="rounded px-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" data-testid="visualize-show-code">
          {showCode ? t("visualize.showVisual") : t("visualize.showCode")}
        </button>
      </div>
      {showCode ? (
        <CodeBlock code={code} language={"html" as never} />
      ) : near ? (
        <iframe ref={frame} src="/visualize" sandbox="allow-scripts" referrerPolicy="no-referrer" title={t("visualize.frameTitle")} data-testid="visualize-frame" className="w-full rounded-md border" style={{ height }} />
      ) : (
        <div style={{ height }} aria-hidden />
      )}
    </div>
  );
}
