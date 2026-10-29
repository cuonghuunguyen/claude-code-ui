// The artifacts of a session (GH-176): one row per published artifact, derived from the whole-session parts.
import { isArtifactPublish } from "@claude-ui/protocol";
import { wholeParts, type SessionView } from "./store.ts";
import { artifactPreviewable, artifactSummary, claudeUrl } from "./tools.ts";

export type ArtifactRow = { partId: string; title: string; fileName: string; /** Publish time (ms); absent on a transcript without timestamps. */ at?: number; /** The claude.ai page, when the result names it. */ url?: string; /** A local .html file the Artifacts pane can show. */ previewable: boolean };

const baseName = (p: unknown) => (typeof p === "string" ? p.split(/[\\/]/).pop()! : "");

/** Done publishes, newest first; one row per artifact = the newest publish of its key (claude.ai URL of the result, else input.url, else input.file_path, else the part id). */
export function sessionArtifacts(view: SessionView): ArtifactRow[] {
  const parts = wholeParts(view);
  const urls = new Map<string, string>();
  for (const p of parts) if (p.type === "tool_result") urls.set(p.toolUseId, claudeUrl(p.output) ?? "");
  const seen = new Set<string>();
  const rows: ArtifactRow[] = [];
  for (const p of [...parts].reverse()) {
    if (!isArtifactPublish(p)) continue;
    const input = (p.input ?? {}) as { url?: unknown; file_path?: unknown };
    const url = urls.get(p.toolUseId) || undefined;
    const key = url ?? (typeof input.url === "string" && input.url ? input.url : typeof input.file_path === "string" && input.file_path ? input.file_path : p.id);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ partId: p.id, title: artifactSummary("Artifact", p.input) || baseName(input.file_path) || "Artifact", fileName: baseName(input.file_path), at: p.endedAt, url, previewable: artifactPreviewable(p) });
  }
  return rows;
}
