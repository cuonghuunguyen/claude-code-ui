import type { GitReposResult } from "@claude-ui/protocol";

/** `git.repos` replies kept for `ttl` ms per key (cwd, git settings, open files); `fresh` loads again and replaces the entry; a rejected load is not kept. */
export function createReposCache({ ttl = 10_000, max = 64, now = Date.now }: { ttl?: number; max?: number; now?: () => number } = {}) {
  const map = new Map<string, { at: number; value: Promise<GitReposResult> }>();
  return {
    get(key: string, load: () => Promise<GitReposResult>, fresh: boolean): Promise<GitReposResult> {
      const have = map.get(key);
      if (have && !fresh && now() - have.at < ttl) return have.value;
      const value = load();
      const entry = { at: now(), value };
      map.delete(key);
      map.set(key, entry);
      value.catch(() => map.get(key) === entry && map.delete(key));
      while (map.size > max) map.delete(map.keys().next().value!);
      return value;
    },
    clear: () => map.clear(),
  };
}
