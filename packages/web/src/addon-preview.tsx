// The addon preview page, hash route `#/addon-preview` (docs/spec.md "Addon preview"): every part of the app (packages/protocol/src/addon-parts.ts)
// in every state, drawn by the real components over sample data (addon-preview-data.ts), no daemon session. An addon author picks a theme and a
// mode here and, with Dev mode on, watches a CSS edit change the page.
//
// Stand-ins: a part whose component cannot run without a daemon, or is an inline element of App.tsx, is a static element with the same `data-part`
// and attributes (and a `data-preview-standin` marker). Few on purpose: the shells (titlebar, sidebar, work-area, side-panel, session-area; the
// session-area attributes come from the real `phaseOf` / `useJustFinished`) and the daemon-backed panels (graph, terminal, changes, commit message).
import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowLeftIcon, GitBranchIcon, TerminalIcon } from "lucide-react";
import type { SessionState } from "@claude-ui/protocol";
import { SessionPane } from "./App.tsx";
import { AddonsContext, enabledAddons } from "./addons.ts";
import { CONTEXT, SAMPLE, FILES, idle, failed, finishing, LIST, MODELS, PLAN_WINDOWS, PROJECT, permission, question, running, waiting, sessionInfo, tools, TABS } from "./addon-preview-data.ts";
import { Backdrop } from "./backdrop.tsx";
import { Button } from "./components/ui/button.tsx";
import type { connect } from "./client.ts";
import { ContextBar } from "./context-meter.tsx";
import { emptySaved } from "./editor-persist.ts";
import { createEditorStore } from "./editor-store.ts";
import { FilesPanel } from "./files-panel.tsx";
import { FocusPage } from "./focus-page.tsx";
import { waitingRequests } from "./focus.ts";
import { useT, type Key } from "./i18n.ts";
import { phaseOf, useJustFinished } from "./lifecycle.ts";
import { CommandPalette, type PaletteItem } from "./palette.tsx";
import { PlanWindowRow } from "./plan-meter.tsx";
import { SessionList } from "./sidebar.tsx";
import { type SessionView } from "./store.ts";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { applyTheme, loadPref, setColorTheme, useColorTheme, useDark, type ThemePref } from "./theme.ts";
import { addonThemes, THEMES, type ThemeId } from "./themes.ts";
import { Toast, ToastRegion } from "./toast.tsx";

type Client = ReturnType<typeof connect>;
const noop = () => {};
const asyncNoop = async () => {};
/** The status bar's branch field: a sample repository state. */
const sampleGit = async () => ({ branch: "feature/sign-in", added: 12, removed: 4 });
/** A draft in the prompt box: the send button is the stop button while a turn runs with an empty box. */
const DRAFT = "Also update the tests";
/** What the real panels ask a daemon for: the sample project's files, nothing else. */
const sampleClient = { request: async (m: { type: string }) => (m.type === "fs.list" ? { entries: FILES } : {}), onFsChanged: () => noop } as unknown as Client;

const MODES: { pref: ThemePref; label: Key }[] = [
  { pref: "light", label: "addonPreview.light" },
  { pref: "dark", label: "addonPreview.dark" },
  { pref: "system", label: "addonPreview.system" },
];

