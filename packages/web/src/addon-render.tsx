// Addon renderers (GH-516, docs/spec.md "Addon host"): a code fence or a tool result drawn by an addon's frame instead of the built-in view.
// The frame mounts only while the block is near the viewport (its last height stays as the placeholder), and "Show raw" returns the built-in view.
import { use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { FenceRender, ToolRender } from "@claude-ui/addon-sdk";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { AddonFrame, type AddonHandle } from "./addon-frame.tsx";
import { AddonsContext, fenceLanguages, rendererFor } from "./addons.ts";
import { useT } from "./i18n.ts";
import { useNear } from "./lib/use-near.ts";

type Payload = FenceRender | ToolRender;

/** `target`: `fence:<lang>` or `tool:<name>`; `raw`: the built-in rendering. */
export function AddonBlock({ target, payload, raw }: { target: string; payload: Payload; raw: ReactNode }) {
  const t = useT();
  const r = rendererFor(use(AddonsContext), target);
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const [showRaw, setShowRaw] = useState(false);
  const [height, setHeight] = useState(48);
  const latest = useRef(payload);
  latest.current = payload;
  // Posted when the frame mounts (the handle queues it until the frame's `init`).
  const send = useCallback((h: AddonHandle | null) => void h?.post({ type: "render", ...latest.current }), []);
  // The addon went away (disabled, removed) while the block shows: the built-in view.
  if (!r) return raw;
  return (
    <div ref={box} data-testid="addon-block" data-addon={r.addon.name} className="flex flex-col gap-1">
      <div className="flex justify-end">
        <button type="button" onClick={() => setShowRaw((v) => !v)} aria-pressed={showRaw} className="rounded px-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" data-testid="addon-show-raw">
          {showRaw ? t("addons.showAddon", { name: r.addon.name }) : t("addons.showRaw")}
        </button>
      </div>
      {showRaw ? raw : near ? <AddonFrame handle={send} addon={r.addon} entry={r.entry} role="render" view="" sessionId="" onHeight={setHeight} className="w-full rounded-md border" style={{ height }} /> : <div style={{ height }} aria-hidden />}
    </div>
  );
}

/** The Streamdown renderer of every fence language an enabled addon claims; the same array while the set of languages stays. */
function FenceRenderer({ code, isIncomplete, language }: { code: string; isIncomplete: boolean; language: string }) {
  const plain = <CodeBlock code={code} language={language as never} />;
  return isIncomplete ? plain : <AddonBlock target={`fence:${language}`} payload={{ fence: { lang: language, source: code } }} raw={plain} />;
}
export function useAddonFenceRenderers() {
  const langs = fenceLanguages(use(AddonsContext).addons);
  const key = langs.join("\n");
  return useMemo(() => (langs.length ? [{ language: langs, component: FenceRenderer as never }] : []), [key]);
}
