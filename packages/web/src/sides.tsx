// Sides (docs/spec.md "Sides"): each project and session belongs to this machine, a WSL distro or a Docker container.
import { createContext, use } from "react";
import { LOCAL_SIDE, type DockerState, type SideInfo } from "@claude-ui/protocol";

/**
 * Side label of a cwd (`Windows`, `WSL: Ubuntu`, `Docker: dev`) and its short form for narrow rows (`Win`, `WSL` or the distro
 * name when there are several, `Docker` or the container name when there are several); undefined on a daemon with one side,
 * where no badge shows.
 */
export const SideLabel = createContext<(cwd: string) => { label: string; short: string } | undefined>(() => undefined);

/** The side lookups of a session list: `sides` absent or only local = one side. */
export function sideLookup(sides: SideInfo[] | undefined, cwdSides: Record<string, string> = {}) {
  const many = !!sides && sides.length > 1;
  const sideOf = (cwd: string) => cwdSides[cwd] ?? LOCAL_SIDE;
  const label = (cwd: string) => (many ? sides!.find((s) => s.id === sideOf(cwd))?.label : undefined);
  const count = (prefix: string) => (sides ?? []).filter((s) => s.id.startsWith(prefix)).length;
  const badge = (cwd: string) => {
    const l = label(cwd);
    if (!l) return undefined;
    const side = sideOf(cwd);
    const short =
      side === LOCAL_SIDE ? (l === "Windows" ? "Win" : l) : side.startsWith("docker:") ? (count("docker:") > 1 ? side.slice("docker:".length) : "Docker") : count("wsl:") > 1 ? side.slice("wsl:".length) : "WSL";
    return { label: l, short };
  };
  return { many, sideOf, label, badge };
}

/** `short`: the short form, full label as tooltip, for narrow rows like the sidebar. */
export function SideBadge({ cwd, short = false }: { cwd: string; short?: boolean }) {
  const b = use(SideLabel)(cwd);
  if (!b) return null;
  return (
    <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-px font-normal text-muted-foreground text-xs" title={b.label} aria-label={b.label} data-testid="side-badge">
      {short ? b.short : b.label}
    </span>
  );
}

/** What the sidebar says under a project of a side that is not ready; `action`: Retry (side.start) or Update (side.start with setup needed). */
export type SideStatus = { text: string; action?: "retry" | "update" };
export function sideStatus(side: SideInfo | undefined): SideStatus | undefined {
  if (!side || side.id === LOCAL_SIDE || side.state === "ready") return undefined;
  if (side.state === "starting") return { text: "Starting…" };
  if (side.state === "error") return { text: side.message ?? "Could not start", action: "retry" };
  return side.update ? { text: "Needs an update", action: "update" } : { text: "Not running" };
}

/** The side of a cwd (as SideInfo) and the start action of its status line. */
export const SideState = createContext<{ of: (cwd: string) => SideInfo | undefined; act: (side: string, setup?: "needed") => void }>({ of: () => undefined, act: () => {} });

/** Status line under a project of a side that is not ready (Starting…, the error with Retry, Needs an update with Update). */
export function SideStatusLine({ cwd }: { cwd: string }) {
  const { of, act } = use(SideState);
  const side = of(cwd);
  const st = sideStatus(side);
  if (!side || !st) return null;
  return (
    <p role="status" className="flex items-center gap-2 py-1 pl-7 text-muted-foreground text-xs max-md:min-h-11" data-testid="sidebar-side-status">
      <span className="min-w-0 break-words">{st.text}</span>
      {st.action && (
        <button type="button" onClick={() => act(side.id, st.action === "update" ? "needed" : undefined)} className="h-6 shrink-0 rounded-md border px-2 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="sidebar-side-action">
          {st.action === "update" ? "Update" : "Retry"}
        </button>
      )}
    </p>
  );
}

/** The daemon's own side is Windows: drive-letter paths are local, POSIX paths belong to another side. */
export const localIsWindows = (sides: SideInfo[]) => sides.find((s) => s.id === LOCAL_SIDE)?.label === "Windows";

export { fromMnt, fromWslUnc } from "@claude-ui/protocol";

const SIDE_KEY = "claude-ui.side";
export const loadSide = () => {
  try {
    return localStorage.getItem(SIDE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
export const saveSide = (id: string) => {
  try {
    localStorage.setItem(SIDE_KEY, id);
  } catch {
    // Storage blocked: the picker starts on Windows next time.
  }
};

/** The kinds of side Open project offers: the machine itself, WSL distros, Docker containers. */
export type SideKind = "local" | "wsl" | "docker";
export const sideKind = (id: string): SideKind => (id.startsWith("wsl:") ? "wsl" : id.startsWith("docker:") ? "docker" : "local");
/** Distro or container name: the label without its `WSL: ` / `Docker: ` prefix. */
export const sideName = (s: Pick<SideInfo, "label">) => s.label.replace(/^(?:WSL|Docker): /, "");
/** The kinds that have members, in chooser order: local first. */
export const kindsOf = (sides: SideInfo[], docker?: DockerState): SideKind[] =>
  (["local", "wsl", "docker"] as const).filter((k) => k === "local" || sides.some((s) => sideKind(s.id) === k) || (k === "docker" && !!docker));
/** What the Docker tab says when there is no container to list (the engine is not running, or runs nothing). */
export const DOCKER_HINT: Record<"down" | "empty", string> = {
  down: "Docker is not running. Start Docker, then reopen this dialog.",
  empty: "No running containers. Start one, then reopen this dialog.",
};
/**
 * The side a kind opens on: the remembered one when still listed; for WSL else the first ready distro, else the first; for
 * Docker none (the user picks the container: nothing is set up for an unpicked one).
 */
export function defaultTarget(kind: SideKind, sides: SideInfo[], remembered?: string): SideInfo | undefined {
  const members = sides.filter((s) => sideKind(s.id) === kind);
  const mine = members.find((s) => s.id === remembered);
  if (kind === "local") return members[0];
  return mine ?? (kind === "wsl" ? (members.find((s) => s.state === "ready") ?? members[0]) : undefined);
}

const kindKey = (kind: SideKind) => `${SIDE_KEY}.${kind}`;
/** The last distro or container chosen of a kind. */
export const loadSideFor = (kind: SideKind) => {
  try {
    // First read: the side used before per-kind memory existed.
    const last = localStorage.getItem(SIDE_KEY);
    return localStorage.getItem(kindKey(kind)) ?? (last && sideKind(last) === kind ? last : undefined);
  } catch {
    return undefined;
  }
};
export const saveSideFor = (kind: SideKind, id: string) => {
  try {
    localStorage.setItem(kindKey(kind), id);
  } catch {
    // Storage blocked: the kind opens on its default next time.
  }
};
