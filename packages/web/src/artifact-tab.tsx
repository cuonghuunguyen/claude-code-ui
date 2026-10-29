import type { ReactNode } from "react";
import { ArtifactConnectedContext, ArtifactFrame, ArtifactPreviewContext, type ArtifactPreviewLoader } from "./artifact-preview.tsx";

/** The body of an artifact tab (GH-400): the page of `partId` of session `owner`, filling the tab. `load` is bound to the owner by the caller; `onTitle` gets the title of the daemon's reply. */
export function ArtifactTab({ partId, title, load, connected, onTitle }: { partId: string; title: string; load: ArtifactPreviewLoader; connected: boolean; onTitle?: (title: string) => void }): ReactNode {
  return (
    <ArtifactConnectedContext value={connected}>
      <ArtifactPreviewContext value={load}>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <ArtifactFrame partId={partId} title={title} fill onTitle={onTitle} />
        </div>
      </ArtifactPreviewContext>
    </ArtifactConnectedContext>
  );
}
