// The app's commands: palette rows and the shortcuts that run them. Only commands that apply right now are listed.
import type { Effort, ModelInfo, PermissionMode, SessionListItem } from "@claude-ui/protocol";
import type { PaletteItem } from "./palette.tsx";
import { KEYS, matchesKey } from "./shortcuts.ts";
import { projectName } from "./tabs.ts";
import { EFFORT_LABEL, MODE_LABEL, effortOptions } from "./toolbar.tsx";

export type CommandContext = {
  tabs: string[];
  activeId?: string;
  sessions: SessionListItem[];
  /** The shown session's settings; undefined on the new-session tab or with no tab. */
  session?: {
    model: string;
    effort: Effort;
    mode: PermissionMode;
    modes: PermissionMode[];
    running: boolean;
    /** User prompts, oldest first: the rewind targets. */
    prompts: { id: string; text: string }[];
  };
  models: ModelInfo[];
  canQuickOpen: boolean;
  newSession: () => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  quickOpen: () => void;
  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  focusPrompt: () => void;
  setModel: (model: string) => void;
  setEffort: (effort: Effort) => void;
  setMode: (mode: PermissionMode) => void;
  rewind: (userMessageId: string) => void;
  stop: () => void;
};

const firstLine = (t: string) => t.trim().split("\n")[0]!.slice(0, 80) || "(image)";

export function appCommands(c: CommandContext): PaletteItem[] {
  const s = c.session;
  const at = c.activeId ? c.tabs.indexOf(c.activeId) : -1;
  const step = (d: number) => c.tabs[(at + d + c.tabs.length) % c.tabs.length]!;
  const efforts = s ? effortOptions(c.models, s.model) : [];
  const cmd = (id: string, title: string, run: () => void, keys?: string): PaletteItem => ({ id, group: "Commands", title, keys, run });
  const page = (id: string, title: string, placeholder: string, items: PaletteItem[], keys?: string): PaletteItem => ({ id, group: "Commands", title, keys, page: { placeholder, items } });
  const items: (PaletteItem | false | undefined)[] = [
    cmd("session.new", "New session", c.newSession, KEYS.newSession),
    c.canQuickOpen && cmd("file.open", "Open file", c.quickOpen, KEYS.quickOpen),
    c.tabs.length > 1 && cmd("tab.next", "Next tab", () => c.selectTab(step(1)), KEYS.nextTab),
    c.tabs.length > 1 && cmd("tab.prev", "Previous tab", () => c.selectTab(step(-1)), KEYS.prevTab),
    at >= 0 && cmd("tab.close", "Close tab", () => c.closeTab(c.activeId!), KEYS.closeTab),
    cmd("sidebar.toggle", "Toggle sidebar", c.toggleSidebar, KEYS.sidebar),
    s && cmd("panel.toggle", "Toggle side panel", c.toggleSidePanel, KEYS.sidePanel),
    s && cmd("prompt.focus", "Focus prompt", c.focusPrompt, KEYS.focusPrompt),
    s &&
      c.models.length > 0 &&
      page(
        "model.choose",
        "Change model",
        "Choose model",
        c.models.map((m) => ({ id: `model:${m.value}`, group: "Models", title: m.displayName, description: m.description, checked: m.value === s.model, run: () => c.setModel(m.value) })),
        KEYS.model,
      ),
    s &&
      efforts.length > 0 &&
      page(
        "effort.choose",
        "Change thinking effort",
        "Choose thinking effort",
        efforts.map((e) => ({ id: `effort:${e}`, group: "Thinking effort", title: EFFORT_LABEL[e], checked: e === s.effort, run: () => c.setEffort(e) })),
      ),
    s &&
      s.modes.length > 0 &&
      page(
        "mode.choose",
        "Change permission mode",
        "Choose permission mode",
        s.modes.map((m) => ({ id: `mode:${m}`, group: "Permission mode", title: MODE_LABEL[m].label, checked: m === s.mode, run: () => c.setMode(m) })),
        // Shown only: Shift+Tab in the prompt box cycles the mode (SessionPane).
        "shift+tab",
      ),
    // The daemon rejects a rewind while a turn runs.
    s &&
      !s.running &&
      s.prompts.length > 0 &&
      page(
        "rewind",
        "Rewind",
        "Rewind to before which message?",
        [...s.prompts].reverse().map((p) => ({ id: `rewind:${p.id}`, group: "Messages, newest first", title: firstLine(p.text), run: () => c.rewind(p.id) })),
      ),
    s?.running && cmd("session.stop", "Stop", c.stop, "escape"),
    ...c.sessions.map((x) => ({
      id: `session:${x.id}`,
      group: "Sessions",
      title: x.title || "Untitled",
      description: projectName(x.cwd),
      checked: x.id === c.activeId,
      run: () => c.selectTab(x.id),
    })),
  ];
  return items.filter((i): i is PaletteItem => !!i);
}

/** The command a key press runs: a page command opens the palette on its page. Esc and Shift+Tab stay with their own handlers. */
export const shortcutFor = (items: PaletteItem[], e: KeyboardEvent) =>
  items.find((i) => i.keys && Object.values(KEYS).includes(i.keys as never) && matchesKey(i.keys, e));

