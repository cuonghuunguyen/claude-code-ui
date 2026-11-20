// Area: git requests of the Changes tab, the Git log and the branch and tag dialogs (`git.*`).
// Per-connection state: the running reword, signed tag and commit message generation; `close` aborts them.
import { isAbsolute } from "node:path";
import { MAX_FILE_BYTES, decodeText } from "./text-file.ts";
import type { GitTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Msg, Respond } from "./dispatch.ts";
import { GitRequestError, NOT_TOP, answer, gitRequest, read as gitRead, write as gitWrite } from "./git-request.ts";
import { gitBlame, gitDiff, gitFileAt, gitLog, gitOperationOf, gitRefs, gitShow, isHash } from "./git.ts";
import { gitBranch, gitFetch, gitPull, gitPush, gitTagDelete, gitTagRemote } from "./git-remote.ts";
import { generateCommitMessage, instructionFor, promptFor } from "./commit-message.ts";
import { gitAbort, gitBranchCreate, gitCheckout, gitCommitAction, gitCommitDiff, gitCommitFiles, gitCommitMenu, gitContinue, gitMergeRebase, gitReword, gitRollback, gitRollbackHunk, gitRollbackPreview, gitStash, gitStashList, gitStashPush, gitTag, gitTagCreate, gitTagSigning } from "./git-write.ts";

export type GitAreaContext = Pick<DaemonContext, "git" | "refused" | "statusOf" | "reposOf" | "lastOpen" | "localHistory" | "netSlot" | "appSettings" | "warmCommit" | "accountOf"> & { opts: Pick<DaemonContext["opts"], "query"> };

