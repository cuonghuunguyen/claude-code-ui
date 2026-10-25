import { useState } from "react";
import type { connect } from "./client.ts";
import { GraphPanel } from "./git-graph-panel.tsx";
import { defaultRepo, useRepos } from "./repos.ts";

type Client = ReturnType<typeof connect>;

/** Git graph as a main-area tab: its own repository list for the owner's folder, so a hidden tab keeps its props (and its loaded list) while another session is current. */
export function GraphTab({ client, cwd, hidden, connected, openFiles, seq }: { client: Client; cwd: string; hidden: boolean; connected: boolean; openFiles: string[]; seq: number }) {
  const [fresh, setFresh] = useState(0);
  const { repos } = useRepos(client, cwd, { connected, openFiles, seq, fresh });
  if (repos === undefined) return <p className="m-auto text-muted-foreground text-sm">Loading graph…</p>;
  const repo = repos ? defaultRepo(repos) : undefined;
  return <GraphPanel key={repo?.path ?? cwd} hidden={hidden} client={client} cwd={repo?.path ?? cwd} exact={!!repo} onRefresh={() => setFresh((n) => n + 1)} />;
}
