// The one place that tells Side kinds apart: the id prefix, the label, the noun in messages, what a kind does on its own.
import type { SideCheck, SidePhase, SideSetup } from "@claude-ui/protocol";
import type { SideProcess, SideTarget } from "./sides.ts";

export type SideKindName = "wsl" | "docker" | "ssh";
const LABEL: Record<SideKindName, string> = { wsl: "WSL", docker: "Docker", ssh: "SSH" };
/** The word for one Side of a kind in messages. */
export const NOUN: Record<SideKindName, "distro" | "container" | "host"> = { wsl: "distro", docker: "container", ssh: "host" };

export const kindOf = (id: string): SideKindName | undefined => {
  const k = id.slice(0, id.indexOf(":"));
  return Object.hasOwn(LABEL, k) ? (k as SideKindName) : undefined;
};
export const nameOf = (id: string) => id.slice(id.indexOf(":") + 1);
export const sideTarget = (kind: SideKindName, name: string): SideTarget => ({ id: `${kind}:${name}`, label: `${LABEL[kind]}: ${name}` });
/** A Side of this kind that reaches `ready` is not started with the Hub until the owner turns "Start with Claude UI" on. */
export const startOptIn = (id: string) => kindOf(id) === "ssh";

export type SpawnArgs = { setup: SideSetup; phase: (p: SidePhase) => void; install?: (i: { bundle: true } | { fallback: string }) => void; pinned?: boolean; bundleOnly?: boolean };
/** What the Hub needs of a kind: start one Side (probe, install, launch) and check it read-only. */
export type SideKindImpl = {
  spawn(name: string, o: SpawnArgs): Promise<SideProcess>;
  check(name: string): Promise<SideCheck>;
};
