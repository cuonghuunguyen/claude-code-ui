import { Fragment } from "react";
import type { SessionInfo } from "@claude-ui/protocol";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineTag } from "./engine-tag.tsx";
import { useT } from "./i18n.ts";
import { usePhone } from "./lib/use-narrow.ts";
import { SideBadge } from "./sides.tsx";
import { ProjectAvatar } from "./tabs-bar.tsx";
import { projectName } from "./tabs.ts";

/** The header row of SessionPane (GH-774): where the session is. No `cwd` yet (the session list is not there): bars of the same size. */
export function SkeletonHeader({ cwd, place, engine }: { cwd?: string; place?: string; engine?: SessionInfo["engine"] }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4" data-testid="session-header">
      {cwd ? (
        <>
          <ProjectAvatar cwd={cwd} />
          <span className="min-w-0 truncate font-medium" title={cwd} data-testid="session-project">
            {place ?? projectName(cwd)}
          </span>
          <SideBadge cwd={cwd} />
          {engine && <EngineTag engine={engine} />}
          <span className="min-w-0 truncate text-muted-foreground" title={cwd}>
            {cwd}
          </span>
        </>
      ) : (
        <>
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-48" />
        </>
      )}
    </header>
  );
}

/** The prompt box placeholder, same wrapper as SessionPane's dock, so the box does not move when the pane replaces it. */
export function SkeletonComposer() {
  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-2 p-4 max-sm:px-2 max-sm:py-2">
      <Skeleton className="h-[104px] w-full rounded-lg" data-testid="prompt-skeleton" />
    </div>
  );
}

/** An existing session whose subscribe reply is on its way (GH-774): SessionPane's layout with placeholders, replaced in place. */
export function SessionSkeleton({ session, place }: { session?: Pick<SessionInfo, "cwd" | "engine">; place?: string }) {
  const tr = useT();
  const phone = usePhone();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="session-skeleton" aria-busy="true">
      {!phone && <SkeletonHeader cwd={session?.cwd} place={place} engine={session?.engine} />}
      <span role="status" className="sr-only">
        {tr("app.main.loading")}
      </span>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-4 py-6 2xl:max-w-[1000px]" data-testid="timeline-skeleton">
          {[0, 1].map((i) => (
            <Fragment key={i}>
              <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      <SkeletonComposer />
    </div>
  );
}
