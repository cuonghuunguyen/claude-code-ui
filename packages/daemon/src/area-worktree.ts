// Area: worktrees of a repository (`worktree.*`): branches, pull requests, Clean up scans, create, status, remove.
// Per-connection state: the Clean up scans; `close` aborts them.
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WorktreeTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Msg, Respond } from "./dispatch.ts";
import { answer, gitFailure } from "./git-request.ts";
import { cachedStatuses, classify, listBranches, lowPriority, pullRequestBranches, worktreeStatus } from "./git.ts";

export type WorktreeAreaContext = Pick<DaemonContext, "allowed" | "inside" | "refused" | "gitOutside" | "claudeDir" | "createIn" | "removeIn" | "isRemoving" | "inDir" | "sessions">;

export function createWorktreeArea(ctx: WorktreeAreaContext): Area<WorktreeTypes> {
  const { allowed, inside, refused, gitOutside, claudeDir, createIn, removeIn, isRemoving, inDir, sessions } = ctx;
  /** Clean up scans (`worktree.status` with `scan`) of this connection: aborted by `worktree.cancel` and when it closes. */
  const scans = new Map<string, AbortController>();

  const branches = async (msg: Msg<"worktree.branches">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (msg.fetch !== undefined && typeof msg.fetch !== "boolean") return r.fail("bad_request", "fetch must be a boolean");
    try {
      return r.reply(await listBranches(cwd, { allowed: inside, claudeDir, fetch: msg.fetch === true }));
    } catch (e) {
      return answer(r, { error: gitFailure(e) });
    }
  };
  const pr = async (msg: Msg<"worktree.pr">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (typeof msg.url !== "string" || msg.url.length > 2000) return r.fail("bad_request", "url must be a string of at most 2000 characters");
    try {
      return r.reply(await pullRequestBranches(cwd, msg.url, { allowed: inside }));
    } catch (e) {
      return answer(r, { error: gitFailure(e) });
    }
  };
  const cancel = async (msg: Msg<"worktree.cancel">, r: Respond) => {
    if (typeof msg.scan !== "string" || !msg.scan || msg.scan.length > 64) return r.fail("bad_request", "scan must be a string of at most 64 characters");
    // The aborted id stays (a request that arrives later is cancelled too), the oldest ones go past 1000.
    const ac = scans.get(msg.scan) ?? new AbortController();
    ac.abort();
    scans.set(msg.scan, ac);
    if (scans.size > 1000) scans.delete(scans.keys().next().value!);
    return r.reply({});
  };
  const cached = async (msg: Msg<"worktree.cached">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (!Array.isArray(msg.paths) || msg.paths.length > 500) return r.fail("bad_request", "paths must be an array of at most 500 paths");
    const paths = msg.paths.filter((p): p is string => typeof p === "string" && !!allowed(p));
    const statuses = await cachedStatuses(paths);
    for (const [p, st] of Object.entries(statuses)) {
      const running = [...sessions.values()].filter((s) => inDir(s.cwd, p) && ["running", "needs_input"].includes(s.info().state)).length;
      statuses[p] = classify({ ...st, running, blocked: st.blocked ?? (isRemoving(p) ? "removing" : running ? "sessions_running" : undefined) });
    }
    return r.reply({ statuses });
  };
  const createStatusRemove = async (msg: Msg<"worktree.create" | "worktree.status" | "worktree.remove">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (msg.type === "worktree.create" && msg.name !== undefined && typeof msg.name !== "string") return r.fail("bad_name", "name must be a string");
    if (msg.type === "worktree.create" && msg.branch !== undefined && typeof msg.branch !== "string") return r.fail("bad_name", "branch must be a string");
    if (msg.type === "worktree.create" && ((msg.base !== undefined && typeof msg.base !== "string") || (msg.checkout !== undefined && typeof msg.checkout !== "string"))) return r.fail("bad_request", "base and checkout must be strings");
    if (msg.type !== "worktree.remove" && (await gitOutside(cwd))) return r.fail("cwd_not_allowed", "The repository is outside the allowed roots");
    // A path that is itself a link is refused before `allowed` resolves it; git.ts checks the path git registers too.
    if (msg.type !== "worktree.create" && typeof msg.path === "string" && isAbsolute(msg.path) && !refused(msg.path) && lstatSync(msg.path, { throwIfNoEntry: false })?.isSymbolicLink()) return r.fail("not_removable", "The worktree path is a symbolic link");
    const path = msg.type === "worktree.create" ? undefined : allowed(msg.path);
    if (msg.type !== "worktree.create" && !path) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
    if (msg.type === "worktree.status" && msg.scan !== undefined && !(typeof msg.scan === "string" && msg.scan && msg.scan.length <= 64)) return r.fail("bad_request", "scan must be a string of at most 64 characters");
    if (msg.type === "worktree.remove") {
      for (const k of ["expectSafe", "deleteBranch"] as const) if (msg[k] !== undefined && typeof msg[k] !== "boolean") return r.fail("bad_request", "expectSafe and deleteBranch must be booleans");
      const x = msg.expect as Record<string, unknown> | undefined;
      if (x !== undefined && !(x && typeof x === "object" && ["uncommitted", "ahead", "ignored"].every((k) => (k === "ignored" && x[k] === undefined) || (Number.isInteger(x[k]) && (x[k] as number) >= 0)))) return r.fail("bad_request", "expect must hold counts uncommitted and ahead, and optionally ignored");
    }
    try {
      if (msg.type === "worktree.create") return r.reply(await createIn(cwd, { name: msg.name || undefined, ...(msg.branch !== undefined && { branch: msg.branch }), ...(msg.base && { base: msg.base }), ...(msg.checkout !== undefined && { checkout: msg.checkout }) }));
      if (msg.type === "worktree.status") {
        // Always a fresh read (never the cache): the cache only feeds `worktree.cached`, which the dialogs show as Checking… until this lands.
        const check = () => worktreeStatus(cwd, msg.path, inside);
        let st: Awaited<ReturnType<typeof worktreeStatus>>;
        if (msg.scan === undefined) st = await check();
        else {
          // The ids are the client's: one per Clean up; requests with the same id share one abort.
          const ac = scans.get(msg.scan) ?? new AbortController();
          scans.set(msg.scan, ac);
          if (ac.signal.aborted) return r.fail("cancelled", "cancelled");
          st = await lowPriority(ac.signal, check);
          if (ac.signal.aborted) return r.fail("cancelled", "cancelled");
        }
        const running = [...sessions.values()].filter((s) => inDir(s.cwd, path!) && ["running", "needs_input"].includes(s.info().state)).length;
        return r.reply(classify({ ...st, running, blocked: st.blocked ?? (isRemoving(path!) ? "removing" : running ? "sessions_running" : undefined) }));
      }
      return r.reply(await removeIn(cwd, msg.path, { expectSafe: msg.expectSafe === true, expect: msg.expect, deleteBranch: msg.deleteBranch === true }));
    } catch (e) {
      return answer(r, { error: gitFailure(e) });
    }
  };

  return {
    handlers: {
      "worktree.branches": branches,
      "worktree.pr": pr,
      "worktree.cancel": cancel,
      "worktree.cached": cached,
      "worktree.create": createStatusRemove,
      "worktree.status": createStatusRemove,
      "worktree.remove": createStatusRemove,
    },
    close() {
      scans.forEach((a) => a.abort());
      scans.clear();
    },
  };
}
