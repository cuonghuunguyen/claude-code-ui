import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CreateResult, Event, Part, SessionInfo, SubscribeResult } from "@claude-ui/protocol";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { connect, type ConnectionStatus } from "./client.ts";
import { useSmoothText } from "./smooth.ts";
import { applyEvent, emptySession, timeline, withEpoch, type SessionView, type ToolCall } from "./store.ts";
import { ContextGroup, Thinking, ToolCard } from "./tool-card.tsx";

// ponytail: session IDs this browser opened, so a reopened tab resubscribes; the session list issue replaces this with session.list.
const STORAGE_KEY = "claude-ui.sessions";
const loadIds = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const saveIds = (ids: string[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
};

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const client = useRef<ReturnType<typeof connect>>(undefined);
  const viewsRef = useRef(views);
  viewsRef.current = views;

  // Replays events after the view's last seq, or everything when the daemon restarted (new logEpoch).
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
      setSessions((s) => (s.some((x) => x.id === sessionId) ? s : [...s, r.session]));
      setActiveId((a) => a ?? sessionId);
    } catch (e) {
      if ((e as Error).message === "disconnected") return; // resubscribed on reconnect
      saveIds(loadIds().filter((id) => id !== sessionId));
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    const c = connect({
      onEvent: (e: Event) =>
        setViews((v) => ({ ...v, [e.sessionId]: applyEvent(v[e.sessionId] ?? emptySession(), e) })),
      onOpen: () => loadIds().forEach((id) => void subscribe(id)),
      onStatus: setStatus,
    });
    client.current = c;
    return c.close;
  }, []);

  async function createSession(cwd: string) {
    setError(undefined);
    try {
      const { session } = await client.current!.request<CreateResult>({ type: "session.create", cwd });
      saveIds([...loadIds(), session.id]);
      await subscribe(session.id);
      setActiveId(session.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const active = sessions.find((s) => s.id === activeId);
  const view = activeId ? (views[activeId] ?? emptySession()) : undefined;

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col gap-3 border-r p-3">
        <ConnectionBadge status={status} />
        <NewSessionForm onCreate={createSession} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${s.id === activeId ? "bg-muted" : ""}`}
                onClick={() => setActiveId(s.id)}
                title={s.cwd}
              >
                {s.cwd.split("/").at(-1) || s.cwd}
                <span className="ml-2 text-muted-foreground text-xs">{views[s.id]?.state ?? s.state}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {active && view ? (
          <SessionPane
            session={active}
            view={view}
            onPrompt={(text) => client.current!.request({ type: "session.prompt", sessionId: active.id, text })}
          />
        ) : (
          <div className="m-auto text-muted-foreground text-sm">Create a session to start.</div>
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

function NewSessionForm({ onCreate }: { onCreate: (cwd: string) => void }) {
  const [cwd, setCwd] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cwd.trim()) onCreate(cwd.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label className="font-medium text-sm" htmlFor="cwd">
        Working directory
      </label>
      <input
        id="cwd"
        className="rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm"
        placeholder="/path/to/project"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
      />
      <Button type="submit">New session</Button>
    </form>
  );
}

function SessionPane({ session, view, onPrompt }: { session: SessionInfo; view: SessionView; onPrompt: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onPrompt(text);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-2 text-sm">
        <span className="truncate font-mono">{session.cwd}</span>
        <span className="ml-auto rounded bg-muted px-2 py-0.5 text-xs" data-testid="session-state">
          {view.state}
        </span>
      </header>
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {timeline(view).map((item) =>
            item.kind === "context" ? (
              <ContextGroup key={item.id} calls={item.calls} result={(c) => resultOf(view, c)} />
            ) : (
              <PartView key={item.part.id} part={item.part} view={view} />
            ),
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">
        <textarea
          className="w-full resize-none rounded-lg border bg-transparent p-3 text-sm"
          rows={3}
          placeholder="Ask Claude… (Enter to send, Shift+Enter for newline)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </>
  );
}

const resultOf = (view: SessionView, call: ToolCall) => {
  const p = view.parts.get(`${call.toolUseId}:result`);
  return p?.type === "tool_result" ? p : undefined;
};

function PartView({ part, view }: { part: Part; view: SessionView }) {
  switch (part.type) {
    case "user_text":
      return (
        <Message from="user">
          <MessageContent>{part.text}</MessageContent>
        </Message>
      );
    case "assistant_text":
      return <AssistantText text={part.text} streaming={part.streaming} />;
    case "thinking":
      return <Thinking part={part} />;
    case "tool_call":
      return <ToolCard call={part} result={resultOf(view, part)} />;
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
