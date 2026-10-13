// `<config>/daemon.json`: where a running daemon listens (docs/spec.md "CLI"). No token. Written when it listens, removed when it exits.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonInfo = { port: number; pid: number; version: string; startedAt: string };

export const daemonFile = (dir: string) => join(dir, "daemon.json");

export const writeDaemonFile = (dir: string, info: DaemonInfo) => writeFileSync(daemonFile(dir), JSON.stringify(info) + "\n", { mode: 0o600 });

/** The file's content; undefined when it is absent or not a daemon.json. */
export function readDaemonFile(dir: string): DaemonInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(daemonFile(dir), "utf8"));
    return Number.isInteger(v?.port) && Number.isInteger(v?.pid) && typeof v.version === "string" && typeof v.startedAt === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file when it is this `pid`'s (a daemon that lost the port race must not delete the running one's). */
export function removeDaemonFile(dir: string, pid: number) {
  if (readDaemonFile(dir)?.pid === pid) rmSync(daemonFile(dir), { force: true });
}
