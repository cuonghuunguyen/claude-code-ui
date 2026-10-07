// Sides (docs/spec.md "Sides"): each project and session belongs to this machine, a WSL distro or a Docker container.
import { createContext, use } from "react";
import { LOCAL_SIDE, type SideInfo } from "@claude-ui/protocol";

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

/** The daemon's own side is Windows: drive-letter paths are local, POSIX paths belong to another side. */
export const localIsWindows = (sides: SideInfo[]) => sides.find((s) => s.id === LOCAL_SIDE)?.label === "Windows";

/** A Windows path into a WSL distro (`\\wsl$\Ubuntu\home\me`, `\\wsl.localhost\Ubuntu\...`) as that distro's side and POSIX path. */
export function fromWslUnc(input: string): { side: string; path: string } | undefined {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(.*)$/i.exec(input);
  if (!m) return undefined;
  return { side: `wsl:${m[1]}`, path: m[2]!.replace(/\\/g, "/") || "/" };
}

/** A Windows drive seen from WSL (`/mnt/c/Users/me`) as the Windows path (`C:\Users\me`); undefined for other paths. */
export function fromMnt(path: string) {
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path);
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? "").replace(/\/+$/, "").replace(/\//g, "\\")}` : undefined;
}

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
export const kindsOf = (sides: SideInfo[]): SideKind[] => (["local", "wsl", "docker"] as const).filter((k) => k === "local" || sides.some((s) => sideKind(s.id) === k));
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
