import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, createBdd } from "playwright-bdd";
import { startDaemon, type Daemon } from "../support/daemon.ts";
import { projectsRoot, runDir, slug, testSlugs } from "../support/paths.ts";

export type Project = { path: string; name: string };

/** Counter shared by the evidence step: names stay unique and sort in capture order. */
export type Evidence = { next(): number };

export const test = base.extend<{ project: Project; evidence: Evidence }, { daemon: Daemon }>({
  // One daemon per worker: free port, own config dir, API key variables unset, Haiku. Stopped by PID tree.
  daemon: [
    async ({}, use, workerInfo) => {
      const daemon = await startDaemon(runDir(), workerInfo.workerIndex);
      await use(daemon);
      await daemon.stop();
    },
    { scope: "worker", timeout: 120_000 },
  ],
  // A scratch project per scenario (and per retry) whose settings make new sessions ask before a write.
  // Nothing here touches the page: a --debug=cli pause lands on the first page call with the daemon up.
  project: async ({ daemon }, use, testInfo) => {
    const { feature, scenario } = testSlugs(testInfo);
    const name = `${slug(`${feature}-${scenario}`, 56)}-r${testInfo.retry}`;
    const path = join(projectsRoot(runDir()), name);
    mkdirSync(join(path, ".claude"), { recursive: true });
    writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }, null, 2));
    void daemon;
    await use({ path, name });
    // A failed scenario keeps the run folder (daemon log, transcripts' project) for the post-mortem.
    if (testInfo.status !== testInfo.expectedStatus) writeFileSync(join(runDir(), "failed.marker"), `${testInfo.title}\n`, { flag: "a" });
  },
  evidence: async ({}, use) => {
    let n = 0;
    await use({ next: () => ++n });
  },
});

export const { Given, When, Then } = createBdd(test);
