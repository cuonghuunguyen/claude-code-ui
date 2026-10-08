// Terminal panel (OpenCode terminal-panel-v2): tabs "Terminal N" + "+", one xterm per terminal. The PTYs live in the daemon
// (terminals.ts), so a reconnect re-attaches and redraws from the daemon's scrollback.
import { MAX_TERMINAL_INPUT_BYTES } from "@claude-ui/protocol";
import type { TerminalAttachResult, TerminalCreateResult, TerminalInfo, TerminalListResult } from "@claude-ui/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal-font.css";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { connect, ConnectionStatus } from "./client.ts";
import { TERMINAL_FONT, loadTerminalFont, terminalFontSettled } from "./terminal-font.ts";
import { leavesTerminal, specOf } from "./keymap.ts";
import { withKey } from "./shortcuts.ts";
import { IconButton } from "./tabs-bar.tsx";
import { useDark } from "./theme.ts";

type Client = ReturnType<typeof connect>;

/** The selected terminal's ID (IDs are unique across projects), so a reload selects it again. */
const ACTIVE_KEY = "claude-ui.terminalActive";
const storage = {
  get: () => {
    try {
      return localStorage.getItem(ACTIVE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (id: string) => {
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      // Storage blocked: a reload selects the first terminal.
    }
  },
};

/**
 * Mounted when the user opens the panel: then, with none running, it starts one. A project switch (`cwd`) or a reconnect
 * to an empty list starts none. `onEmpty`: the last terminal was closed or its shell exited; the panel should hide.
 */
/** `newTick`: bumped by the New terminal shortcut; each bump adds a terminal. */
export function TerminalPanel({ client, status, cwd, onEmpty, newTick = 0 }: { client: Client; status: ConnectionStatus; cwd: string; onEmpty: () => void; newTick?: number }) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const [shownCwd, setShownCwd] = useState(cwd);
  if (cwd !== shownCwd) {
    setShownCwd(cwd);
    setTerminals([]);
    setError(undefined);
  }
  const spawn = useRef(true);
  // A tab selected with a click (or a new terminal) focuses its shell; one selected with the arrow keys keeps the focus.
  const focusShell = useRef(true);
  // Bumped by a click on the tab already selected: its shell takes the focus again.
  const [focusTick, setFocusTick] = useState(0);

  const create = async () => {
    setError(undefined);
    focusShell.current = true;
    try {
      // The size is fixed by the view's fit right after it attaches.
      const { terminal } = await client.request<TerminalCreateResult>({ type: "terminal.create", cwd, cols: 80, rows: 24 });
      setTerminals((ts) => [...ts, terminal]);
      setActiveId(terminal.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const seenTick = useRef(newTick);
  useEffect(() => {
    if (newTick === seenTick.current) return;
    seenTick.current = newTick;
    void create();
  }, [newTick]);

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
        const has = (id?: string) => r.terminals.some((t) => t.id === id);
        setActiveId((a) => (has(a) ? a : has(storage.get()) ? storage.get() : r.terminals[0]?.id));
        if (!r.terminals.length && spawn.current) void create();
        spawn.current = false;
      },
      (e: Error) => !stale && e.message !== "disconnected" && setError(e.message),
    );
    return () => void (stale = true);
  }, [client, status, cwd]);

  useEffect(() => void (activeId && storage.set(activeId)), [activeId]);

  useEffect(() => client.onTerminal((m) => m.type === "terminal.exit" && remove(m.terminalId)), [client]);

  const focusable = terminals.some((t) => t.id === activeId) ? activeId : terminals[0]?.id;
  const onTabKey = (e: KeyboardEvent) => {
    const at = terminals.findIndex((t) => t.id === focusable);
    const n = terminals.length;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (at < 0 || to === undefined || (e.target as HTMLElement).getAttribute("role") !== "tab") return;
    e.preventDefault();
    focusShell.current = false;
    const next = terminals[to % n]!.id;
    setActiveId(next);
    e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[to % n]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal">
      {/* WAI-ARIA tabs like tabs-bar.tsx: one tab in the Tab order; arrows, Home and End select and focus. */}
      {/* OpenCode terminal-panel-v2: tabs bar 52px, tab text 14px/500. */}
      <div className="flex h-13 shrink-0 items-center gap-1 border-b px-2 font-[500] text-[14px]">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Terminals" onKeyDown={onTabKey}>
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`flex h-7 shrink-0 items-center rounded-md max-md:h-11 ${t.id === activeId ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent"}`}
            >
              <button
                role="tab"
                aria-selected={t.id === activeId}
                tabIndex={t.id === focusable ? 0 : -1}
                className="h-full cursor-pointer whitespace-nowrap rounded-md pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => ((focusShell.current = true), setActiveId(t.id), setFocusTick((n) => n + 1))}
                data-testid="terminal-tab"
              >
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
        </div>
        <IconButton label={withKey("New terminal", specOf("terminal.new"))} onClick={() => void create()} testId="terminal-new">
          <PlusIcon />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="shrink-0 border-b px-3.5 py-1 text-destructive text-xs">
          {error}
        </p>
      )}
      {terminals.map((t) => (
        <TerminalView key={t.id} client={client} status={status} id={t.id} active={t.id === activeId} focusShell={focusShell} focusTick={focusTick} onInputError={setError} />
      ))}
    </div>
  );
}

