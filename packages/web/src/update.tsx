// Update notice (docs/spec.md "Updates"), OpenCode's persistent "Update available" toast with "Install and restart" / "Not yet":
// available -> installing -> waiting for busy sessions -> restarting; the client then reconnects to the new daemon.
import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import type { ServerMessage, UpdateState } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { TOAST_CARD } from "./toast.tsx";

export type UpdateInfo = { version: string; current: string; state?: UpdateState };
export type UpdateMessage = Extract<ServerMessage, { type: "update_available" | "update_state" }>;

/** The notice after a daemon message: `update_available` starts over (also after a failed install). */
export function nextUpdate(u: UpdateInfo | undefined, m: UpdateMessage): UpdateInfo | undefined {
  if (m.type === "update_available") return { version: m.version, current: m.current };
  const { type: _, ...state } = m;
  return u && { ...u, state };
}

const DISMISSED_KEY = "claude-ui.update.dismissed";
function dismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the notice says in each phase. */
export function updateText(u: UpdateInfo, error?: string): { title: string; description?: string } {
  if (error) return { title: "Update failed", description: error };
  switch (u.state?.phase) {
    case "installing":
      return { title: `Installing claude-ui ${u.version}…`, description: "Sessions keep running meanwhile." };
    case "waiting": {
      const { waitingFor, terminals } = u.state;
      const closes = terminals ? `${waitingFor ? " and closes" : "Restarting closes"} ${plural(terminals, "open terminal")}` : "";
      if (!waitingFor) return { title: "Update installed", description: `${closes}.` };
      return { title: "Update installed", description: `Restarts when ${waitingFor === 1 ? "1 session is" : `${waitingFor} sessions are`} idle${closes}. Restart now ends ${plural(waitingFor, "running session")}.` };
    }
    case "restarting":
      return { title: `Restarting claude-ui ${u.version}…`, description: "This page reconnects by itself." };
    default:
      return { title: "Update available", description: `claude-ui ${u.version} is available (you have ${u.current}).` };
  }
}

const ACTION =
  "cursor-pointer rounded-sm text-[13px] leading-5 font-medium text-muted-foreground outline-none first:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:min-h-11";

export function UpdateToast({ update, request }: { update: UpdateInfo; request: (m: Request) => Promise<unknown> }) {
  const [hiddenFor, setHiddenFor] = useState<string | null>(dismissed);
  const [error, setError] = useState<string>();
  const phase = update.state?.phase;
  // "Not yet" hides only this version; an update under way (maybe started in another tab) shows again.
  if (hiddenFor === update.version && !phase) return null;
  const fail = (e: Error) => e.message !== "disconnected" && setError(e.message);
  const install = () => {
    setError(undefined);
    request({ type: "update.install" })
      .then(() => request({ type: "update.restart" }))
      .catch(fail);
  };
  const notYet = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, update.version);
    } catch {}
    setError(undefined);
    setHiddenFor(update.version);
  };
  const { title, description } = updateText(update, error);
  const actions: [string, () => void][] =
    error || !phase ? [[error ? "Try again" : "Update and restart", install], ["Not yet", notYet]] : phase === "waiting" ? [["Restart now", () => void request({ type: "update.restart", now: true }).catch(fail)]] : [];
  return (
    <div role="status" data-testid="update-toast" className={`${TOAST_CARD} flex items-start gap-2.5`}>
      <DownloadIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[13px] leading-5 font-medium">{title}</p>
        {description && <p className={`text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere] ${error ? "max-h-40 overflow-y-auto font-mono text-xs whitespace-pre-wrap" : ""}`}>{description}</p>}
        {actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-4">
            {actions.map(([label, onClick]) => (
              <button key={label} type="button" className={ACTION} onClick={onClick}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
