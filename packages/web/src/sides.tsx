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