function Section({ id, name, field, workArea, children }: { id: string; /** Catalog keys: the title and the hint. (Named so the hard-coded-text test knows they are not words.) */ name: Key; field?: Key; /** The grid is the `work-area` shell of App.tsx (a stand-in). */ workArea?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <section aria-labelledby={`preview-${id}`} className="flex min-w-0 flex-col gap-3" data-testid={`preview-${id}`}>
      <h2 id={`preview-${id}`} className="border-b pb-1 font-medium text-base">
        {t(name)}
      </h2>
      {field && <p className="text-muted-foreground text-xs">{t(field)}</p>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2" {...(workArea ? { "data-testid": "work-area", "data-part": "work-area", "data-preview-standin": "" } : {})}>
        {children}
      </div>
    </section>
  );
}

/** One sample: a heading, the attributes it shows, the content. */
function Sample({ name, state, wide, children }: { name: Key; /** The attributes the sample shows (identifiers, not words). */ state?: string; wide?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${wide ? "lg:col-span-2" : ""}`}>
      <h3 className="font-medium text-[13px]">
        {t(name)}
        {state && <code className="ml-2 font-normal text-muted-foreground text-xs [overflow-wrap:anywhere]">{state}</code>}
      </h3>
      {children}
    </div>
  );
}

/** A static stand-in of a part that needs a daemon (see the file comment). */
const STANDIN = "rounded-lg border bg-card p-3 text-sm";

const card = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-raised";

/** The `session-area` element of App.tsx with its lifecycle attributes from the real helpers; `flip` turns the pane to its idle view after a delay (data-just-finished). */
function SessionArea({ id, view, children }: { id: string; view: SessionView; children: ReactNode }) {
  const phase = phaseOf(view);
  const justFinished = useJustFinished(id, phase);
  return (
    <div className={`${card} relative h-[34rem]`} data-testid="session-area" data-part="session-area" data-preview-standin="" data-phase={phase} data-just-finished={justFinished ? "" : undefined}>
      {children}
    </div>
  );
}

type PaneProps = Partial<ComponentProps<typeof SessionPane>>;
function Pane({ id, view, state, connected = true, ...over }: { id: string; view: SessionView; state: SessionState; connected?: boolean } & PaneProps) {
  return (
    <SessionArea id={id} view={view}>
      <SessionPane
        active={false}
        scrollKey={0}
        onInserted={noop}
        connected={connected}
        session={sessionInfo(id, state)}
        view={view}
        models={MODELS}
        onModel={noop}
        onMode={noop}
        onEffort={noop}
        onUpload={async () => ""}
        onPrompt={asyncNoop}
        onSearch={async () => []}
        onInterrupt={noop}
        onRewindPreview={async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false })}
        onRewind={asyncNoop}
        onRespond={noop}
        onAnswer={noop}
        onAllowDenied={asyncNoop}
        onAlwaysAllowDenied={asyncNoop}
        onStopRun={asyncNoop}
        onGitStatus={sampleGit}
        {...over}
      />
    </SessionArea>
  );
}

/** A turn that ends while the page is open: `data-just-finished` stays 1.2 s on the session area. `run` restarts it. */
function Finishing({ run }: { run: number }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 700);
    return () => clearTimeout(t);
  }, [run]);
  return <Pane id="preview-finishing" view={done ? idle() : finishing()} state={done ? "idle" : "running"} />;
}

function Focus({ run }: { run: number }) {
  const [selected, setSelected] = useState<string>();
  const views = useMemo(() => ({ "s-need": permission(), "s-ask": question(), "s-run": running() }), []);
  const list = useMemo(() => [LIST[1]!, { ...LIST[1]!, id: "s-ask", title: "Choose the button placement" }, LIST[0]!], []);
  const waiting = useMemo(() => waitingRequests(list, views, new Map(), Date.now()), [list, views]);
  return (
    <div className="flex h-[34rem] min-w-0 flex-col">
      <FocusPage
        key={run}
        list={list}
        views={views}
        worktrees={{}}
        waiting={waiting}
        selected={selected}
        onSelect={setSelected}
        onRespond={noop}
        onAnswer={noop}
        onOpenSession={noop}
        unread={new Set()}
        activity={() => Date.now() - 5000}
        onCancelContinue={noop}
      />
    </div>
  );
}

const tabInfo = (id: string): TabInfo => {
  const x = TABS.find((t) => t.id === id) ?? TABS[0]!;
  return { title: x.title, cwd: PROJECT, state: x.state, unread: x.unread, group: "" };
};

function Palette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const items: PaletteItem[] = useMemo(
    () => [
      { id: "preview.a", title: t("addonPreview.paletteA"), group: t("addonPreview.paletteGroup"), groupId: "addonPreview.paletteGroup", run: onClose },
      { id: "preview.b", title: t("addonPreview.paletteB"), group: t("addonPreview.paletteGroup"), groupId: "addonPreview.paletteGroup", run: onClose },
    ],
    [t, onClose],
  );
  return <CommandPalette items={items} onClose={onClose} />;
}

export function AddonPreview({ onBack }: { onBack: () => void }) {
  const t = useT();
  const addons = useContext(AddonsContext).addons;
  const themeId = useColorTheme();
  const dark = useDark();
  const [pref, setPref] = useState<ThemePref>(loadPref);
  const stop = useRef<() => void>(noop);
  useEffect(() => () => stop.current(), []);
  const pick = (p: ThemePref) => (stop.current(), setPref(p), (stop.current = applyTheme(p)));
  const list = useMemo(() => [...THEMES, ...addonThemes(enabledAddons(addons))], [addons]);
  const id = list.some((x) => x.id === themeId) ? themeId : "default";
  const [run, setRun] = useState(0);
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState(true);
  // Its own empty storage: the page never reads or writes the editor tabs the user has open.
  const editors = useMemo(() => createEditorStore(() => sampleClient, { load: emptySaved, write: noop }), []);
  const choose = "h-8 rounded-md border bg-background px-2 text-sm max-md:h-11";

  return (
    <div className="h-dvh overflow-y-auto bg-background text-foreground" data-testid="addon-preview" data-dark={dark ? "" : undefined}>
      <Backdrop />
      <main className="mx-auto flex max-w-7xl min-w-0 flex-col gap-8 px-4 py-4">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" size="sm" className="max-md:h-11" onClick={onBack} data-testid="addon-preview-back">
              <ArrowLeftIcon />
              {t("addonPreview.back")}
            </Button>
            <h1 className="font-semibold text-xl">{t("addonPreview.title")}</h1>
          </div>
          <p className="max-w-3xl text-muted-foreground text-sm">{t("addonPreview.intro")}</p>
          <div className="flex flex-wrap items-end gap-4">
            <div role="group" aria-labelledby="preview-mode-label" className="flex flex-col gap-1">
              <span id="preview-mode-label" className="text-muted-foreground text-xs">
                {t("addonPreview.mode")}
              </span>
              <div className="flex gap-1">
                {MODES.map((m) => (
                  <Button key={m.pref} variant={pref === m.pref ? "default" : "outline"} size="sm" className="max-md:h-11" aria-pressed={pref === m.pref} onClick={() => pick(m.pref)} data-testid={`addon-preview-mode-${m.pref}`}>
                    {t(m.label)}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t("addonPreview.theme")}</span>
              <select className={choose} value={id} onChange={(e) => setColorTheme(e.currentTarget.value as ThemeId)} data-testid="addon-preview-theme">
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => setRun((n) => n + 1)} data-testid="addon-preview-replay">
              {t("addonPreview.replay")}
            </Button>
          </div>
        </header>

        <Section id="session" name="addonPreview.session" field="addonPreview.sessionHint" workArea>
          <Sample name="addonPreview.running" state="data-phase=thinking · send data-state=running">
            <Pane id="preview-running" view={running()} state="running" insert={DRAFT} />
          </Sample>
          <Sample name="addonPreview.permission" state="data-phase=waiting · permission-panel">
            <Pane id="preview-permission" view={permission()} state="needs_input" insert={DRAFT} />
          </Sample>
          <Sample name="addonPreview.waiting" state="send data-state=needs_input">
            <Pane id="preview-waiting" view={waiting()} state="needs_input" insert={DRAFT} />
          </Sample>
          <Sample name="addonPreview.question" state="data-phase=waiting · question-panel">
            <Pane id="preview-question" view={question()} state="needs_input" />
          </Sample>
          <Sample name="addonPreview.finished" state="data-phase=idle · data-just-finished (1200 ms)">
            <Finishing key={run} run={run} />
          </Sample>
          <Sample name="addonPreview.idle" state="data-phase=idle · send data-state=idle">
            <Pane id="preview-idle" view={idle()} state="idle" />
          </Sample>
          <Sample name="addonPreview.error" state="data-phase=idle · send data-state=disconnected">
            <Pane id="preview-error" view={failed()} state="error" connected={false} />
          </Sample>
          <Sample name="addonPreview.tools" state="data-status=pending|running|done|error|denied|stopped" wide>
            <Pane id="preview-tools" view={tools()} state="idle" />
          </Sample>
        </Section>

        <Section id="frame" name="addonPreview.frame" field="addonPreview.frameHint">
          <Sample name="addonPreview.titlebar">
            <header className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm max-md:h-11" data-testid="titlebar" data-part="titlebar" data-preview-standin="">
              <span className="min-w-0 flex-1 truncate font-medium">{t("addonPreview.titlebarText")}</span>
            </header>
          </Sample>
          <Sample name="addonPreview.tabs" state="data-state=new|running|needs_input|unread|idle · data-active">
            <div className="min-w-0 overflow-hidden rounded-lg border bg-background">
              <TabsBar tabs={TABS.map((x) => x.id)} activeId={SAMPLE.tab} info={tabInfo} onSelect={noop} onClose={noop} onMove={noop} onMoveGroup={noop} onMoveGroupTo={noop} onNew={noop} onAction={noop} onRenamed={noop} focus={{ count: 2 }} />
            </div>
          </Sample>
          <Sample name="addonPreview.sidebar" state="data-state=running|needs_input|idle|error|closed">
            <aside className="flex h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border p-2" data-testid="sidebar" data-part="sidebar" data-preview-standin="">
              <SessionList
                list={LIST}
                projects={[PROJECT]}
                state={(s) => s.state}
                unread={new Set(["s-idle"])}
                activeId={SAMPLE.session}
                onOpen={noop}
                onNew={noop}
                onRemove={noop}
                onOpenProject={noop}
                onAction={noop}
                onRenamed={noop}
              />
            </aside>
          </Sample>
          <Sample name="addonPreview.focus" state="data-focus-opened (1200 ms)">
            <Focus run={run} />
          </Sample>
        </Section>

        <Section id="panels" name="addonPreview.panels" field="addonPreview.standinHint">
          <Sample name="addonPreview.files">
            <section className={`${card} h-[26rem]`} data-testid="side-panel" data-part="side-panel" data-preview-standin="" aria-label={t("addonPreview.files")}>
              <FilesPanel client={sampleClient} status={SAMPLE.status} cwd={PROJECT} onSend={noop} showTree onToggleTree={noop} editors={editors} />
            </section>
          </Sample>
          <Sample name="addonPreview.graph">
            <div className={`${STANDIN} flex h-40 flex-col gap-2`} data-testid="graph-panel" data-part="graph-panel" data-preview-standin="">
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <GitBranchIcon className="size-3.5" aria-hidden />
                {SAMPLE.branch}
              </span>
              <span className="truncate">a1b2c3d {t("addonPreview.commitA")}</span>
              <span className="truncate text-muted-foreground">e4f5a6b {t("addonPreview.commitB")}</span>
            </div>
          </Sample>
          <Sample name="addonPreview.changes">
            <div className={`${STANDIN} flex flex-col gap-2`}>
              <button type="button" className="flex min-h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent max-md:min-h-11" data-testid="changed-file" data-part="changed-file" data-preview-standin="">
                <span className="text-warning text-xs">M</span>
                <span className="min-w-0 flex-1 truncate">{SAMPLE.file}</span>
              </button>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs" data-testid="file-diff" data-part="file-diff" data-preview-standin="">
                {SAMPLE.diff}
              </pre>
              <textarea rows={2} aria-label={t("addonPreview.commitMessage")} defaultValue={t("addonPreview.commitMessageText")} className="resize-none rounded-md border bg-background p-2 text-sm" data-testid="commit-message" data-part="commit-message" data-preview-standin="" />
            </div>
          </Sample>
          <Sample name="addonPreview.terminal">
            <div className="flex h-40 flex-col overflow-hidden rounded-lg border bg-card" data-testid="terminal" data-part="terminal" data-preview-standin="">
              <div className="flex h-9 items-center gap-1 border-b px-2 text-sm">
                <button type="button" role="tab" aria-selected className="flex h-7 items-center gap-1 rounded-md bg-secondary px-2 max-md:h-11" data-testid="terminal-tab" data-part="terminal-tab" data-preview-standin="">
                  <TerminalIcon className="size-3.5" aria-hidden />
                  {SAMPLE.shell}
                </button>
              </div>
              <pre className="flex-1 overflow-hidden p-2 font-mono text-xs">{SAMPLE.output}</pre>
            </div>
          </Sample>
        </Section>

        <Section id="overlays" name="addonPreview.overlays" field="addonPreview.overlaysHint">
          <Sample name="addonPreview.plan" state="data-level=ok|warning|limit">
            <ul className="flex flex-col gap-3 rounded-2xl border bg-popover p-3 text-popover-foreground">
              {PLAN_WINDOWS.map((w) => (
                <PlanWindowRow key={w.kind} w={w} now={Date.now()} />
              ))}
            </ul>
          </Sample>
          <Sample name="addonPreview.context">
            <div className="rounded-2xl border bg-popover p-3 text-popover-foreground text-sm">
              <p className="text-muted-foreground text-xs">{`${CONTEXT.totalTokens} / ${CONTEXT.maxTokens} · ${CONTEXT.percentage}%`}</p>
              <ContextBar usage={CONTEXT} />
            </div>
          </Sample>
          <Sample name="addonPreview.toast">
            {/* A transform makes this box the containing block of the region, which is fixed in the app: the region stays in the box. */}
            <div className="relative h-32 overflow-hidden rounded-2xl border [transform:translateZ(0)]">
              <ToastRegion>{toast && <Toast message={t("addonPreview.toastText")} action={{ label: t("addonPreview.toastAction"), onClick: noop }} onClose={() => setToast(false)} />}</ToastRegion>
              {!toast && (
                <Button variant="outline" size="sm" className="m-3 max-md:h-11" onClick={() => setToast(true)}>
                  {t("addonPreview.toastShow")}
                </Button>
              )}
            </div>
          </Sample>
          <Sample name="addonPreview.palette">
            <div>
              <Button variant="outline" className="max-md:h-11" onClick={() => setPalette(true)} data-testid="addon-preview-palette">
                {t("addonPreview.paletteOpen")}
              </Button>
              {palette && <Palette onClose={() => setPalette(false)} />}
            </div>
          </Sample>
        </Section>
      </main>
    </div>
  );
}
