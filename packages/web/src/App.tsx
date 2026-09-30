import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { RotateCcwIcon } from "lucide-react";
import type {
  CreateResult,
  Event,
  FsEntry,
  FsListResult,
  FsSearchResult,
  ListResult,
  ModelInfo,
  ModelsResult,
  Part,
  RewindMode,
  RewindPreview,
  RespondResult,
  SessionInfo,
  SessionListItem,
  SetModelResult,
  SubscribeResult,
} from "@claude-ui/protocol";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { connect, type ConnectionStatus } from "./client.ts";
import { ImageStrip, readImages } from "./images.tsx";
import { choose, matchCommands } from "./commands.ts";
import { activeMention, insertMention } from "./mentions.ts";
import { groupByCwd, timeAgo } from "./sessions.ts";
import { rewindOptions } from "./rewind.ts";
import { useSmoothText } from "./smooth.ts";
import { disablePush, enablePush, pushSubscription, pushSupported, sendSubscription } from "./push.ts";
import { isUnread, loadSeen, saveSeen, seenNow, tabTitle, type Seen } from "./unread.ts";
import { PermissionMarker, PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, emptySession, pendingPermission, pendingQuestion, timeline, withEpoch, type SessionView, type ToolCall } from "./store.ts";
import { ContextGroup, SubagentGroup, Thinking, TodoList, ToolCard } from "./tool-card.tsx";

type Client = ReturnType<typeof connect>;

// The open session lives in the URL hash, so a reloaded tab reopens it.
const hashId = () => /^#[0-9a-f-]{36}$/i.exec(location.hash)?.[0].slice(1);

const pageFocused = () => document.visibilityState === "visible" && document.hasFocus();

/** True while this tab is visible and has focus: the only case in which a session counts as seen. */
function usePageFocused() {
  const [focused, setFocused] = useState(pageFocused);
  useEffect(() => {
    const update = () => setFocused(pageFocused());
    const events = ["focus", "blur", "visibilitychange"] as const;
    events.forEach((e) => window.addEventListener(e, update));
    return () => events.forEach((e) => window.removeEventListener(e, update));
  }, []);
  return focused;
}

