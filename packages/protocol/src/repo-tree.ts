import type { GitRepo } from "./wire.ts";

export type RepoNode = GitRepo & { children: RepoNode[] };

/** The selector tree from `git.repos` order: each entry under the entry whose `path` is its `parent`; an entry whose parent is not listed is a root. Keeps list order. */
export function repoTree(repos: GitRepo[]): RepoNode[] {
  const nodes = new Map<string, RepoNode>(repos.map((r) => [r.path, { ...r, children: [] }]));
  const roots: RepoNode[] = [];
  for (const r of repos) {
    const node = nodes.get(r.path)!;
    const parent = r.parent === undefined ? undefined : nodes.get(r.parent);
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  return roots;
}