/** `onInputError`: the daemon refused input (e.g. input_backlog: the shell does not read), or undefined once it takes input again. */
function TerminalView({
  client,
  status,
  id,
  active,
  focusShell,
  focusTick,
  onInputError,
}: {
  client: Client;
  status: ConnectionStatus;
  id: string;
  active: boolean;
  focusShell: RefObject<boolean>;
  focusTick: number;
  onInputError: (message: string | undefined) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: Terminal; show: () => void }>(undefined);
  const connected = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  connected.current = status === "connected";
  const dark = useDark();

  useEffect(() => {
    // OpenCode terminal.tsx options.
    const t = new Terminal({ cursorBlink: true, cursorStyle: "bar", fontSize: 14, scrollback: 10_000, fontFamily: TERMINAL_FONT });
    const fit = new FitAddon();
    t.loadAddon(fit);
    // Opened once the box is on screen, then fitted to it. Opened in a hidden box (a tab not selected after a reload),
    // xterm measured no cell size and its fit on the first show left the viewport above the newest rows, frozen there.
    // Also not before the icon font is loaded (or 3 s passed): xterm caches the cell and glyph widths it measures at open.
    let fontReady = false;
    let disposed = false;
    const show = () => {
      if (disposed || !fontReady || !box.current?.offsetParent) return;
      if (!t.element) t.open(box.current);
      fit.fit();
    };
    term.current = { t, show };
    let settled = false;
    void terminalFontSettled().then(() => (settled = true));
    void loadTerminalFont().then(() => {
      fontReady = true;
      show();
      // The focus asked for before the open (a new or clicked tab) did nothing: xterm has no textarea until it is open.
      if (activeRef.current && focusShell.current && t.element) t.focus();
      // The wait ran out before the font did: measure again once it is there (xterm only does when the option changes) and refit.
      if (!settled && !disposed) void terminalFontSettled().then(() => !disposed && late());
    });
    const late = () => {
      if (!t.element) return;
      t.options.fontFamily = `${TERMINAL_FONT}, monospace`;
      t.options.fontFamily = TERMINAL_FONT;
      fit.fit();
    };
    // Typed while offline it would arrive late, out of context: dropped.
    t.onData((data) => {
      if (!connected.current) return;
      for (const part of inputParts(data))
        client.request({ type: "terminal.input", terminalId: id, data: part }).then(
          () => onInputError(undefined),
          (e: Error) => e.message !== "disconnected" && onInputError(e.message),
        );
    });
    t.onResize(({ cols, rows }) => connected.current && client.request({ type: "terminal.resize", terminalId: id, cols, rows }).catch(() => {}));
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Left to the app's shortcuts (Toggle terminal, tab keys, ...), not a NUL for the shell.
      if (leavesTerminal(e)) return false;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Copy: Ctrl+Shift+C, Cmd+C, or Ctrl+C over a selection (without one it is the shell's interrupt).
      if (mod && k === "c" && (e.shiftKey || e.metaKey || t.hasSelection())) {
        // No selection: the clipboard keeps what it has.
        if (t.hasSelection()) void navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        return false;
      }
      // Paste: the browser's paste event, which xterm turns into input (bracketed paste when the shell asks).
      return !(mod && k === "v");
    });
    const off = client.onTerminal((m) => m.terminalId === id && m.type === "terminal.output" && t.write(m.data));
    const ro = new ResizeObserver(show);
    ro.observe(box.current!);
    return () => {
      disposed = true;
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
        v.show();
        client.request({ type: "terminal.resize", terminalId: id, cols: v.t.cols, rows: v.t.rows }).catch(() => {});
      },
      () => {}, // gone (terminal.exit) or disconnected (attached again on reconnect)
    );
  }, [client, status, id]);

  useEffect(() => {
    const v = term.current;
    if (!active || !v) return;
    v.show();
    if (focusShell.current) v.t.focus();
  }, [active, focusTick]);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--foreground").trim();
    const bg = css.getPropertyValue("--card").trim();
    // OpenCode: selection = foreground at 25% (dark) / 20% (light).
    if (term.current) term.current.t.options.theme = { foreground: fg, cursor: fg, background: bg, selectionBackground: fg.length === 7 ? fg + (dark ? "40" : "33") : undefined };
  }, [dark]);

  // FitAddon sizes xterm from its parent's width, padding included: the padding goes on a wrapper, not on the box.
  // letter-spacing 0: xterm's DOM renderer adds the gap between its canvas and DOM measure of "W" (0.056px on Linux
  // Chromium), which pushed a 51-column row 3px past its clip and cut the last glyph; the glyphs' own advance is the cell width.
  return (
    <div className={`min-h-0 flex-1 px-3.5 py-2 ${active ? "" : "hidden"}`} data-testid="terminal-view">
      <div ref={box} className="size-full [&_.xterm-rows]:[letter-spacing:0]!" />
    </div>
  );
}

/** 3 UTF-8 bytes at most per UTF-16 unit, so a part of this many units stays within MAX_TERMINAL_INPUT_BYTES. */
const PART = Math.floor(MAX_TERMINAL_INPUT_BYTES / 3);

/** A big paste in parts the daemon accepts; a part does not end inside a surrogate pair. */
export function inputParts(data: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + PART, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
    parts.push(data.slice(i, end));
    i = end;
  }
  return parts;
}
