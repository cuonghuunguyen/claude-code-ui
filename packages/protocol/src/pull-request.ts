// Pasted pull request links in the Create worktree modal (docs/spec.md "Worktrees"): which repository and number a link names,
// the git refs its host publishes for it, and whether a remote URL is that repository.

/** A pull request link: `repo` lower case (`owner/repo`, `group/sub/repo`, Bitbucket Server `project/repo` or `~user/repo`). */
export type PullRequestLink = { host: string; repo: string; number: number; /** Refs on the remote that hold its head; empty: the host publishes none. */ refs: string[] };

const num = (s: string | undefined) => (s && /^\d{1,9}$/.test(s) ? Number(s) : undefined);

/** The pull request a pasted link names: GitHub, GitLab, Bitbucket Server or Data Center, Bitbucket Cloud; undefined for any other text. */
export function pullRequestOf(text: string): PullRequestLink | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  // Bitbucket Server / Data Center, any context path: …/projects/P/repos/R/pull-requests/N or …/users/U/repos/R/pull-requests/N.
  for (let i = 0; i + 5 < parts.length; i++) {
    const n = num(parts[i + 5]);
    if ((parts[i] === "projects" || parts[i] === "users") && parts[i + 2] === "repos" && parts[i + 4] === "pull-requests" && n !== undefined) {
      const owner = parts[i] === "users" ? `~${parts[i + 1]}` : parts[i + 1]!;
      return { host, repo: `${owner}/${parts[i + 3]}`.toLowerCase(), number: n, refs: [`refs/pull-requests/${n}/from`] };
    }
  }
  // GitLab: group/…/repo/-/merge_requests/N.
  const dash = parts.indexOf("-");
  if (dash >= 2 && parts[dash + 1] === "merge_requests") {
    const n = num(parts[dash + 2]);
    if (n !== undefined) return { host, repo: parts.slice(0, dash).join("/").toLowerCase(), number: n, refs: [`refs/merge-requests/${n}/head`] };
  }
  // GitHub: owner/repo/pull/N.
  if (parts.length >= 4 && parts[2] === "pull") {
    const n = num(parts[3]);
    if (n !== undefined) return { host, repo: `${parts[0]}/${parts[1]}`.toLowerCase(), number: n, refs: [`refs/pull/${n}/head`] };
  }
  // Bitbucket Cloud: workspace/repo/pull-requests/N; it publishes no pull request refs.
  if (host === "bitbucket.org" && parts.length >= 4 && parts[2] === "pull-requests") {
    const n = num(parts[3]);
    if (n !== undefined) return { host, repo: `${parts[0]}/${parts[1]}`.toLowerCase(), number: n, refs: [] };
  }
  return undefined;
}

/** Host and repository path (lower case, no `.git`, no Bitbucket `scm/`) of a remote URL: https, ssh:// or scp-like `git@host:path`. */
export function remoteRepoOf(remote: string): { host: string; path: string } | undefined {
  const r = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(r);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(r);
      host = u.hostname;
      path = decodeURIComponent(u.pathname);
    } catch {
      return undefined;
    }
  }
  let segs = path.split("/").filter(Boolean);
  const scm = segs.indexOf("scm");
  if (scm >= 0 && segs.length - scm >= 3) segs = segs.slice(scm + 1);
  const joined = segs.join("/").replace(/\.git$/i, "").toLowerCase();
  return host && joined ? { host: host.toLowerCase(), path: joined } : undefined;
}

/** The remote is the link's repository: same host, and its path is the link's repo (after a context path, if any). */
export function isRemoteOf(link: PullRequestLink, remote: string): boolean {
  const r = remoteRepoOf(remote);
  return !!r && r.host === link.host && (r.path === link.repo || r.path.endsWith(`/${link.repo}`));
}

/** The first Jira-like key a branch name holds as a whole word (`feature/ABC-12-x` → `ABC-12`), upper case. */
export function jiraKeyInBranch(name: string): string | undefined {
  const m = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_]+-[1-9]\d*)(?![0-9.])/.exec(name);
  return m?.[1]!.toUpperCase();
}
