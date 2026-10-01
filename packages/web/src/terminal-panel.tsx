// Terminal panel (OpenCode terminal-panel-v2): tabs "Terminal N" + "+", one xterm per terminal. The PTYs live in the daemon
// (terminals.ts), so a reconnect re-attaches and redraws from the daemon's scrollback.
import type { TerminalAttachResult, TerminalCreateResult, TerminalInfo, TerminalListResult } from "@claude-ui/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { connect, ConnectionStatus } from "./client.ts";
import { KEYS, matchesKey } from "./shortcuts.ts";
import { IconButton } from "./tabs-bar.tsx";
import { useDark } from "./theme.ts";

type Client = ReturnType<typeof connect>;

/** `onEmpty`: the last terminal was closed or its shell exited; the panel should hide. */
export function TerminalPanel({ client, status, cwd, onEmpty }: { client: Client; status: ConnectionStatus; cwd: string; onEmpty: () => void }) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();

  const create = async () => {
    setError(undefined);
    try {
      // The size is fixed by the view's fit right after it attaches.
      const { terminal } = await client.request<TerminalCreateResult>({ type: "terminal.create", cwd, cols: 80, rows: 24 });
      setTerminals((ts) => [...ts, terminal]);
      setActiveId(terminal.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const latest = useRef({ terminals, onEmpty });
  latest.current = { terminals, onEmpty };
  const remove = (id: string) => {
    const ts = latest.current.terminals;
    const i = ts.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rest = ts.filter((t) => t.id !== id);
    latest.current.terminals = rest;
    setTerminals(rest);
    // The left neighbour becomes active, like closing a tab.
    setActiveId((a) => (a === id ? rest[Math.max(0, i - 1)]?.id : a));
    if (!rest.length) latest.current.onEmpty();
  };

  // On open and after every reconnect: the daemon's list is the truth (a daemon restart ends every shell).
  useEffect(() => {
    if (status !== "connected") return;
    let stale = false;
    client.request<TerminalListResult>({ type: "terminal.list", cwd }).then(
      (r) => {
        if (stale) return;
        setTerminals(r.terminals);
        setActiveId((a) => (r.terminals.some((t) => t.id === a) ? a : r.terminals[0]?.id));
        if (!r.terminals.length) void create();
      },
      (e: Error) => !stale && e.message !== "disconnected" && setError(e.message),
    );
    return () => void (stale = true);
  }, [client, status, cwd]);

  useEffect(() => client.onTerminal((m) => m.type === "terminal.exit" && remove(m.terminalId)), [client]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2 text-sm" role="tablist" aria-label="Terminals">
        {terminals.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`flex h-7 shrink-0 items-center rounded-md pl-2 max-md:h-11 ${t.id === activeId ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent"}`}
          >
            <button className="cursor-pointer whitespace-nowrap" onClick={() => setActiveId(t.id)} data-testid="terminal-tab">
              {t.title}
            </button>
            <IconButton
              label={`Close ${t.title}`}
              className="size-6 [&_svg]:size-3"
              onClick={() => {
                remove(t.id);
                client.request({ type: "terminal.close", terminalId: t.id }).catch(() => {});
              }}
            >
              <XIcon />
            </IconButton>
          </div>
        ))}
        <IconButton label="New terminal" onClick={() => void create()} testId="terminal-new">
          <PlusIcon />
        </IconButton>
        {error && <span className="truncate text-destructive text-xs">{error}</span>}
      </div>
      {terminals.map((t) => (
        <TerminalView key={t.id} client={client} status={status} id={t.id} active={t.id === activeId} />
      ))}
    </div>
  );
}

function TerminalView({ client, status, id, active }: { client: Client; status: ConnectionStatus; id: string; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: Terminal; fit: FitAddon }>(undefined);
  const connected = useRef(false);
  connected.current = status === "connected";
  const dark = useDark();

  useEffect(() => {
    // OpenCode terminal.tsx options.
    const t = new Terminal({ cursorBlink: true, cursorStyle: "bar", fontSize: 14, scrollback: 10_000, fontFamily: 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace' });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(box.current!);
    term.current = { t, fit };
    // Typed while offline it would arrive late, out of context: dropped.
    t.onData((data) => connected.current && client.request({ type: "terminal.input", terminalId: id, data }).catch(() => {}));
    t.onResize(({ cols, rows }) => connected.current && client.request({ type: "terminal.resize", terminalId: id, cols, rows }).catch(() => {}));
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Left to the app's Toggle terminal shortcut, not a NUL for the shell.
      if (matchesKey(KEYS.terminal, e)) return false;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Copy: Ctrl+Shift+C, Cmd+C, or Ctrl+C over a selection (without one it is the shell's interrupt).
      if (mod && k === "c" && (e.shiftKey || e.metaKey || t.hasSelection())) {
        void navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        return false;
      }
      // Paste: the browser's paste event, which xterm turns into input (bracketed paste when the shell asks).
      return !(mod && k === "v");
    });
    const off = client.onTerminal((m) => m.terminalId === id && m.type === "terminal.output" && t.write(m.data));
    const ro = new ResizeObserver(() => box.current?.offsetParent && fit.fit());
    ro.observe(box.current!);
    return () => {
      ro.disconnect();
      off();
      client.request({ type: "terminal.detach", terminalId: id }).catch(() => {});
      t.dispose();
      term.current = undefined;
    };
  }, [client, id]);

  // Attach on mount and after every reconnect: the reply precedes the live output on the socket.
  useEffect(() => {
    if (status !== "connected") return;
    client.request<TerminalAttachResult>({ type: "terminal.attach", terminalId: id }).then(
      ({ buffer }) => {
        const v = term.current;
        if (!v) return;
        v.t.reset();
        if (buffer) v.t.write(buffer);
        // The daemon's size may be another browser's: send this view's.
        if (box.current?.offsetParent) v.fit.fit();
        client.request({ type: "terminal.resize", terminalId: id, cols: v.t.cols, rows: v.t.rows }).catch(() => {});
      },
      () => {}, // gone (terminal.exit) or disconnected (attached again on reconnect)
    );
  }, [client, status, id]);

  useEffect(() => {
    const v = term.current;
    if (!active || !v) return;
    v.fit.fit();
    v.t.focus();
  }, [active]);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--foreground").trim();
    const bg = css.getPropertyValue("--card").trim();
    // OpenCode: selection = foreground at 25% (dark) / 20% (light).
    if (term.current) term.current.t.options.theme = { foreground: fg, cursor: fg, background: bg, selectionBackground: fg.length === 7 ? fg + (dark ? "40" : "33") : undefined };
  }, [dark]);

  return <div ref={box} className={`min-h-0 flex-1 px-3.5 py-2 ${active ? "" : "hidden"}`} data-testid="terminal-view" />;
}
