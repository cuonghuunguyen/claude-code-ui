// The result line of a git operation of one repository (Graph: fetch, push, pull; Changes: commit), from the per-repository op store.
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dismissRemoteResult, useRemoteOp } from "./git-remote-ops.ts";
import { useT } from "./i18n.ts";

/** Nothing while the repository has no result. `testId`: `<testId>` on the line, `<testId>-error` on git's error text. */
export function GitOpResult({ cwd, testId = "graph-remote-result", errorId = "graph-remote-error" }: { cwd: string; testId?: string; errorId?: string }) {
  const tr = useT();
  const { result } = useRemoteOp(cwd);
  if (!result) return null;
  return (
    <div className="flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-sm" data-testid={testId}>
      {result.ok ? (
        <div role="status" className="min-w-0 flex-1 text-muted-foreground">
          {result.text}
          {result.output && (
            <details>
              <summary className="cursor-pointer">{tr("files.graph.output")}</summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{result.output}</pre>
            </details>
          )}
        </div>
      ) : (
        <div role="alert" className="min-w-0 flex-1 text-destructive">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs" data-testid={errorId}>
            {result.text}
          </pre>
        </div>
      )}
      <Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label={tr("files.dismiss")} onClick={() => dismissRemoteResult(cwd)}>
        <XIcon />
      </Button>
    </div>
  );
}
