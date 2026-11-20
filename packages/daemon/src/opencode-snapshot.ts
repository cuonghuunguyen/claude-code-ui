// Local history of OpenCode's edits (docs/spec.md "Local history", ADR 0010 Consequences): the content a step of the agent replaced, read from OpenCode's
// snapshot store. OpenCode keeps a git dir `<data>/snapshot/<projectID>/<sha1 of the worktree path>` and reports, per step, a `patch` part
// `{hash, files}`: `hash` is the tree before the step, `files` the absolute paths the step changed. `git show <hash>:<file>` is the content before the step.
// The layout is OpenCode's internals, not an API: anything missing or unreadable gives no entry, never an error to the user.
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { MAX_BYTES } from "./local-history.ts";
import { runGit, type GitRunner } from "./git-runner.ts";

export type PatchPart = { id?: string; hash?: string; files?: string[] };
export type SnapshotSource = {
  /** OpenCode's data folder. */
  data: () => Promise<string | undefined>;
  /** `projectID` of the session and the `worktree` (git top level) of its folder, from OpenCode. */
  project: (cwd: string, sessionId: string) => Promise<{ projectID: string; worktree: string } | undefined>;
  git?: GitRunner;
  log?: (message: string) => void;
};

/** `[path, content before the step]` for each file of the patch part with a stored blob; files without one (new, ignored, outside the worktree, binary, over the size limit) are left out. */
export async function contentBefore(src: SnapshotSource, cwd: string, sessionId: string, part: PatchPart): Promise<[string, string][]> {
  if (!part.hash || !/^[0-9a-f]{40,64}$/.test(part.hash) || !part.files?.length) return [];
  const log = src.log ?? ((m: string) => console.error(m));
  const git = src.git ?? runGit;
  try {
    const [data, project] = await Promise.all([src.data(), src.project(cwd, sessionId)]);
    if (!data || !project) return [];
    const dir = join(data, "snapshot", project.projectID, createHash("sha1").update(project.worktree).digest("hex"));
    const read = async (args: string[]) => (await git({ cwd: project.worktree, args: ["--git-dir", dir, ...args], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000, killTree: true, maxBuffer: MAX_BYTES })).stdout;
    // Store missing or the tree unknown: the one case worth a log line. A file without a blob below is an ordinary answer.
    await read(["cat-file", "-e", `${part.hash}^{tree}`]);
    const out: [string, string][] = [];
    for (const file of part.files) {
      const rel = relative(project.worktree, file);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const spec = `${part.hash}:${rel.split(sep).join("/")}`;
      // A file the snapshot does not hold (new, gitignored) or over the size limit (`maxBuffer`) fails here: no entry for it.
      const blob = await read(["show", spec]).catch(() => undefined);
      if (blob && !blob.includes(0)) out.push([file, blob.toString("utf8")]);
    }
    return out;
  } catch (e) {
    log(`OpenCode snapshot store not readable, no Local history entry for session ${sessionId}: ${(e as Error).message.split("\n")[0]}`);
    return [];
  }
}
