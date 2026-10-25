import { useEffect, useMemo, useRef, useState } from "react";
import type { GitRepo, GitReposResult } from "@claude-ui/protocol";
import type { connect, RequestError } from "./client.ts";
import { joinPath } from "./paths.ts";
import { resolveRepoChoice } from "./repo-choice.ts";

type Client = ReturnType<typeof connect>;

/** A repository the git panes read: `path` the canonical top for requests, `dir` the same top spelled from the session cwd for row paths. */
export type RepoTarget = { path: string; dir: string };

export { repoDir } from "./paths.ts";

/** The project's default repository: the cwd's own, else the first root the daemon may read. The Graph shows it until it gets the selector. */
export const defaultRepo = (repos: GitRepo[]): GitRepo | undefined => resolveRepoChoice(repos, undefined);

/**
 * `git.repos` of `cwd`. undefined while unknown; null when the daemon cannot answer with a list (an older daemon replies without
 * `repos`, or the request fails); else the list. Asks again when `cwd`, the connection, `seq`, `fresh` or the open files change.
 */
export function useRepos(client: Client | undefined, cwd: string | undefined, o: { connected: boolean; openFiles: string[]; seq: number; fresh: number }): { repos: GitRepo[] | null | undefined; truncated?: GitReposResult["truncated"] } {
  const [state, setState] = useState<{ cwd?: string; repos: GitRepo[] | null; truncated?: GitReposResult["truncated"] }>({ repos: null });
  const filesKey = useMemo(() => [...o.openFiles].sort().join("\0"), [o.openFiles]);
  const lastFresh = useRef(o.fresh);
  useEffect(() => {
    if (!client || !cwd || !o.connected) return;
    let live = true;
    const fresh = o.fresh !== lastFresh.current;
    lastFresh.current = o.fresh;
    const files = filesKey ? filesKey.split("\0").slice(0, 50) : [];
    client.request<GitReposResult>({ type: "git.repos", cwd, ...(files.length && { openFiles: files }), ...(fresh && { fresh: true as const }) }).then(
      (r) => live && setState({ cwd, repos: Array.isArray(r?.repos) ? r.repos : null, ...(r?.truncated && { truncated: r.truncated }) }),
      (e: RequestError) => live && setState({ cwd, repos: e.code === "cwd_not_allowed" ? [] : null }),
    );
    return () => void (live = false);
  }, [client, cwd, o.connected, o.seq, o.fresh, filesKey]);
  return !cwd ? { repos: undefined } : state.cwd === cwd ? { repos: state.repos, truncated: state.truncated } : { repos: undefined };
}
