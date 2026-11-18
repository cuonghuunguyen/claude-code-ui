// Inline visualizations (GH-690, docs/spec.md "Inline visualizations"): a ```visualize fence drawn in a sandboxed frame of the daemon's /visualize shell page.
// The frame mounts only while the block is near the viewport (its last height stays as the placeholder); "Show code" returns the source.
import { DownloadIcon, Maximize2Icon, XIcon } from "lucide-react";
import { createContext, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { clampHeight } from "./addons.ts";
import { downloadText } from "./download.ts";
import { useT } from "./i18n.ts";
import { useNear } from "./lib/use-near.ts";
import { useColorTheme, useDark } from "./theme.ts";

/** Settings › Chat › Inline visualizations: off (or an older daemon without the setting) shows the fence as code. */
export const VisualizeContext = createContext(false);
/** Reads a visualization file's text (fs.read); undefined outside the app. */
export const VisualizeReadContext = createContext<((path: string) => Promise<string>) | undefined>(undefined);
/** A fence that is only an absolute .html path: the skill wrote the HTML with the Write tool, so the reply streams no HTML. */
/** Set inside a question card: a frame there may post `answer {text}` to fill the Other field (never submits). */
export const VisualizeAnswerContext = createContext<((text: string) => void) | undefined>(undefined);
/** Longest `answer` text a frame may hand over. */
export const ANSWER_MAX = 2000;
const FILE = /^(?:\/|[A-Za-z]:[\\/])[^\n]*\.html?$/;

/** The host tokens handed to the frame (a fixed list: the frame never reads the app). */
const VARS = ["--background", "--foreground", "--card", "--card-foreground", "--primary", "--primary-foreground", "--secondary", "--muted", "--muted-foreground", "--border", "--accent", "--ring", "--destructive", "--success", "--warning", "--info", "--radius", "--font-sans"];
/** `--chart-1..8`: series colours from the colour theme's syntax and status tokens, so each palette (Catppuccin, Nord, ...) recolours the series; all reach 4.5:1 on the theme background. */
const CHART = ["--syntax-function", "--syntax-string", "--syntax-number", "--syntax-keyword", "--warning", "--syntax-variable", "--syntax-type", "--info"];
const themeVars = () => {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  // --scheme feeds the frame's color-scheme: without it the frame keeps the light canvas in a dark app.
  const scheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const pairs = [...VARS.map((n) => [n, v(n)] as const), ...CHART.map((n, i) => [`--chart-${i + 1}`, v(n)] as const)];
  return { ...Object.fromEntries(pairs.filter(([, x]) => x)), "--scheme": scheme };
};

/** A standalone page of the fragment: the current theme tokens are written in, so the file draws the same outside the app. */
export const standaloneHtml = (code: string, title: string): string => {
  const { "--scheme": scheme, ...vars } = themeVars();
  const root = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("");
  const esc = title.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc}</title>
<style>:root{${root}color-scheme:${scheme}}body{margin:16px;background:var(--background);color:var(--foreground);font:13px var(--font-sans,system-ui)}</style>
</head><body>
${code}
</body></html>
`;
};
/** The download name: the file's own name for a file fence, else `visualization.html`. */
const fileName = (path: string) => path.split(/[\\/]/).pop() || "visualization.html";
/** The icon buttons of a streamdown table's toolbar. */
const ICON_BTN = "cursor-pointer rounded p-1 text-muted-foreground transition-all hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** Streamdown renderer of the `visualize` fence: a placeholder while it streams (re-highlighting a growing HTML block per token stalls the UI), the frame once it is closed. */
export function VisualizeFence({ code, isIncomplete }: { code: string; isIncomplete: boolean; language: string }) {
  const t = useT();
  if (isIncomplete) return <div data-testid="visualize-pending" className="text-muted-foreground text-xs">{t("visualize.drawing")}</div>;
  const path = code.trim();
  return FILE.test(path) ? <VisualizeFile path={path} /> : <VisualizeBlock code={code} />;
}

function VisualizeFile({ path }: { path: string }) {
  const t = useT();
  const read = use(VisualizeReadContext);
  const [html, setHtml] = useState<string | { error: string }>();
  useEffect(() => {
    let live = true;
    setHtml(undefined);
    if (!read) return void setHtml({ error: "no reader" });
    read(path).then(
      (c) => live && setHtml(c),
      (e: unknown) => live && setHtml({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => void (live = false);
  }, [read, path]);
  if (typeof html === "string") return <VisualizeBlock code={html} name={fileName(path)} />;
  return (
    <div data-testid={html ? "visualize-error" : "visualize-pending"} className="text-muted-foreground text-xs">
      {html ? t("visualize.unavailable", { path, error: html.error }) : t("visualize.drawing")}
    </div>
  );
}

export function VisualizeBlock({ code, name = "visualization.html" }: { code: string; name?: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The expanded frame: a second frame of the same code, filling the window. */
  const big = useRef<HTMLIFrameElement>(null);
  const near = useNear(box);
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(48);
  const live = (near && !showCode) || expanded;
  const dark = useDark();
  const theme = useColorTheme();
  const html = useRef(code);
  html.current = code;
  const onAnswer = use(VisualizeAnswerContext);
  const answer = useRef(onAnswer);
  answer.current = onAnswer;
  // The frame has an opaque origin, so every message to it uses target "*"; its own messages are accepted only from this frame's window.
  useLayoutEffect(() => {
    if (!live) return;
    const on = (e: MessageEvent) => {
      const inline = frame.current?.contentWindow;
      const w = [inline, big.current?.contentWindow].find((x) => x && e.source === x);
      const d = e.data as { v?: unknown; type?: unknown; height?: unknown; text?: unknown } | null;
      if (!w || d?.v !== 1) return;
      if (d.type === "ready") w.postMessage({ v: 1, type: "render", html: html.current, vars: themeVars() }, "*");
      // The expanded frame fills the window and scrolls inside: only the inline frame sizes the block.
      else if (d.type === "height" && w === inline && typeof d.height === "number" && Number.isFinite(d.height)) setHeight(clampHeight(d.height, 800));
      else if (d.type === "answer" && typeof d.text === "string" && d.text.length <= ANSWER_MAX) answer.current?.(d.text);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [live]);
  useLayoutEffect(() => {
    for (const f of [frame.current, big.current]) f?.contentWindow?.postMessage({ v: 1, type: "theme", vars: themeVars() }, "*");
  }, [dark, theme]);
  useEffect(() => {
    if (!expanded) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [expanded]);
  const download = () => downloadText(name, standaloneHtml(code, name.replace(/\.html?$/i, "")), "text/html");
  const downloadBtn = (
    <button type="button" onClick={download} title={t("visualize.download")} aria-label={t("visualize.download")} className={ICON_BTN} data-testid="visualize-download">
      <DownloadIcon aria-hidden size={14} />
    </button>
  );
  return (
    <div ref={box} data-testid="visualize-block" className="flex flex-col gap-1">
      {/* In a question card the toolbar is noise; the card's answer is what matters. */}
      {!onAnswer && <div className="flex items-center justify-end gap-1">
        <button type="button" onClick={() => setShowCode((v) => !v)} aria-pressed={showCode} className="rounded px-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" data-testid="visualize-show-code">
          {showCode ? t("visualize.showVisual") : t("visualize.showCode")}
        </button>
        {downloadBtn}
        <button type="button" onClick={() => setExpanded(true)} title={t("visualize.expand")} aria-label={t("visualize.expand")} className={ICON_BTN} data-testid="visualize-expand">
          <Maximize2Icon aria-hidden size={14} />
        </button>
      </div>}
      {expanded &&
        createPortal(
          <div role="dialog" aria-modal="true" aria-label={t("visualize.frameTitle")} data-testid="visualize-fullscreen" className="fixed inset-0 z-50 flex flex-col bg-background">
            <div className="flex items-center justify-end gap-1 p-4">
              {downloadBtn}
              <button type="button" onClick={() => setExpanded(false)} title={t("visualize.collapse")} aria-label={t("visualize.collapse")} className={ICON_BTN} data-testid="visualize-collapse">
                <XIcon aria-hidden size={20} />
              </button>
            </div>
            <div className="min-h-0 flex-1 px-4 pb-4">
              <iframe ref={big} src="/visualize" sandbox="allow-scripts" referrerPolicy="no-referrer" title={t("visualize.frameTitle")} data-testid="visualize-frame-expanded" className="size-full rounded-md border" />
            </div>
          </div>,
          document.body,
        )}
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