export function createGitArea(ctx: GitAreaContext): Area<GitTypes> {
  const { git, refused, statusOf, reposOf, lastOpen, localHistory, netSlot, appSettings, warmCommit, accountOf, opts } = ctx;
  /** The running `git.commitMessage` of this connection: stopped by `git.commitMessageCancel`, a newer one, and the close. */
  let generating: AbortController | undefined;
  /** The signed `git.tagCreate` of this connection, aborted by `git.tagCancel` and when the connection closes. */
  let tagging: AbortController | undefined;
  /** The `git.reword` of this connection, aborted by `git.rewordCancel` and when the connection closes. */
  let rewording: AbortController | undefined;

  const status = async (msg: Msg<"git.status">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd) => ({ status: await statusOf(cwd) }))));
  const refs = async (msg: Msg<"git.refs">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ refs: await gitRefs(cwd, inside) }))));
  const repos = async (msg: Msg<"git.repos">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd) => {
      const files = msg.openFiles;
      if (files !== undefined && (!Array.isArray(files) || files.length > 50 || files.some((f) => typeof f !== "string" || f.length > 4096 || f.includes("\0")))) throw new GitRequestError("bad_request", "openFiles must be at most 50 paths");
      const open = (files ?? []).filter((f) => isAbsolute(f) && !refused(f));
      if (lastOpen.size > 64) lastOpen.clear();
      lastOpen.set(cwd, open);
      return await reposOf(cwd, open, msg.fresh === true);
    })));
  const logDiffCommitBlameFileAt = async (msg: Msg<"git.log" | "git.diff" | "git.commit" | "git.blame" | "git.fileAt">, r: Respond) =>
    // No filter text in the log (it may hold a secret).
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => {
      if (msg.type === "git.log") return { log: await gitLog(cwd, { skip: msg.skip, limit: msg.limit, ref: msg.ref, author: msg.author, text: msg.text, fresh: msg.fresh === true, path: msg.path, allowed: inside }) };
      if (msg.type === "git.diff") return { diff: await gitDiff(cwd, { base: msg.base, ref: msg.ref, allowed: inside, ignoreSubmodules: appSettings.get().git.ignoreSubmodules }) };
      if (msg.type === "git.commit") {
        const c = await gitShow(cwd, msg.hash, inside);
        if (!c) throw new GitRequestError("not_git", "Not in a git repository");
        return { commit: c };
      }
      if (msg.type === "git.blame") return { blame: await gitBlame(cwd, msg.path, inside, MAX_FILE_BYTES) };
      const buf = await gitFileAt(cwd, msg.hash, msg.path, inside, MAX_FILE_BYTES);
      const t = decodeText(buf);
      if ("code" in t) throw new GitRequestError(t.code, `${t.code === "binary" ? "binary file" : "not UTF-8 text"}: ${msg.path}`, buf.length);
      return { content: t.content };
    })));
  const fetch = async (msg: Msg<"git.fetch">, r: Respond) =>
    // Output and URLs are never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      if (msg.defaultRemote !== undefined && typeof msg.defaultRemote !== "boolean") throw new GitRequestError("bad_request", "defaultRemote must be a boolean");
      return { remote: await (msg.defaultRemote ? netSlot(() => gitFetch(cwd, { allowed: inside, defaultRemote: true })) : gitFetch(cwd, { allowed: inside })) };
    })));
  const commitFiles = async (msg: Msg<"git.commitFiles">, r: Respond) =>
    // Paths, message and output are never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => ({ committed: await gitCommitFiles(cwd, { paths: msg.paths, message: msg.message, amend: msg.amend, push: msg.push, allowed: inside }) }))));
  const rollback = async (msg: Msg<"git.rollbackPreview" | "git.rollback" | "git.rollbackHunk">, r: Respond) =>
    // Paths and output are never logged.
    answer(r, await gitRequest(git, msg, (msg.type === "git.rollbackPreview" ? gitRead : gitWrite)(async (cwd, inside) => {
      const o = { allowed: inside, snapshot: localHistory.before };
      if (msg.type === "git.rollbackPreview") return { preview: await gitRollbackPreview(cwd, { paths: msg.paths, ...o }) };
      return { rolledBack: await (msg.type === "git.rollback" ? gitRollback(cwd, { paths: msg.paths, token: msg.token, deleteAdded: msg.deleteAdded, ...o }) : gitRollbackHunk(cwd, { path: msg.path, hunk: msg.hunk, maxBytes: MAX_FILE_BYTES, ...o })) };
    })));
  const mergeRebase = async (msg: Msg<"git.merge" | "git.rebase">, r: Respond) =>
    // Output is never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => ({ written: await gitMergeRebase(cwd, msg.type === "git.merge" ? "merge" : "rebase", { ref: msg.ref, local: msg.local, headRef: msg.headRef, headHash: msg.headHash, argv: msg.argv, allowed: inside }) }))));
  const continueAbort = async (msg: Msg<"git.continue" | "git.abort">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => ({ written: await (msg.type === "git.continue" ? gitContinue : gitAbort)(cwd, { kind: msg.kind, allowed: inside, snapshot: localHistory.before }) }))));
  const commitMenu = async (msg: Msg<"git.commitMenu">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ commitMenu: await gitCommitMenu(cwd, { hash: msg.hash, hard: msg.hard, allowed: inside }) }))));
  const commitAction = async (msg: Msg<"git.undoCommit" | "git.revert" | "git.cherryPick" | "git.reset">, r: Respond) =>
    // Output is never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      const action = msg.type === "git.undoCommit" ? "undo" : msg.type === "git.cherryPick" ? "cherryPick" : msg.type === "git.revert" ? "revert" : "reset";
      return { written: await gitCommitAction(cwd, action, { hash: msg.hash, headRef: msg.headRef, headHash: msg.headHash, argv: msg.argv, mode: msg.type === "git.reset" ? msg.mode : undefined, dirty: msg.type === "git.reset" ? msg.dirty : undefined, snapshot: localHistory.before, allowed: inside }) };
    })));
  const reword = async (msg: Msg<"git.reword">, r: Respond) =>
    // Output is never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      const ctl = (rewording = new AbortController());
      try {
        return { written: await gitReword(cwd, { hash: msg.hash, message: msg.message, headRef: msg.headRef, headHash: msg.headHash, argv: msg.argv, signal: ctl.signal, allowed: inside }) };
      } finally {
        if (rewording === ctl) rewording = undefined;
      }
    })));
  const rewordCancel = async (_msg: Msg<"git.rewordCancel">, r: Respond) => {
    rewording?.abort();
    return r.reply({});
  };
  const branchCreateCheckout = async (msg: Msg<"git.branchCreate" | "git.checkout">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      const o = { allowed: inside, snapshot: localHistory.before };
      return { written: await (msg.type === "git.checkout" ? gitCheckout(cwd, { ref: msg.ref, smart: msg.smart, ...o }) : gitBranchCreate(cwd, { name: msg.name, at: msg.at, checkout: msg.checkout, smart: msg.smart, ...o })) };
    })));
  const tagCreateDelete = async (msg: Msg<"git.tagCreate" | "git.tagDelete">, r: Respond) =>
    // Output and URLs are never logged.
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      const o = { allowed: inside };
      const ctl = msg.type === "git.tagCreate" ? (tagging = new AbortController()) : undefined;
      try {
        return { written: await (msg.type === "git.tagCreate" ? gitTagCreate(cwd, { hash: msg.hash, name: msg.name, message: msg.message, sign: msg.sign, argv: msg.argv, signal: ctl!.signal, ...o }) : gitTagDelete(cwd, { name: msg.name, hash: msg.hash, argv: msg.argv, remotes: msg.remotes, ...o })) };
      } finally {
        if (ctl && tagging === ctl) tagging = undefined;
      }
    })));
  const tagCancel = async (_msg: Msg<"git.tagCancel">, r: Respond) => {
    tagging?.abort();
    return r.reply({});
  };
  const tagSigning = async (msg: Msg<"git.tagSigning">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ signing: await gitTagSigning(cwd, { allowed: inside }) }))));
  const tagOrRemote = async (msg: Msg<"git.tag" | "git.tagRemote">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => {
      if (msg.type === "git.tag") return { tag: await gitTag(cwd, { name: msg.name, allowed: inside }) };
      return { remoteTag: await netSlot(() => gitTagRemote(cwd, { name: msg.name, remote: msg.remote, allowed: inside })) };
    })));
  const operation = async (msg: Msg<"git.operation">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ operation: await gitOperationOf(cwd, inside) }))));
  const stashList = async (msg: Msg<"git.stashList">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ stashes: await gitStashList(cwd, { allowed: inside }) }))));
  const stash = async (msg: Msg<"git.stashPush" | "git.stashApply" | "git.stashPop" | "git.stashDrop">, r: Respond) => {
    const VERB = { "git.stashApply": "apply", "git.stashPop": "pop", "git.stashDrop": "drop" } as const;
    // Output is never logged.
    return answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => ({
      written: msg.type === "git.stashPush"
        ? await gitStashPush(cwd, { message: msg.message, includeUntracked: msg.includeUntracked, allowed: inside })
        : await gitStash(cwd, VERB[msg.type], { index: msg.index, hash: msg.hash, allowed: inside, snapshot: localHistory.before }),
    }))));
  };
  const commitMessageCancel = async (_msg: Msg<"git.commitMessageCancel">, r: Respond) => {
    generating?.abort();
    return r.reply({});
  };
  const commitMessage = async (msg: Msg<"git.commitMessage">, r: Respond) => {
    // Before any await or early return: a cancel or a close at any moment aborts this request.
    generating?.abort();
    const ctl = (generating = new AbortController());
    try {
      return answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => {
        // `project` is only a key of the settings map: never a path.
        if (msg.project !== undefined && (typeof msg.project !== "string" || msg.project.length > 4096 || msg.project.includes("\0"))) throw new GitRequestError("bad_request", "project must be a project folder");
        // Paths, diff, instruction and reply are never logged.
        const d = await gitCommitDiff(cwd, { paths: msg.paths, allowed: inside });
        if (!d) throw new GitRequestError("not_git", NOT_TOP);
        const prompt = promptFor(instructionFor(appSettings.get().git, msg.project), d);
        // The Project's Claude account: a diff of a Project with its own account does not go out on the global one. The warm process runs on the global account only.
        const account = accountOf(cwd);
        const message = await generateCommitMessage({ cwd, prompt, signal: ctl.signal, query: opts.query, env: account.env, ...(account.global && appSettings.get().git.commitMessageWarm && { warm: warmCommit }) });
        return { message, ...(d.cut && { truncated: true }) };
      })));
    } finally {
      if (generating === ctl) generating = undefined;
    }
  };
  const branch = async (msg: Msg<"git.branch">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitRead(async (cwd, inside) => ({ branch: await gitBranch(cwd, msg.ref, { allowed: inside }) }))));
  const pushPull = async (msg: Msg<"git.push" | "git.pull">, r: Respond) =>
    answer(r, await gitRequest(git, msg, gitWrite(async (cwd, inside) => {
      if (typeof msg.ref !== "string" || !isHash(msg.local) || !Array.isArray(msg.argv) || !msg.argv.every((a) => typeof a === "string") || (msg.type === "git.push" && msg.lease !== undefined && !isHash(msg.lease))) throw new GitRequestError("bad_request", "ref, local, lease and argv must be a branch, full commit hashes and the shown command");
      // Output and URLs are never logged.
      return { remote: msg.type === "git.push" ? await gitPush(cwd, { ref: msg.ref, local: msg.local, argv: msg.argv, lease: msg.lease, tracking: msg.tracking, allowed: inside }) : await gitPull(cwd, { ref: msg.ref, local: msg.local, argv: msg.argv, tracking: msg.tracking, allowed: inside }) };
    })));

  return {
    handlers: {
      "git.status": status,
      "git.refs": refs,
      "git.repos": repos,
      "git.log": logDiffCommitBlameFileAt,
      "git.diff": logDiffCommitBlameFileAt,
      "git.commit": logDiffCommitBlameFileAt,
      "git.blame": logDiffCommitBlameFileAt,
      "git.fileAt": logDiffCommitBlameFileAt,
      "git.fetch": fetch,
      "git.commitFiles": commitFiles,
      "git.rollbackPreview": rollback,
      "git.rollback": rollback,
      "git.rollbackHunk": rollback,
      "git.merge": mergeRebase,
      "git.rebase": mergeRebase,
      "git.continue": continueAbort,
      "git.abort": continueAbort,
      "git.commitMenu": commitMenu,
      "git.undoCommit": commitAction,
      "git.revert": commitAction,
      "git.cherryPick": commitAction,
      "git.reset": commitAction,
      "git.reword": reword,
      "git.rewordCancel": rewordCancel,
      "git.branchCreate": branchCreateCheckout,
      "git.checkout": branchCreateCheckout,
      "git.tagCreate": tagCreateDelete,
      "git.tagDelete": tagCreateDelete,
      "git.tagCancel": tagCancel,
      "git.tagSigning": tagSigning,
      "git.tag": tagOrRemote,
      "git.tagRemote": tagOrRemote,
      "git.operation": operation,
      "git.stashList": stashList,
      "git.stashPush": stash,
      "git.stashApply": stash,
      "git.stashPop": stash,
      "git.stashDrop": stash,
      "git.commitMessageCancel": commitMessageCancel,
      "git.commitMessage": commitMessage,
      "git.branch": branch,
      "git.push": pushPull,
      "git.pull": pushPull,
    },
    close() {
      generating?.abort();
      tagging?.abort();
      rewording?.abort();
    },
  };
}