export function App() {
  const [list, setList] = useState<SessionListItem[]>([]);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [activeId, setActiveId] = useState(hashId);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const [drawer, setDrawer] = useState(false);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Replies to subscribe / create / setModel: the freshest SessionInfo, incl. model.
  const [infos, setInfos] = useState<Record<string, SessionInfo>>({});
  const [seen, setSeen] = useState<Record<string, Seen>>(loadSeen);
  const [pushOn, setPushOn] = useState(false);
  // Bumped by a notification click: remounts the conversation, which starts scrolled to the bottom.
  const [scrollKey, setScrollKey] = useState(0);
  const focused = usePageFocused();
  const client = useRef<Client>(undefined);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const requested = useRef(new Set<string>());

  async function refreshList() {
    try {
      const { sessions } = await client.current!.request<ListResult>({ type: "session.list" });
      setList(sessions);
      // Live sessions are followed so their unread markers update without opening them.
      // ponytail: replays every live session's log into this tab; follow state only if that gets heavy.
      for (const s of sessions)
        if (s.state !== "closed" && !viewsRef.current[s.id] && !requested.current.has(s.id)) requested.current.add(s.id), void subscribe(s.id);
    } catch (e) {
      if ((e as Error).message !== "disconnected") setError((e as Error).message);
    }
  }

  // Replays events after the view's last seq, or everything when the daemon restarted (new logEpoch).
  // A session that is not live in the daemon is rebuilt from its transcript and resumes with the same ID on the next prompt.
  async function subscribe(sessionId: string) {
    const view = viewsRef.current[sessionId];
    try {
      const r = await client.current!.request<SubscribeResult>({
        type: "session.subscribe",
        sessionId,
        sinceSeq: view?.lastSeq ?? 0,
        logEpoch: view?.logEpoch,
      });
      // Runs before the replayed events: the reply precedes them on the socket and this continuation is a microtask.
      setViews((v) => ({ ...v, [sessionId]: withEpoch(v[sessionId] ?? emptySession(), r.logEpoch) }));
      setInfos((i) => ({ ...i, [sessionId]: r.session }));
    } catch (e) {
      if ((e as Error).message !== "disconnected") setError((e as Error).message); // else resubscribed on reconnect
    }
  }

  function open(id: string) {
    setError(undefined);
    setActiveId(id);
    setDrawer(false);
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    if (!viewsRef.current[id]) void subscribe(id);
  }

  useEffect(() => {
    const c = connect({
      onEvent: (e: Event) => {
        setViews((v) => ({ ...v, [e.sessionId]: applyEvent(v[e.sessionId] ?? emptySession(), e) }));
        // New titles and last activity come from the transcript; refresh when a session changes state.
        if (e.part.type === "session_state") void refreshList();
      },
      onOpen: () => {
        void refreshList();
        const ids = new Set(Object.keys(viewsRef.current));
        const h = hashId();
        if (h) ids.add(h);
        ids.forEach((id) => void subscribe(id));
        c.request<ModelsResult>({ type: "models.list" }).then(
          (r) => setModels(r.models),
          (e: Error) => e.message !== "disconnected" && setError(`models: ${e.message}`),
        );
        void pushSubscription().then((sub) => {
          setPushOn(!!sub);
          if (sub) sendSubscription(c, sub).catch(() => {});
        });
      },
      onStatus: setStatus,
    });
    client.current = c;
    // Picks up sessions started in the terminal CLI meanwhile.
    const onFocus = () => void refreshList();
    window.addEventListener("focus", onFocus);
    // Notification click (sw.js): open the session at the bottom.
    const onWorkerMessage = (e: MessageEvent) => {
      if (e.data?.type !== "open" || typeof e.data.sessionId !== "string") return;
      open(e.data.sessionId);
      setScrollKey((k) => k + 1);
    };
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      window.removeEventListener("focus", onFocus);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      c.close();
    };
  }, []);

  // The daemon suppresses pushes for the session a focused, visible tab shows; resent after every reconnect.
  useEffect(() => {
    if (status !== "connected") return;
    const sessionId = focused ? activeId : undefined;
    client.current!.request(sessionId ? { type: "push.focus", sessionId } : { type: "push.focus" }).catch(() => {});
  }, [status, focused, activeId]);

  const activeView = activeId ? views[activeId] : undefined;
  useEffect(() => {
    if (!focused || !activeId || !activeView || !isUnread(activeView, seen[activeId])) return;
    const next = { ...seen, [activeId]: seenNow(activeView) };
    setSeen(next);
    saveSeen(next);
  }, [focused, activeId, activeView?.lastSeq]);

  const unread = new Set(list.filter((s) => views[s.id] && isUnread(views[s.id]!, seen[s.id])).map((s) => s.id));
  useEffect(() => void (document.title = tabTitle(unread.size)), [unread.size]);

  async function togglePush() {
    setError(undefined);
    try {
      if (pushOn) await disablePush();
      else await enablePush(client.current!);
      setPushOn(!pushOn);
    } catch (e) {
      setError(`notifications: ${(e as Error).message}`);
    }
  }

  async function createSession(cwd: string, model: string) {
    setError(undefined);
    try {
      const { session } = await client.current!.request<CreateResult>({ type: "session.create", cwd, model });
      setInfos((i) => ({ ...i, [session.id]: session }));
      setPicking(false);
      open(session.id);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setModel(sessionId: string, model: string) {
    setError(undefined);
    try {
      const { session } = await client.current!.request<SetModelResult>({ type: "session.setModel", sessionId, model });
      setInfos((i) => ({ ...i, [session.id]: session }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The daemon's settlement event updates every tab; `settled: false` means another tab answered first.
  async function respond(requestId: string, answer: PermissionAnswer) {
    setError(undefined);
    try {
      await client.current!.request<RespondResult>({ type: "permission.respond", requestId, ...answer });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function answer(requestId: string, answers: Record<string, string>) {
    setError(undefined);
    try {
      await client.current!.request<RespondResult>({ type: "question.respond", requestId, answers });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const active = activeId ? (infos[activeId] ?? list.find((s) => s.id === activeId)) : undefined;
  const view = activeId ? views[activeId] : undefined;

  return (
    <div className="flex h-dvh bg-background text-foreground">
      {drawer && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)} aria-hidden />}
      <aside
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col gap-3 border-r bg-background p-3 transition-transform md:static md:translate-x-0 ${drawer ? "translate-x-0" : "-translate-x-full"}`}
      >
        <ConnectionBadge status={status} />
        <label
          className="flex items-center gap-2 text-sm"
          title={pushSupported() ? "Push notification when a session needs input or finishes" : "Push needs HTTPS or localhost and a browser with Web Push"}
        >
          <input type="checkbox" checked={pushOn} disabled={!pushSupported()} onChange={togglePush} data-testid="push-toggle" />
          Notifications
        </label>
        {picking ? (
          <DirPicker client={client.current!} models={models} onPick={createSession} onCancel={() => setPicking(false)} />
        ) : (
          <Button onClick={() => (setError(undefined), setPicking(true))}>New session</Button>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        <SessionList list={list} views={views} unread={unread} activeId={activeId} onOpen={open} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {active && view ? (
          <SessionPane
            key={active.id}
            scrollKey={scrollKey}
            session={active}
            view={view}
            models={models}
            onMenu={() => setDrawer(true)}
            onModel={(model) => setModel(active.id, model)}
            onPrompt={(text, images) =>
              client
                .current!.request({ type: "session.prompt", sessionId: active.id, text, images })
                .catch((e) => setError((e as Error).message))
            }
            onRewindPreview={(userMessageId) =>
              client.current!.request<RewindPreview>({ type: "session.rewindPreview", sessionId: active.id, userMessageId })
            }
            onRewind={(userMessageId, mode) => client.current!.request({ type: "session.rewind", sessionId: active.id, userMessageId, mode })}
            onRespond={respond}
            onSearch={(query) =>
              client.current!.request<FsSearchResult>({ type: "fs.search", cwd: active.cwd, query }).then((r) => r.paths)
            }
            onAnswer={answer}
          />
        ) : (
          <>
            <header className="flex items-center border-b px-4 py-2 md:hidden">
              <MenuButton onClick={() => setDrawer(true)} />
            </header>
            <div className="m-auto text-muted-foreground text-sm">Open or create a session to start.</div>
          </>
        )}
      </main>
    </div>
  );
}

const STATUS_STYLE: Record<ConnectionStatus, string> = {
  connected: "bg-green-500",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-destructive",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" data-testid="connection-status" role="status">
      <span className={`size-2 rounded-full ${STATUS_STYLE[status]}`} aria-hidden />
      {status}
    </div>
  );
}

function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="md:hidden" onClick={onClick} aria-label="Sessions" data-testid="open-drawer">
      ☰
    </Button>
  );
}

function SessionList({
  list,
  views,
  unread,
  activeId,
  onOpen,
}: {
  list: SessionListItem[];
  views: Record<string, SessionView>;
  unread: Set<string>;
  activeId?: string;
  onOpen: (id: string) => void;
}) {
  if (!list.length) return <p className="text-muted-foreground text-sm">No sessions in the allowlisted roots.</p>;
  return (
    <nav className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto" data-testid="session-list">
      {groupByCwd(list).map((g) => (
        <section key={g.cwd}>
          <h2 className="px-1 text-xs" title={g.cwd}>
            <div className="truncate font-medium">{g.cwd.split("/").at(-1) || g.cwd}</div>
            <div className="truncate font-mono text-muted-foreground">{g.cwd}</div>
          </h2>
          <ul className="mt-1 flex flex-col gap-0.5">
            {g.sessions.map((s) => (
              <li key={s.id}>
                <button
                  data-testid="session-item"
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${s.id === activeId ? "bg-muted" : ""}`}
                  onClick={() => onOpen(s.id)}
                  title={`${s.title}\n${s.cwd}`}
                >
                  {unread.has(s.id) && <span className="size-2 shrink-0 rounded-full bg-blue-500" data-testid="unread-marker" aria-label="unread" />}
                  <span className={`min-w-0 flex-1 truncate ${unread.has(s.id) ? "font-semibold" : ""}`}>{s.title}</span>
                  <StateBadge state={views[s.id]?.state ?? s.state} />
                  <span className="text-muted-foreground text-xs">{timeAgo(s.lastActivity)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

const STATE_STYLE: Record<SessionInfo["state"], string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-600",
  needs_input: "bg-amber-500/15 text-amber-600",
  error: "bg-destructive/15 text-destructive",
  closed: "text-muted-foreground",
};

function StateBadge({ state }: { state: SessionInfo["state"] }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATE_STYLE[state]}`} data-testid="state-badge">
      {state.replace("_", " ")}
    </span>
  );
}

/** Browses directories inside the allowlisted roots; the daemon refuses anything outside them. */
function DirPicker({
  client,
  models,
  onPick,
  onCancel,
}: {
  client: Client;
  models: ModelInfo[];
  onPick: (cwd: string, model: string) => void;
  onCancel: () => void;
}) {
  const [model, setModel] = useState("default");
  // Visited directories; empty = the roots.
  const [trail, setTrail] = useState<string[]>([]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string>();
  const path = trail.at(-1);

  useEffect(() => {
    let stale = false;
    setError(undefined);
    client
      .request<FsListResult>(path ? { type: "fs.list", path } : { type: "fs.list" })
      .then((r) => !stale && setEntries(r.entries.filter((e) => e.isDir && (!path || !e.name.startsWith(".")))))
      .catch((e) => !stale && setError((e as Error).message));
    return () => void (stale = true);
  }, [path]);

  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-md border p-2" data-testid="dir-picker">
      <div className="truncate font-mono text-xs" title={path}>
        {path ?? "Allowlisted roots"}
      </div>
      <ul className="flex max-h-60 flex-col overflow-y-auto text-sm">
        {path && (
          <li>
            <button className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => setTrail((t) => t.slice(0, -1))}>
              ..
            </button>
          </li>
        )}
        {entries.map((e) => (
          <li key={e.path}>
            <button
              className="w-full truncate rounded px-2 py-1 text-left font-mono hover:bg-muted"
              onClick={() => setTrail((t) => [...t, e.path])}
            >
              {path ? e.name : e.path}/
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <label className="font-medium text-xs" htmlFor="new-model">
        Model
      </label>
      <ModelSelect id="new-model" models={models} value={model} onChange={setModel} className="py-1 text-sm" />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" disabled={!path} onClick={() => path && onPick(path, model)}>
          Start here
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ModelSelect({
  models,
  value,
  onChange,
  ...rest
}: { models: ModelInfo[]; value: string; onChange: (model: string) => void; id?: string; className?: string; "aria-label"?: string }) {
  // Keep the current value selectable while the list loads or if it is not in the list.
  const options = models.some((m) => m.value === value) ? models : [{ value, displayName: value, description: "" }, ...models];
  return (
    <select
      {...rest}
      className={`rounded-md border bg-background px-2 ${rest.className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((m) => (
        <option key={m.value} value={m.value} title={m.description}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}

function SessionPane({
  scrollKey,
  session,
  view,
  models,
  onModel,
  onPrompt,
  onSearch,
  onMenu,
  onRewindPreview,
  onRewind,
  onRespond,
  onAnswer,
}: {
  scrollKey: number;
  session: SessionInfo;
  view: SessionView;
  models: ModelInfo[];
  onModel: (model: string) => void;
  onPrompt: (text: string, images: string[]) => void;
  onSearch: (query: string) => Promise<string[]>;
  onMenu: () => void;
  onRewindPreview: (userMessageId: string) => Promise<RewindPreview>;
  onRewind: (userMessageId: string, mode: RewindMode) => Promise<unknown>;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
}) {
  const permission = pendingPermission(view);
  const question = pendingQuestion(view);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [rewinding, setRewinding] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const input = useRef<HTMLTextAreaElement>(null);
  const matches = dismissed ? undefined : matchCommands(view.commands, text);
  const mention = dismissed || matches ? undefined : activeMention(text, caret);
  // Only results for the query being typed, so Enter never picks a stale path.
  const paths = mention && found?.query === mention.query ? found.paths : [];
  const pickerOpen = !!matches?.length || paths.length > 0;
  const rows = matches?.length ? matches.length : paths.length;
  useEffect(() => {
    if (mention === undefined) return;
    let current = true;
    onSearch(mention.query)
      .then((p) => current && setFound({ query: mention.query, paths: p }))
      .catch(() => current && setFound({ query: mention.query, paths: [] }));
    return () => void (current = false);
  }, [mention?.query]);
  // Keeps the caret after an inserted mention (a controlled textarea moves it to the end).
  useLayoutEffect(() => void input.current?.setSelectionRange(caret, caret), [text]);
  const edit = (t: string, c = t.length) => {
    setText(t);
    setCaret(c);
    setSelected(0);
    setDismissed(false);
  };
  const send = (t = text) => {
    if (!t.trim() && !images.length) return;
    onPrompt(t, images);
    edit("");
    setImages([]);
  };
  const pick = (i: number) => {
    if (!matches?.length) {
      const r = insertMention(text, mention!, paths[i]!);
      return edit(r.text, r.caret);
    }
    const r = choose(matches[i]!);
    "send" in r ? send(r.send) : edit(r.text);
  };
  const attach = async (files: FileList) => {
    const added = await readImages(files);
    setImages((i) => [...i, ...added]);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (![...e.clipboardData.files].some((f) => f.type.startsWith("image/"))) return;
    e.preventDefault();
    void attach(e.clipboardData.files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void attach(e.dataTransfer.files);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (pickerOpen) {
      const n = rows;
      const keys: Record<string, () => void> = {
        ArrowDown: () => setSelected((i) => (i + 1) % n),
        ArrowUp: () => setSelected((i) => (i - 1 + n) % n),
        Enter: () => pick(selected),
        Tab: () => (matches?.length ? edit(`/${matches[selected]!.name} `) : pick(selected)),
        Escape: () => setDismissed(true),
      };
      // Shift+Enter still inserts a newline.
      if (keys[e.key] && !(e.key === "Enter" && e.shiftKey)) {
        e.preventDefault();
        return keys[e.key]!();
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-2 text-sm">
        <MenuButton onClick={onMenu} />
        <span className="truncate font-mono">{session.cwd}</span>
        <ModelSelect
          aria-label="Model"
          data-testid="session-model"
          models={models}
          value={view.model ?? session.model}
          onChange={onModel}
          className="ml-auto py-0.5 text-xs"
        />
        <span className="rounded bg-muted px-2 py-0.5 text-xs" data-testid="session-state">
          {view.state}
        </span>
      </header>
      <Conversation key={scrollKey} className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {timeline(view).map((item) =>
            item.kind === "context" ? (
              <ContextGroup key={item.id} calls={item.calls} result={(c) => resultOf(view, c)} />
            ) : item.part.type === "user_text" ? (
              <div key={item.part.id} className="group flex flex-col gap-1" data-testid="user-message">
                <PartView part={item.part} view={view} />
                <MessageActions className="ml-auto opacity-60 group-hover:opacity-100">
                  {/* No tooltip prop: its trigger renders a button around this button. */}
                  <MessageAction
                    title="Rewind"
                    label="Rewind to before this message"
                    disabled={view.state === "running"}
                    onClick={() => setRewinding(rewinding === item.part.id ? undefined : item.part.id)}
                  >
                    <RotateCcwIcon />
                  </MessageAction>
                </MessageActions>
                {rewinding === item.part.id && (
                  <RewindPanel
                    cwd={session.cwd}
                    preview={() => onRewindPreview(item.part.id)}
                    rewind={async (mode) => {
                      const prompt = item.part as Extract<Part, { type: "user_text" }>;
                      await onRewind(prompt.id, mode);
                      setRewinding(undefined);
                      // Conversation modes: the original prompt goes back into the prompt box.
                      if (mode !== "code") edit(prompt.text), setImages(prompt.images);
                    }}
                    onCancel={() => setRewinding(undefined)}
                  />
                )}
              </div>
            ) : (
              <PartView key={item.part.id} part={item.part} view={view} />
            ),
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div
        className="relative mx-auto flex w-full max-w-3xl flex-col gap-2 p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {(view.state === "running" || view.state === "needs_input") && view.todos.length > 0 && <TodoList items={view.todos} />}
        {permission ? (
          <PermissionPanel key={permission.id} part={permission} onRespond={(a) => onRespond(permission.requestId, a)} />
        ) : question ? (
          <QuestionPanel key={question.id} part={question} onAnswer={(a) => onAnswer(question.requestId, a)} />
        ) : (
          <>
            <ImageStrip images={images} onRemove={(i) => setImages((all) => all.filter((_, j) => j !== i))} />
            {pickerOpen && !matches?.length && (
              <ul
                id="command-picker"
                role="listbox"
                aria-label="Files"
                data-testid="mention-picker"
                className="absolute inset-x-4 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 font-mono text-sm shadow-md"
              >
                {paths.map((p, i) => (
                  <li
                    key={p}
                    id={`command-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    ref={(el) => void (i === selected && el?.scrollIntoView({ block: "nearest" }))}
                    className={`cursor-pointer truncate rounded-md px-2 py-1.5 ${i === selected ? "bg-muted" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => pick(i)}
                  >
                    @{p}
                  </li>
                ))}
              </ul>
            )}
            {!!matches?.length && (
              <ul
                id="command-picker"
                role="listbox"
                aria-label="Commands and skills"
                className="absolute inset-x-4 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-md"
              >
                {matches.map((c, i) => (
                  <li
                    key={c.name}
                    id={`command-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    ref={(el) => void (i === selected && el?.scrollIntoView({ block: "nearest" }))}
                    className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 ${i === selected ? "bg-muted" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => pick(i)}
                  >
                    <span className="shrink-0 font-mono">
                      /{c.name}
                      {c.argumentHint && <span className="ml-1 text-muted-foreground">{c.argumentHint}</span>}
                    </span>
                    <span className="truncate text-muted-foreground">{c.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              role="combobox"
              aria-expanded={pickerOpen}
              aria-controls="command-picker"
              aria-activedescendant={pickerOpen ? `command-${selected}` : undefined}
              className="w-full resize-none rounded-lg border bg-transparent p-3 text-sm"
              rows={3}
              placeholder="Ask Claude… (Enter to send, Shift+Enter for newline, paste or drop images)"
              value={text}
              ref={input}
              onChange={(e) => edit(e.target.value, e.target.selectionStart)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </>
        )}
      </div>
    </>
  );
}

/** Top-level parts, or with `parentId` the child parts of that subagent. */
function Timeline({ view, parentId }: { view: SessionView; parentId?: string }) {
  return timeline(view, parentId).map((item) =>
    item.kind === "context" ? (
      <ContextGroup key={item.id} calls={item.calls} result={(c) => resultOf(view, c)} />
    ) : (
      <PartView key={item.part.id} part={item.part} view={view} />
    ),
  );
}

const resultOf = (view: SessionView, call: { toolUseId: string }) => {
  const p = view.parts.get(`${call.toolUseId}:result`);
  return p?.type === "tool_result" ? p : undefined;
};

function RewindPanel(props: {
  cwd: string;
  preview: () => Promise<RewindPreview>;
  rewind: (mode: RewindMode) => Promise<void>;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<RewindPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => void props.preview().then(setPreview, (e: Error) => setError(e.message)), []);
  const run = async (mode: RewindMode) => {
    setBusy(true);
    setError(undefined);
    try {
      await props.rewind(mode);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const options = preview ? rewindOptions(preview) : [];
  const rel = (f: string) => (f.startsWith(props.cwd + "/") ? f.slice(props.cwd.length + 1) : f);

  return (
    <div className="ml-auto flex w-full max-w-md flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="rewind-panel">
      {!preview && !error && <p className="text-muted-foreground">Checking file changes…</p>}
      {preview && preview.filesChanged.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs">
            Restore code changes {preview.filesChanged.length} file(s), +{preview.insertions} −{preview.deletions}:
          </p>
          <ul className="font-mono text-xs" data-testid="rewind-files">
            {preview.filesChanged.map((f) => (
              <li key={f} className="truncate" title={f}>
                {rel(f)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview && !options.length && <p className="text-muted-foreground">Nothing to rewind: first message and no file changes.</p>}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button key={o.mode} size="sm" variant={o.mode === "both" ? "default" : "outline"} disabled={busy} onClick={() => run(o.mode)}>
            {o.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PartView({ part, view }: { part: Part; view: SessionView }) {
  switch (part.type) {
    case "user_text":
      return (
        <Message from="user">
          <MessageContent>
            <ImageStrip images={part.images} />
            {part.text}
          </MessageContent>
        </Message>
      );
    case "assistant_text":
      return <AssistantText text={part.text} streaming={part.streaming} />;
    case "thinking":
      return <Thinking part={part} />;
    case "tool_call":
      return <ToolCard call={part} result={resultOf(view, part)} />;
    case "permission_request":
      return <PermissionMarker part={part} />;
    case "subagent":
      return (
        <SubagentGroup part={part} result={resultOf(view, part)}>
          <Timeline view={view} parentId={part.id} />
        </SubagentGroup>
      );
    case "question":
      return <QuestionMarker part={part} />;
    case "turn_result":
      return <TurnFooter part={part} />;
    case "raw":
      return (
        <pre className="overflow-x-auto rounded bg-muted p-2 text-xs" data-testid="raw-part">
          {JSON.stringify(part.message, null, 2)}
        </pre>
      );
    default:
      return null;
  }
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  const revealing = streaming || shown.length < text.length;
  return (
    <Message from="assistant" data-testid="assistant-text">
      <MessageContent>
        <MessageResponse mode={revealing ? "streaming" : "static"} isAnimating={revealing}>
          {shown}
        </MessageResponse>
      </MessageContent>
    </Message>
  );
}

function TurnFooter({ part }: { part: Extract<Part, { type: "turn_result" }> }) {
  const { usage } = part;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <div className="text-muted-foreground text-xs" data-testid="turn-result">
      {part.isError && <span className="mr-2 text-destructive">error</span>}
      {(part.durationMs / 1000).toFixed(1)}s · {fmt(input)} in / {fmt(usage.outputTokens)} out tokens · $
      {part.costUsd.toFixed(4)}
    </div>
  );
}
