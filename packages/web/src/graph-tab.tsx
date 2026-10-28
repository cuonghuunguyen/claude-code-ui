import { useState } from "react";
import type { connect } from "./client.ts";
import { GraphPane } from "./git-graph-panel.tsx";
import type { RepoList } from "./repo-choice.ts";
import { useRepos } from "./repos.ts";

type Client = ReturnType<typeof connect>;

/**
 * Git graph as a main-area tab: its own repository list for the owner's folder, so a hidden tab keeps its props (and its loaded list) while another session is current.
 * `repoKey`: the project key of the folder (`repoProjectKey`), undefined until the session list is in; the selected repository is shared with Changes and the dock graph.
 */
export function GraphTab({ client, cwd, hidden, connected, openFiles, seq, repoKey }: { client: Client; cwd: string; hidden: boolean; connected: boolean; openFiles: string[]; seq: number; repoKey?: string }) {
  const [fresh, setFresh] = useState(0);
  const { repos, truncated } = useRepos(client, cwd, { connected, openFiles, seq, fresh });
  const list: RepoList | undefined = repos && repoKey ? { list: repos, truncated, projectKey: repoKey } : undefined;
  return <GraphPane client={client} cwd={cwd} hidden={hidden} repos={repos === null ? null : repos === undefined ? undefined : list} onRefresh={() => setFresh((n) => n + 1)} />;
}
